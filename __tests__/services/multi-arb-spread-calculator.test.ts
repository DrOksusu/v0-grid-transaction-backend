import { calculateSpreads } from '../../src/services/multi-arb-spread-calculator';
import { BookMap, MultiArbExchange, KRW_ZONE_EXCHANGES, USDT_ZONE_EXCHANGES } from '../../src/services/multi-arb-types';

function bookMap(entries: Record<string, { ask: number; bid: number }>): BookMap {
  return new Map(Object.entries(entries));
}

describe('calculateSpreads', () => {
  it('KRW권: 매수측 ask ↔ 매도측 bid 실현 스프레드를 계산한다', () => {
    const books: Partial<Record<MultiArbExchange, BookMap>> = {
      upbit: bookMap({ WLD: { ask: 4345, bid: 4340 } }),
      bithumb: bookMap({ WLD: { ask: 4205, bid: 4200 } }),
    };
    const [c] = calculateSpreads('KRW', ['WLD'], books, KRW_ZONE_EXCHANGES);
    expect(c.symbol).toBe('WLD');
    expect(c.currencyZone).toBe('KRW');
    // 빗썸 매수(ask 4205) → 업비트 매도(bid 4340)
    expect(c.buyExchange).toBe('bithumb');
    expect(c.buyPrice).toBe(4205);
    expect(c.askPrice).toBe(4205);
    expect(c.sellExchange).toBe('upbit');
    expect(c.sellPrice).toBe(4340);
    expect(c.bidPrice).toBe(4340);
    expect(c.spreadPct).toBeCloseTo(((4340 - 4205) / 4205) * 100, 6);
  });

  it('USDT권 3거래소: 순서쌍 전수비교로 최대 양수 실현 스프레드를 고른다', () => {
    const books: Partial<Record<MultiArbExchange, BookMap>> = {
      binance: bookMap({ PEPE: { ask: 0.0000101, bid: 0.00001 } }),
      mexc: bookMap({ PEPE: { ask: 0.0000099, bid: 0.0000098 } }),
      gateio: bookMap({ PEPE: { ask: 0.0000106, bid: 0.0000105 } }),
    };
    const [c] = calculateSpreads('USDT', ['PEPE'], books, USDT_ZONE_EXCHANGES);
    expect(c.buyExchange).toBe('mexc');
    expect(c.sellExchange).toBe('gateio');
    expect(c.spreadPct).toBeCloseTo(((0.0000105 - 0.0000099) / 0.0000099) * 100, 6);
  });

  it('한 거래소가 최저ask+최고bid 동시 보유 시 그 거래소 자기쌍은 제외되고 교차쌍이 채택된다', () => {
    // A: ask=100(최저), bid=109(최고) — 자기 자신 매수/매도는 불가(같은 거래소)
    // B: ask=105, bid=101
    // 가능한 교차쌍: buy A(ask100)->sell B(bid101) = 1%, buy B(ask105)->sell A(bid109) = 3.8%
    // min-ask/max-bid 단축이면 buy=A(100), sell=A(109)인데 같은 거래소라 무효 처리될 위험 → 순서쌍 전수비교로 buy B/sell A 채택 확인
    const books: Partial<Record<MultiArbExchange, BookMap>> = {
      upbit: bookMap({ XRP: { ask: 100, bid: 109 } }),
      bithumb: bookMap({ XRP: { ask: 105, bid: 101 } }),
    };
    const [c] = calculateSpreads('KRW', ['XRP'], books, KRW_ZONE_EXCHANGES);
    expect(c.buyExchange).toBe('bithumb');
    expect(c.buyPrice).toBe(105);
    expect(c.sellExchange).toBe('upbit');
    expect(c.sellPrice).toBe(109);
    expect(c.spreadPct).toBeCloseTo(((109 - 105) / 105) * 100, 6);
  });

  it('호가가 1곳뿐인 심볼은 제외한다', () => {
    const books: Partial<Record<MultiArbExchange, BookMap>> = {
      upbit: bookMap({ RARE: { ask: 101, bid: 100 } }),
      bithumb: bookMap({}),
    };
    expect(calculateSpreads('KRW', ['RARE'], books, KRW_ZONE_EXCHANGES)).toEqual([]);
  });

  it('실현 스프레드가 0 이하(양수 아님)인 심볼은 제외한다', () => {
    const books: Partial<Record<MultiArbExchange, BookMap>> = {
      upbit: bookMap({ BTC: { ask: 101, bid: 100 } }),
      bithumb: bookMap({ BTC: { ask: 101, bid: 100 } }),
    };
    expect(calculateSpreads('KRW', ['BTC'], books, KRW_ZONE_EXCHANGES)).toEqual([]);
  });

  it('호가 조회가 실패한 거래소(키 없음)는 건너뛴다', () => {
    const books: Partial<Record<MultiArbExchange, BookMap>> = {
      bithumb: bookMap({ BTC: { ask: 101, bid: 100 } }),
      // upbit 조회 실패 → 키 없음
    };
    expect(calculateSpreads('KRW', ['BTC'], books, KRW_ZONE_EXCHANGES)).toEqual([]);
  });
});
