import { detectOpportunity } from '../../src/services/inventory-arb/spread-detector';
import type { BookTop } from '../../src/services/inventory-arb/types';

const book = (bid: number, ask: number, bidQty = 100, askQty = 100): BookTop => ({
  bid, ask, bidQty, askQty,
});

// 다단계 호가 헬퍼: bids 내림차순, asks 오름차순 ([price, qty][])
const depthBook = (bids: [number, number][], asks: [number, number][]): BookTop => ({
  bid: bids[0][0], ask: asks[0][0], bidQty: bids[0][1], askQty: asks[0][1],
  bids: bids.map(([price, qty]) => ({ price, qty })),
  asks: asks.map(([price, qty]) => ({ price, qty })),
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

  it('다단계 depth: 마진 스프레드 양수인 레벨까지 수량 누적 (top-level 상한 초과)', () => {
    // 매수측(업비트 ask): 1000x5, 1002x100 / 매도측(빗썸 bid): 1010x8, 1008x100
    const upbit = depthBook([[990, 100]], [[1000, 5], [1002, 100]]);
    const bithumb = depthBook([[1010, 8], [1008, 100]], [[1015, 100]]);
    const opp = detectOpportunity(upbit, bithumb, 0);
    expect(opp!.direction).toBe('buy_upbit_sell_bithumb');
    // 5(1010/1000) + 3(1010/1002) + 97(1008/1002) = 105 (top-level min(5,8)=5 대비 훨씬 큼)
    expect(opp!.maxQtyByDepth).toBeCloseTo(105, 6);
    expect(opp!.buyPrice).toBe(1002); // 소비한 최고 ask (예산 안전)
    expect(opp!.sellPrice).toBe(1008); // 소비한 최저 bid
    expect(opp!.spreadBps).toBe(100); // 최우선호가 기준 (1010/1000)
  });

  it('다단계 depth: minSpreadBps 미달 레벨에서 누적 중단', () => {
    const upbit = depthBook([[990, 100]], [[1000, 5], [1002, 100]]);
    const bithumb = depthBook([[1010, 8], [1008, 100]], [[1015, 100]]);
    // 임계 70bps: (1010/1000)=100, (1010/1002)=79 통과, (1008/1002)=59 컷 → 5+3=8
    const opp = detectOpportunity(upbit, bithumb, 70);
    expect(opp!.maxQtyByDepth).toBeCloseTo(8, 6);
    expect(opp!.buyPrice).toBe(1002);
    expect(opp!.sellPrice).toBe(1010);
  });
});
