import { findBestOpportunity, computeSpreadBps } from '../../src/services/stablecoin-arb-detector';
import { OrderbookTop } from '../../src/services/upbit-price-manager';

function mkBook(market: string, bid: number, ask: number, size = 100): OrderbookTop {
  return {
    market,
    bid: { price: bid, size },
    ask: { price: ask, size },
    timestamp: Date.now(),
  };
}

describe('computeSpreadBps', () => {
  it('bid_X가 ask_Y보다 높으면 양의 spread (bp 단위 floor)', () => {
    // bid_X=1404, ask_Y=1400 => (1404/1400 - 1) * 10000 ≈ 28.57 → 28bp (floor)
    expect(computeSpreadBps(1404, 1400)).toBe(28);
  });

  it('bid_X가 ask_Y보다 낮으면 음수 spread', () => {
    expect(computeSpreadBps(1398, 1400)).toBeLessThan(0);
  });

  it('둘 다 같으면 0', () => {
    expect(computeSpreadBps(1400, 1400)).toBe(0);
  });

  it('0 또는 음수 가격은 0 반환 (방어)', () => {
    expect(computeSpreadBps(0, 1400)).toBe(0);
    expect(computeSpreadBps(1400, 0)).toBe(0);
    expect(computeSpreadBps(-100, 1400)).toBe(0);
  });
});

describe('findBestOpportunity', () => {
  const coins5 = ['USDT', 'USDC', 'USDS', 'USD1', 'USDE'];

  it('모든 호가가 같으면 기회 없음 → null', () => {
    const books = new Map<string, OrderbookTop>();
    coins5.forEach(c => books.set(`KRW-${c}`, mkBook(`KRW-${c}`, 1400, 1400)));
    expect(findBestOpportunity(books, coins5, 20)).toBeNull();
  });

  it('USDT 비쌈(bid 1410), USDC 쌈(ask 1401) → USDT→USDC 후보', () => {
    const books = new Map<string, OrderbookTop>();
    books.set('KRW-USDT', mkBook('KRW-USDT', 1410, 1411));
    books.set('KRW-USDC', mkBook('KRW-USDC', 1400, 1401));
    ['USDS', 'USD1', 'USDE'].forEach(c => books.set(`KRW-${c}`, mkBook(`KRW-${c}`, 1400, 1401)));
    // bid_USDT(1410) / ask_USDC(1401) - 1 ≈ 0.00642 → 64bp
    const best = findBestOpportunity(books, coins5, 20);
    expect(best).not.toBeNull();
    expect(best!.soldCoin).toBe('USDT');
    expect(best!.boughtCoin).toBe('USDC');
    expect(best!.spreadBps).toBeGreaterThanOrEqual(60);
  });

  it('스프레드가 threshold 미만이면 null', () => {
    const books = new Map<string, OrderbookTop>();
    books.set('KRW-USDT', mkBook('KRW-USDT', 1401, 1402));
    books.set('KRW-USDC', mkBook('KRW-USDC', 1400, 1401));
    ['USDS', 'USD1', 'USDE'].forEach(c => books.set(`KRW-${c}`, mkBook(`KRW-${c}`, 1400, 1401)));
    // bid_USDT=1401, ask_USDC=1401 → 0bp
    expect(findBestOpportunity(books, coins5, 20)).toBeNull();
  });

  it('coinsEnabled에서 빠진 코인은 후보에서 제외', () => {
    const books = new Map<string, OrderbookTop>();
    books.set('KRW-USDT', mkBook('KRW-USDT', 1410, 1411));
    books.set('KRW-USDC', mkBook('KRW-USDC', 1400, 1401));
    books.set('KRW-USDS', mkBook('KRW-USDS', 1400, 1401));
    // USDT 비활성 → USDT→USDC 기회가 있어도 후보 아님
    const best = findBestOpportunity(books, ['USDC', 'USDS'], 20);
    expect(best).toBeNull();
  });

  it('두 기회 중 스프레드 높은 쪽 선택', () => {
    const books = new Map<string, OrderbookTop>();
    // USDT 매도 1420, USDC 매수 1400: 1420/1400 ≈ 143bp
    books.set('KRW-USDT', mkBook('KRW-USDT', 1420, 1421));
    books.set('KRW-USDC', mkBook('KRW-USDC', 1400, 1401));
    // USDS 매도 1415, USD1 매수 1400: 1415/1400 ≈ 107bp (더 작음)
    books.set('KRW-USDS', mkBook('KRW-USDS', 1415, 1416));
    books.set('KRW-USD1', mkBook('KRW-USD1', 1400, 1401));
    books.set('KRW-USDE', mkBook('KRW-USDE', 1400, 1401));
    const best = findBestOpportunity(books, coins5, 20);
    expect(best).not.toBeNull();
    expect(best!.soldCoin).toBe('USDT');
    expect(best!.boughtCoin).toBe('USDC');
  });

  it('호가 누락 마켓은 조용히 스킵', () => {
    const books = new Map<string, OrderbookTop>();
    // USDT만 존재. 다른 마켓 호가 없음.
    books.set('KRW-USDT', mkBook('KRW-USDT', 1410, 1411));
    const best = findBestOpportunity(books, coins5, 20);
    expect(best).toBeNull(); // 상대쪽 마켓이 없어 쌍 못 만듦
  });
});
