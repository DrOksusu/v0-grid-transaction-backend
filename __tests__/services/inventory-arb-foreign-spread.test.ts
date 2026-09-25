import { computeForeignSpread } from '../../src/services/inventory-arb/foreign-spread-scanner';

describe('computeForeignSpread', () => {
  it('MEXC가 싸면 buy_mexc → sell_binance', () => {
    const r = computeForeignSpread('BTC', { bid: 100, ask: 100.1, bidQty: 5, askQty: 3 }, { bid: 98, ask: 98.1, bidQty: 4, askQty: 2 });
    expect(r).not.toBeNull();
    expect(r!.buyExchange).toBe('mexc');
    expect(r!.sellExchange).toBe('binance');
    expect(r!.buyPrice).toBe(98.1); // mexc ask
    expect(r!.sellPrice).toBe(100); // binance bid
    expect(r!.spreadBps).toBe(Math.floor((100 / 98.1 - 1) * 10000)); // ~193bps
    // 최대 체결량 = min(매수측 mexc askQty=2, 매도측 binance bidQty=5) = 2
    expect(r!.maxExecutableQty).toBe(2);
    expect(r!.maxExecutableUsdt).toBeCloseTo(2 * 98.1, 6);
  });

  it('바이낸스가 싸면 buy_binance → sell_mexc', () => {
    const r = computeForeignSpread('XRP', { bid: 98, ask: 98.1, bidQty: 7, askQty: 6 }, { bid: 100, ask: 100.1, bidQty: 9, askQty: 8 });
    expect(r!.buyExchange).toBe('binance');
    expect(r!.sellExchange).toBe('mexc');
    expect(r!.buyPrice).toBe(98.1);
    expect(r!.sellPrice).toBe(100);
    // 최대 체결량 = min(매수측 binance askQty=6, 매도측 mexc bidQty=9) = 6
    expect(r!.maxExecutableQty).toBe(6);
  });

  it('크로스 스프레드 없으면(같은 가격) null', () => {
    expect(computeForeignSpread('ETH', { bid: 100, ask: 100.1, bidQty: 1, askQty: 1 }, { bid: 100, ask: 100.1, bidQty: 1, askQty: 1 })).toBeNull();
  });

  it('한쪽이 5배 이상 벌어지면(티커 오매칭) null', () => {
    expect(computeForeignSpread('X', { bid: 100, ask: 100.1, bidQty: 1, askQty: 1 }, { bid: 1000, ask: 1001, bidQty: 1, askQty: 1 })).toBeNull();
  });

  it('가격이 0 이하이면 null', () => {
    expect(computeForeignSpread('X', { bid: 0, ask: 0, bidQty: 0, askQty: 0 }, { bid: 100, ask: 100.1, bidQty: 1, askQty: 1 })).toBeNull();
  });
});
