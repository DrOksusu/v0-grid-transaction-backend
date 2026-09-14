import { calculateSpreads } from '../../src/services/multi-arb-spread-calculator';
import { PriceMap, MultiArbExchange, KRW_ZONE_EXCHANGES, USDT_ZONE_EXCHANGES } from '../../src/services/multi-arb-types';

function priceMap(entries: Record<string, number>): PriceMap {
  return new Map(Object.entries(entries));
}

describe('calculateSpreads', () => {
  it('KRW권: 최저 매수 거래소 ↔ 최고 매도 거래소 쌍과 스프레드%를 계산한다', () => {
    const prices: Partial<Record<MultiArbExchange, PriceMap>> = {
      upbit: priceMap({ WLD: 4340 }),
      bithumb: priceMap({ WLD: 4200 }),
    };
    const [c] = calculateSpreads('KRW', ['WLD'], prices, KRW_ZONE_EXCHANGES);
    expect(c.symbol).toBe('WLD');
    expect(c.currencyZone).toBe('KRW');
    expect(c.buyExchange).toBe('bithumb');
    expect(c.buyPrice).toBe(4200);
    expect(c.sellExchange).toBe('upbit');
    expect(c.sellPrice).toBe(4340);
    expect(c.spreadPct).toBeCloseTo(((4340 - 4200) / 4200) * 100, 6); // ≈ 3.33%
  });

  it('USDT권 3거래소: 3곳 중 최저/최고를 고른다', () => {
    const prices: Partial<Record<MultiArbExchange, PriceMap>> = {
      binance: priceMap({ PEPE: 0.00001 }),
      mexc: priceMap({ PEPE: 0.0000098 }),
      gateio: priceMap({ PEPE: 0.0000105 }),
    };
    const [c] = calculateSpreads('USDT', ['PEPE'], prices, USDT_ZONE_EXCHANGES);
    expect(c.buyExchange).toBe('mexc');
    expect(c.sellExchange).toBe('gateio');
    expect(c.spreadPct).toBeCloseTo(((0.0000105 - 0.0000098) / 0.0000098) * 100, 6);
  });

  it('가격이 1곳뿐인 심볼은 제외한다', () => {
    const prices: Partial<Record<MultiArbExchange, PriceMap>> = {
      upbit: priceMap({ RARE: 100 }),
      bithumb: priceMap({}),
    };
    expect(calculateSpreads('KRW', ['RARE'], prices, KRW_ZONE_EXCHANGES)).toEqual([]);
  });

  it('전 거래소 동일 가격(스프레드 0)은 제외한다', () => {
    const prices: Partial<Record<MultiArbExchange, PriceMap>> = {
      upbit: priceMap({ BTC: 100 }),
      bithumb: priceMap({ BTC: 100 }),
    };
    expect(calculateSpreads('KRW', ['BTC'], prices, KRW_ZONE_EXCHANGES)).toEqual([]);
  });

  it('시세 조회가 실패한 거래소(키 없음)는 건너뛴다', () => {
    const prices: Partial<Record<MultiArbExchange, PriceMap>> = {
      bithumb: priceMap({ BTC: 100 }),
      // upbit 조회 실패 → 키 없음
    };
    expect(calculateSpreads('KRW', ['BTC'], prices, KRW_ZONE_EXCHANGES)).toEqual([]);
  });
});
