import { buildCandidate, rankCandidates } from '../../src/services/inventory-arb/candidate-scanner';
import type { BookTop, InventoryArbCandidate } from '../../src/services/inventory-arb/types';

const book = (bid: number, ask: number, bidQty = 100, askQty = 100): BookTop => ({ bid, ask, bidQty, askQty });

describe('buildCandidate', () => {
  it('EGLD형 단방향 드레인: 매도측 코인 + 매수측 KRW만 있어도 후보', () => {
    // 업비트 고평가(6945) / 빗썸 저평가(6810). 업비트에만 EGLD 보유, 빗썸엔 KRW만.
    const upbit = book(6945, 6950);
    const bithumb = book(6755, 6810);
    const c = buildCandidate('EGLD', upbit, bithumb, { upbitCoin: 2.13, upbitKrw: 500000, bithumbCoin: 0, bithumbKrw: 797203 }, 30);
    expect(c).not.toBeNull();
    expect(c!.direction).toBe('buy_bithumb_sell_upbit'); // 빗썸 매수 → 업비트 매도
    expect(c!.type).toBe('one_way_drain');
    expect(c!.spreadBps).toBe(198); // floor((6945/6810-1)*10000)
    expect(c!.executableQty).toBeCloseTo(2.13, 2); // 보유 EGLD가 상한
    expect(c!.sellCoinBalance).toBe(2.13);
  });

  it('양쪽 코인 보유 시 bidirectional', () => {
    const upbit = book(1010, 1011);
    const bithumb = book(999, 1000);
    const c = buildCandidate('XRP', upbit, bithumb, { upbitCoin: 50, upbitKrw: 100000, bithumbCoin: 50, bithumbKrw: 100000 }, 30);
    expect(c!.type).toBe('bidirectional');
    expect(c!.spreadBps).toBe(100);
    expect(c!.executableQty).toBeCloseTo(50, 6);
  });

  it('매도측 코인이 없으면 후보 아님(null)', () => {
    const upbit = book(1010, 1011); // 매도측
    const bithumb = book(999, 1000);
    const c = buildCandidate('XRP', upbit, bithumb, { upbitCoin: 0, upbitKrw: 100000, bithumbCoin: 0, bithumbKrw: 100000 }, 30);
    expect(c).toBeNull();
  });

  it('스프레드가 임계 미만이면 null', () => {
    const upbit = book(1001, 1002); // 업비트 bid 1001 > 빗썸 ask 1000 = 10bps
    const bithumb = book(999, 1000);
    const c = buildCandidate('XRP', upbit, bithumb, { upbitCoin: 50, upbitKrw: 100000, bithumbCoin: 50, bithumbKrw: 100000 }, 30);
    expect(c).toBeNull();
  });

  it('체결가능액이 최소주문(5000) 미만이면 null', () => {
    const upbit = book(1010, 1011);
    const bithumb = book(999, 1000);
    // 매도측(업비트) 코인 3개 × 매수가 1000 = 3000 < 5000
    const c = buildCandidate('XRP', upbit, bithumb, { upbitCoin: 3, upbitKrw: 100000, bithumbCoin: 0, bithumbKrw: 100000 }, 30);
    expect(c).toBeNull();
  });
});

describe('buildCandidate 순이익', () => {
  it('예상 순이익 = gross − 양쪽 수수료 (업비트5·빗썸5bps)', () => {
    // buy_upbit_sell_bithumb: 업비트 1000 매수, 빗썸 1010 매도, 10개
    const upbit = book(999, 1000, 100, 100);
    const bithumb = book(1010, 1011, 100, 100);
    const c = buildCandidate('XRP', upbit, bithumb, { upbitCoin: 100, upbitKrw: 1e7, bithumbCoin: 100, bithumbKrw: 1e7 }, 30)!;
    // 규모 = min(depth100, 1e7/1000=1e4, 재고100, 1e7/(1000*1.0005)) = 100
    expect(c.executableQty).toBeCloseTo(100, 6);
    expect(c.estimatedGrossKrw).toBe(1000); // 100 × (1010−1000)
    // fee = 100*1000*5/1e4 + 100*1010*5/1e4 = 50 + 50.5 = 100.5
    expect(c.estimatedFeeKrw).toBe(Math.round(100.5));
    expect(c.estimatedNetKrw).toBe(Math.round(1000 - 100.5)); // 900
    expect(c.netProfitable).toBe(true);
    expect(c.realizable).toBe(true);
  });

  it('스프레드가 수수료보다 작으면 netProfitable=false', () => {
    // 업비트 bid 1001 > 빗썸 ask 1000 = 10bps < 왕복 수수료 ~10bps → net ≤ 0
    const upbit = book(1001, 1002, 100, 100);
    const bithumb = book(999, 1000, 100, 100);
    const c = buildCandidate('XRP', upbit, bithumb, { upbitCoin: 100, upbitKrw: 1e7, bithumbCoin: 100, bithumbKrw: 1e7 }, 5)!;
    expect(c.spreadBps).toBeLessThan(30); // ~10bps
    expect(c.netProfitable).toBe(false); // gross(~10bps) ≤ fee(~10bps 왕복)
  });
});

describe('rankCandidates', () => {
  it('추정 순이익 큰 순으로 정렬', () => {
    const mk = (symbol: string, netKrw: number): InventoryArbCandidate => ({
      symbol, direction: 'buy_bithumb_sell_upbit', buyExchange: 'bithumb', sellExchange: 'upbit',
      spreadBps: 100, buyPrice: 1000, sellPrice: 1010, executableQty: 1, executableKrw: 1000,
      type: 'one_way_drain', sellCoinBalance: 1, buyKrwBalance: 1000,
      estimatedGrossKrw: netKrw + 10, estimatedFeeKrw: 10, estimatedNetKrw: netKrw,
      netProfitable: netKrw > 0, realizable: true,
    });
    const ranked = rankCandidates([mk('A', 300), mk('B', 2000), mk('C', 1000)]);
    expect(ranked.map((c) => c.symbol)).toEqual(['B', 'C', 'A']);
  });
});
