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

describe('rankCandidates', () => {
  it('스프레드 큰 순으로 정렬', () => {
    const mk = (symbol: string, spreadBps: number): InventoryArbCandidate => ({
      symbol, direction: 'buy_bithumb_sell_upbit', buyExchange: 'bithumb', sellExchange: 'upbit',
      spreadBps, buyPrice: 1000, sellPrice: 1010, executableQty: 1, executableKrw: 1000,
      type: 'one_way_drain', sellCoinBalance: 1, buyKrwBalance: 1000,
    });
    const ranked = rankCandidates([mk('A', 30), mk('B', 200), mk('C', 100)]);
    expect(ranked.map((c) => c.symbol)).toEqual(['B', 'C', 'A']);
  });
});
