import type { ExchangeLeg } from '../exchange-leg';

export interface ReclaimExecInput {
  bithumbLeg: ExchangeLeg;
  upbitLeg: ExchangeLeg;
  symbol: string;
  qty: number;
  bithumbBid: number;   // 빗썸 매도 기준가(최우선 매수호가) — 시장가라 min-order 체크용
  upbitAsk: number;     // 업비트 매수 기준가(최우선 매도호가)
  buyFeeBps?: number;   // 업비트 매수 수수료(bps). 예산 캡으로 순손익≥0 보장. 기본 5
}

export interface ReclaimExecResult {
  sellFilled: number;
  buyFilled: number;
  sellGrossKrw: number;
  buyGrossKrw: number;
  feeKrw: number;
  netKrw: number;
  status: 'filled' | 'partial' | 'failed';
  note: string;
}

const EPS = 1e-8;

/**
 * 매도-먼저(sell-first) 순차 집행 — 한쪽만 체결되는 재고 누적을 원천 차단.
 *
 * 1) 빗썸 매도를 먼저 실행(불확실한 leg). 미체결이면 업비트 매수를 아예 하지 않는다
 *    → "매수만 되고 매도 안 됨"으로 원치 않는 코인 재고가 쌓이던 문제 제거.
 * 2) 실제 팔린 수량만큼만 업비트 매수. 지출 상한 = 매도 순대금 ÷ (1+매수수수료)
 *    → 받은 돈보다 더 쓰지 않으므로 **순손익 ≥ 0 보장**(가격이 불리하게 움직여도 손실 없음).
 *
 * 최악의 경우도 "빗썸만 팔고 업비트는 덜 삼 = 현금 보유, 손실 0"으로 끝난다.
 * 사이징이 최우선호가 물량 이내라 시장가 매도의 호가창 walk도 최소.
 */
export async function executeReclaim(i: ReclaimExecInput): Promise<ReclaimExecResult> {
  // 1) 빗썸 매도 먼저
  const sellRes = await i.bithumbLeg.sellIoc(i.symbol, i.qty, i.bithumbBid);
  const sell = sellRes ?? { filledQty: 0, grossKrw: 0, feeKrw: 0 };

  // 매도 미체결 → 업비트 매수 스킵 (한쪽 재고/손실 원천 차단)
  if (!(sell.filledQty > EPS)) {
    return {
      sellFilled: 0, buyFilled: 0, sellGrossKrw: 0, buyGrossKrw: 0,
      feeKrw: sell.feeKrw, netKrw: 0, status: 'failed',
      note: '빗썸 매도 미체결 — 업비트 매수 스킵',
    };
  }

  // 2) 팔린 수량만큼만 업비트 매수, 지출 상한으로 순손익≥0 보장
  const buyFeeBps = i.buyFeeBps ?? 5;
  const budget = Math.floor((sell.grossKrw - sell.feeKrw) / (1 + buyFeeBps / 10000));
  const buyRes = await i.upbitLeg.buyIoc(i.symbol, sell.filledQty, i.upbitAsk, budget);
  const buy = buyRes ?? { filledQty: 0, grossKrw: 0, feeKrw: 0 };

  const feeKrw = sell.feeKrw + buy.feeKrw;
  const netKrw = sell.grossKrw - buy.grossKrw - feeKrw;
  const balanced = Math.abs(sell.filledQty - buy.filledQty) < EPS;
  const status: ReclaimExecResult['status'] =
    buy.filledQty > EPS && balanced ? 'filled' : 'partial'; // 매도는 됐으므로 failed 아님(현금 보유)

  return {
    sellFilled: sell.filledQty, buyFilled: buy.filledQty,
    sellGrossKrw: sell.grossKrw, buyGrossKrw: buy.grossKrw,
    feeKrw, netKrw, status,
    note: `sell ${sell.filledQty}/buy ${buy.filledQty}`,
  };
}
