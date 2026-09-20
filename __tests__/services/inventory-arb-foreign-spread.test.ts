import { computeForeignSpread } from '../../src/services/inventory-arb/foreign-spread-scanner';

describe('computeForeignSpread', () => {
  it('MEXC가 싸면 buy_mexc → sell_binance', () => {
    const r = computeForeignSpread('BTC', { bid: 100, ask: 100.1 }, { bid: 98, ask: 98.1 });
    expect(r).not.toBeNull();
    expect(r!.buyExchange).toBe('mexc');
    expect(r!.sellExchange).toBe('binance');
    expect(r!.buyPrice).toBe(98.1); // mexc ask
    expect(r!.sellPrice).toBe(100); // binance bid
    expect(r!.spreadBps).toBe(Math.floor((100 / 98.1 - 1) * 10000)); // ~193bps
  });

  it('바이낸스가 싸면 buy_binance → sell_mexc', () => {
    const r = computeForeignSpread('XRP', { bid: 98, ask: 98.1 }, { bid: 100, ask: 100.1 });
    expect(r!.buyExchange).toBe('binance');
    expect(r!.sellExchange).toBe('mexc');
    expect(r!.buyPrice).toBe(98.1);
    expect(r!.sellPrice).toBe(100);
  });

  it('크로스 스프레드 없으면(같은 가격) null', () => {
    expect(computeForeignSpread('ETH', { bid: 100, ask: 100.1 }, { bid: 100, ask: 100.1 })).toBeNull();
  });

  it('한쪽이 5배 이상 벌어지면(티커 오매칭) null', () => {
    expect(computeForeignSpread('X', { bid: 100, ask: 100.1 }, { bid: 1000, ask: 1001 })).toBeNull();
  });

  it('가격이 0 이하이면 null', () => {
    expect(computeForeignSpread('X', { bid: 0, ask: 0 }, { bid: 100, ask: 100.1 })).toBeNull();
  });
});
