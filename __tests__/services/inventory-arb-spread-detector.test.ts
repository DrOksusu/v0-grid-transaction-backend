import { detectOpportunity } from '../../src/services/inventory-arb/spread-detector';
import type { BookTop } from '../../src/services/inventory-arb/types';

const book = (bid: number, ask: number, bidQty = 100, askQty = 100): BookTop => ({
  bid, ask, bidQty, askQty,
});

describe('detectOpportunity', () => {
  it('빗썸 bid > 업비트 ask 이면 buy_upbit_sell_bithumb 반환', () => {
    const upbit = book(999, 1000, 50, 40); // 업비트에서 1000에 매수
    const bithumb = book(1010, 1011, 30, 20); // 빗썸에서 1010에 매도
    const opp = detectOpportunity(upbit, bithumb);
    expect(opp).not.toBeNull();
    expect(opp!.direction).toBe('buy_upbit_sell_bithumb');
    expect(opp!.buyPrice).toBe(1000); // 업비트 ask
    expect(opp!.sellPrice).toBe(1010); // 빗썸 bid
    expect(opp!.spreadBps).toBe(Math.floor((1010 / 1000 - 1) * 10000)); // 100bp
    expect(opp!.maxQtyByDepth).toBe(30); // min(업비트 askQty=40, 빗썸 bidQty=30)
  });

  it('업비트 bid > 빗썸 ask 이면 buy_bithumb_sell_upbit 반환', () => {
    const upbit = book(1010, 1011, 30, 20);
    const bithumb = book(999, 1000, 50, 40);
    const opp = detectOpportunity(upbit, bithumb);
    expect(opp!.direction).toBe('buy_bithumb_sell_upbit');
    expect(opp!.buyPrice).toBe(1000); // 빗썸 ask
    expect(opp!.sellPrice).toBe(1010); // 업비트 bid
    expect(opp!.maxQtyByDepth).toBe(30); // min(빗썸 askQty=40, 업비트 bidQty=30)
  });

  it('크로스 스프레드 없으면(양쪽 정상) null', () => {
    const upbit = book(999, 1001, 50, 50);
    const bithumb = book(999, 1001, 50, 50);
    expect(detectOpportunity(upbit, bithumb)).toBeNull();
  });

  it('호가가 0 이하이면 null', () => {
    expect(detectOpportunity(book(0, 0), book(1010, 1011))).toBeNull();
  });
});
