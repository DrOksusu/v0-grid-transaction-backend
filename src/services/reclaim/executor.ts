import type { ExchangeLeg } from '../exchange-leg';

export interface ReclaimExecInput {
  bithumbLeg: ExchangeLeg;
  upbitLeg: ExchangeLeg;
  symbol: string;
  qty: number;
  bithumbBid: number;   // 빗썸 매도 기준가(최우선 매수호가) — 시장가라 min-order 체크용
  upbitAsk: number;     // 업비트 매수 기준가(최우선 매도호가)
  buyFeeBps?: number;   // 업비트 매수 수수료(bps). 예산 캡 계산용. 기본 5
  maxLossBps?: number;  // 허용 손실 상한(bps, 거래규모 대비). 0=순손익≥0(기본). >0이면 그만큼 손실 허용해 전량 되돌림(net 음수 가능)
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
const BALANCED_REL_TOL = 0.005; // 매도 대비 매수량 상대차 0.5% 이내면 전량 되돌림('체결')으로 간주

/**
 * 매도-먼저(sell-first) 순차 집행 — 한쪽만 체결되는 재고 누적을 원천 차단.
 *
 * 1) 빗썸 매도를 먼저 실행(불확실한 leg). 미체결이면 업비트 매수를 아예 하지 않는다
 *    → "매수만 되고 매도 안 됨"으로 원치 않는 코인 재고가 쌓이던 문제 제거.
 * 2) 실제 팔린 수량만큼만 업비트 매수. 지출 상한 = (매도 순대금 + 허용손실) ÷ (1+매수수수료).
 *    - maxLossBps=0(기본): 지출 ≤ 매도 순대금 → **순손익 ≥ 0 보장**(불리하게 움직여도 손실 없음, 수수료는 코인 감소로).
 *    - maxLossBps>0(임계 음수 설정): 그만큼 손실을 허용해 **전량 되돌림** → 수수료만큼 net이 음수로 찍힘(손실은 상한으로 bounded).
 *
 * 사이징이 최우선호가 물량 이내 + 업비트 최유리 IOC 가격보호라 호가창 walk 슬리피지 최소.
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

  // 2) 팔린 수량만큼만 업비트 매수. 지출 상한 = (매도 순대금 + 허용손실) ÷ (1+매수수수료).
  //    maxLossBps=0이면 매도 순대금 이내(net≥0). >0이면 그만큼 손실 허용해 전량 매수(net 음수 가능, 손실 bounded).
  const buyFeeBps = i.buyFeeBps ?? 5;
  const maxLossBps = Math.max(0, i.maxLossBps ?? 0);
  const spendableKrw = (sell.grossKrw - sell.feeKrw) + (sell.grossKrw * maxLossBps) / 10000;
  const budget = Math.floor(spendableKrw / (1 + buyFeeBps / 10000));
  const buyRes = await i.upbitLeg.buyIoc(i.symbol, sell.filledQty, i.upbitAsk, budget);
  const buy = buyRes ?? { filledQty: 0, grossKrw: 0, feeKrw: 0 };

  const feeKrw = sell.feeKrw + buy.feeKrw;
  const netKrw = sell.grossKrw - buy.grossKrw - feeKrw;
  // 거래소 수량 정밀도(코인별 소수자릿수 반올림)와 수수료 코인차감 때문에 매수량이 매도량과
  // 비트 단위로 똑같을 일은 거의 없다. 절대 일치(EPS)로 보면 사실상 전량 되돌린 건도 전부 '부분'이 됨.
  // → 상대 허용오차 0.5% 이내면 '체결'(전량 되돌림)로 간주. 진짜 부분체결(gap 큰 경우)만 '부분'.
  const relGap = sell.filledQty > EPS ? Math.abs(sell.filledQty - buy.filledQty) / sell.filledQty : 1;
  const balanced = relGap < BALANCED_REL_TOL;
  const status: ReclaimExecResult['status'] =
    buy.filledQty > EPS && balanced ? 'filled' : 'partial'; // 매도는 됐으므로 failed 아님(현금 보유)

  return {
    sellFilled: sell.filledQty, buyFilled: buy.filledQty,
    sellGrossKrw: sell.grossKrw, buyGrossKrw: buy.grossKrw,
    feeKrw, netKrw, status,
    note: `sell ${sell.filledQty}/buy ${buy.filledQty}`,
  };
}
