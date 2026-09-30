import type { ExchangeLeg } from '../exchange-leg';

export interface ReclaimExecInput {
  bithumbLeg: ExchangeLeg;
  upbitLeg: ExchangeLeg;
  symbol: string;
  qty: number;
  bithumbBid: number;   // 빗썸 매도 지정가(최우선 매수호가)
  upbitAsk: number;     // 업비트 매수 지정가(최우선 매도호가)
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
 * 빗썸 매도 + 업비트 매수를 동시 발주. 빗썸은 sellLimitIoc(지정가, 가격 보호) 우선,
 * 업비트는 buyIoc(최유리 best IOC, 이미 가격 보호). 둘 다 호가창을 walk하지 않아 슬리피지 최소.
 * 부분체결(한쪽만/부분)이어도 flatten하지 않고 체결된 만큼만 기록(남기기).
 */
export async function executeReclaim(i: ReclaimExecInput): Promise<ReclaimExecResult> {
  const sellFire = i.bithumbLeg.sellLimitIoc
    ? i.bithumbLeg.sellLimitIoc(i.symbol, i.qty, i.bithumbBid)
    : i.bithumbLeg.sellIoc(i.symbol, i.qty, i.bithumbBid);
  const buyFire = i.upbitLeg.buyLimitIoc
    ? i.upbitLeg.buyLimitIoc(i.symbol, i.qty, i.upbitAsk)
    : i.upbitLeg.buyIoc(i.symbol, i.qty, i.upbitAsk, undefined);

  const [s, b] = await Promise.allSettled([sellFire, buyFire]);
  const sell = s.status === 'fulfilled' && s.value ? s.value : { filledQty: 0, grossKrw: 0, feeKrw: 0 };
  const buy = b.status === 'fulfilled' && b.value ? b.value : { filledQty: 0, grossKrw: 0, feeKrw: 0 };

  const feeKrw = sell.feeKrw + buy.feeKrw;
  const netKrw = sell.grossKrw - buy.grossKrw - feeKrw;
  const both = sell.filledQty > EPS && buy.filledQty > EPS;
  const balanced = Math.abs(sell.filledQty - buy.filledQty) < EPS;
  const status: ReclaimExecResult['status'] =
    both && balanced ? 'filled'
    : (sell.filledQty > EPS || buy.filledQty > EPS) ? 'partial'
    : 'failed';

  return {
    sellFilled: sell.filledQty, buyFilled: buy.filledQty,
    sellGrossKrw: sell.grossKrw, buyGrossKrw: buy.grossKrw,
    feeKrw, netKrw, status,
    note: `sell ${sell.filledQty}/buy ${buy.filledQty}`,
  };
}
