import { computeForeignSpread } from '../../src/services/inventory-arb/foreign-spread-scanner';

describe('computeForeignSpread (쌍 일반화: binance/mexc/gateio)', () => {
  it('MEXC가 싸면 buy_mexc → sell_binance', () => {
    const r = computeForeignSpread('BTC', 'binance', { bid: 100, ask: 100.1, bidQty: 5, askQty: 3 }, 'mexc', { bid: 98, ask: 98.1, bidQty: 4, askQty: 2 });
    expect(r).not.toBeNull();
    expect(r!.buyExchange).toBe('mexc');
    expect(r!.sellExchange).toBe('binance');
    expect(r!.buyPrice).toBe(98.1); // mexc ask
    expect(r!.sellPrice).toBe(100); // binance bid
    expect(r!.spreadBps).toBe(Math.floor((100 / 98.1 - 1) * 10000)); // ~193bps
    // 순 스프레드 = spread − (mexc 10 + binance 10)
    expect(r!.netSpreadBps).toBe(r!.spreadBps - 20);
    // 최대 체결량 = min(매수측 mexc askQty=2, 매도측 binance bidQty=5) = 2
    expect(r!.maxExecutableQty).toBe(2);
    expect(r!.maxExecutableUsdt).toBeCloseTo(2 * 98.1, 6);
    // 레거시 호환 필드 (바이낸스↔MEXC 쌍)
    expect(r!.binancePrice).toBeCloseTo(100.05, 6);
    expect(r!.mexcPrice).toBeCloseTo(98.05, 6);
  });

  it('바이낸스가 싸면 buy_binance → sell_mexc', () => {
    const r = computeForeignSpread('XRP', 'binance', { bid: 98, ask: 98.1, bidQty: 7, askQty: 6 }, 'mexc', { bid: 100, ask: 100.1, bidQty: 9, askQty: 8 });
    expect(r!.buyExchange).toBe('binance');
    expect(r!.sellExchange).toBe('mexc');
    expect(r!.buyPrice).toBe(98.1);
    expect(r!.sellPrice).toBe(100);
    expect(r!.maxExecutableQty).toBe(6); // min(binance askQty=6, mexc bidQty=9)
  });

  it('Gate↔MEXC 쌍: gate 수수료 20bps 반영, 수량 없으면 maxExecutable=null', () => {
    // Gate 티커는 수량 미제공(0) — 방향: gate 매수(ask 98.1) → mexc 매도(bid 100)
    const r = computeForeignSpread('ZIL', 'gateio', { bid: 98, ask: 98.1, bidQty: 0, askQty: 0 }, 'mexc', { bid: 100, ask: 100.1, bidQty: 9, askQty: 8 });
    expect(r!.buyExchange).toBe('gateio');
    expect(r!.sellExchange).toBe('mexc');
    // 순 스프레드 = spread − (gate 20 + mexc 10)
    expect(r!.netSpreadBps).toBe(r!.spreadBps - 30);
    expect(r!.maxExecutableQty).toBeNull();
    expect(r!.maxExecutableUsdt).toBeNull();
    // 레거시 필드는 바이낸스↔MEXC 쌍에서만
    expect(r!.binancePrice).toBeUndefined();
  });

  it('Gate↔바이낸스 쌍: 수수료 30bps', () => {
    const r = computeForeignSpread('AI', 'gateio', { bid: 100, ask: 100.1, bidQty: 0, askQty: 0 }, 'binance', { bid: 98, ask: 98.1, bidQty: 7, askQty: 6 });
    expect(r!.buyExchange).toBe('binance');
    expect(r!.sellExchange).toBe('gateio');
    expect(r!.netSpreadBps).toBe(r!.spreadBps - 30);
  });

  it('크로스 스프레드 없으면(같은 가격) null', () => {
    expect(computeForeignSpread('ETH', 'binance', { bid: 100, ask: 100.1, bidQty: 1, askQty: 1 }, 'mexc', { bid: 100, ask: 100.1, bidQty: 1, askQty: 1 })).toBeNull();
  });

  it('한쪽이 5배 이상 벌어지면(티커 오매칭) null', () => {
    expect(computeForeignSpread('X', 'binance', { bid: 100, ask: 100.1, bidQty: 1, askQty: 1 }, 'mexc', { bid: 1000, ask: 1001, bidQty: 1, askQty: 1 })).toBeNull();
  });

  it('가격이 0 이하이면 null', () => {
    expect(computeForeignSpread('X', 'binance', { bid: 0, ask: 0, bidQty: 0, askQty: 0 }, 'mexc', { bid: 100, ask: 100.1, bidQty: 1, askQty: 1 })).toBeNull();
  });
});
