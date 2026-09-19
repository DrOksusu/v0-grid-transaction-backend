import { executeArb } from '../../src/services/inventory-arb/executor';
import type { ExchangeLeg } from '../../src/services/exchange-leg';

// 체결 결과를 시나리오로 주입하는 mock ExchangeLeg
function mockLeg(overrides: Partial<Record<keyof ExchangeLeg, any>>): ExchangeLeg {
  const notImpl = () => { throw new Error('not implemented in test'); };
  return {
    sellIoc: overrides.sellIoc ?? (async () => null),
    buyIoc: overrides.buyIoc ?? (async () => null),
    buyGtc: notImpl,
    placeMakerBid: notImpl,
    pollOrder: notImpl,
    placeMakerAsk: notImpl,
    cancelOrder: notImpl,
  } as ExchangeLeg;
}

const PRICE = 1000;
const QTY = 10;

describe('executeArb', () => {
  it('양쪽 완전 체결 → filled, netKrw = sell - buy - fee', async () => {
    const sellLeg = mockLeg({
      sellIoc: async () => ({ filledQty: 10, grossKrw: 10100, feeKrw: 4 }), // @1010
    });
    const buyLeg = mockLeg({
      buyIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }), // @1000
    });
    const r = await executeArb({
      buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010,
      fallbackMode: 'market_flatten', buyExchangeCoinBalance: 0, sellExchangeKrwBalance: 0,
    });
    expect(r.kind).toBe('filled');
    if (r.kind === 'filled') {
      expect(r.netKrw).toBeCloseTo(10100 - 10000 - 9, 6);
    }
  });

  it('fee-in-coin으로 buyQty 9.98 (밴드 1% 내) → filled (부분체결 오판 금지)', async () => {
    const sellLeg = mockLeg({ sellIoc: async () => ({ filledQty: 10, grossKrw: 10100, feeKrw: 4 }) });
    const buyLeg = mockLeg({ buyIoc: async () => ({ filledQty: 9.98, grossKrw: 10000, feeKrw: 0 }) });
    const r = await executeArb({
      buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010,
      fallbackMode: 'market_flatten', buyExchangeCoinBalance: 0, sellExchangeKrwBalance: 0,
    });
    expect(r.kind).toBe('filled');
  });

  // 주의: flatten/hold 경로 테스트는 imbalance × price ≥ 5000 KRW 여야 dust 단락을 피한다.
  // (imbalance 6 × 1000 = 6000 > 5000). imbalance가 dust 미만이면 flatten 이전에 filled로 처리됨(별도 dust 테스트 참조).
  it('net long (buy 10, sell 4) → 초과 6을 buyExchange에서 시장가 매도로 flatten', async () => {
    const sellCalls: any[] = [];
    const sellLeg = mockLeg({ sellIoc: async () => ({ filledQty: 4, grossKrw: 4040, feeKrw: 2 }) });
    const buyLeg = mockLeg({
      buyIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }),
      // buyLeg에서 flatten 매도 발생 — 6개 매도
      sellIoc: async (sym: string, q: number) => { sellCalls.push({ sym, q }); return { filledQty: 6, grossKrw: 6000, feeKrw: 2 }; },
    });
    const r = await executeArb({
      buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010,
      fallbackMode: 'market_flatten', buyExchangeCoinBalance: 100, sellExchangeKrwBalance: 0,
    });
    expect(r.kind).toBe('partial_flattened');
    if (r.kind === 'partial_flattened') {
      expect(r.flattenSide).toBe('sell');
      expect(r.flattenQty).toBeCloseTo(6, 6);
    }
    expect(sellCalls[0].q).toBeCloseTo(6, 6);
  });

  it('net short (buy 4, sell 10) → 부족 6을 sellExchange에서 시장가 매수로 flatten', async () => {
    const buyCalls: any[] = [];
    const sellLeg = mockLeg({
      sellIoc: async () => ({ filledQty: 10, grossKrw: 10100, feeKrw: 4 }),
      // sellLeg(=sellExchange)에서 flatten 매수 발생
      buyIoc: async (sym: string, q: number) => { buyCalls.push({ sym, q }); return { filledQty: 6, grossKrw: 6060, feeKrw: 2 }; },
    });
    const buyLeg = mockLeg({ buyIoc: async () => ({ filledQty: 4, grossKrw: 4000, feeKrw: 3 }) });
    const r = await executeArb({
      buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010,
      fallbackMode: 'market_flatten', buyExchangeCoinBalance: 0, sellExchangeKrwBalance: 100000,
    });
    expect(r.kind).toBe('partial_flattened');
    if (r.kind === 'partial_flattened') expect(r.flattenSide).toBe('buy');
    expect(buyCalls[0].q).toBeCloseTo(6, 6);
  });

  it('flatten 주문이 실패(null)하면 → flatten_failed (터미널)', async () => {
    const sellLeg = mockLeg({ sellIoc: async () => ({ filledQty: 4, grossKrw: 4040, feeKrw: 2 }) });
    const buyLeg = mockLeg({
      buyIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }),
      sellIoc: async () => null, // flatten 실패
    });
    const r = await executeArb({
      buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010,
      fallbackMode: 'market_flatten', buyExchangeCoinBalance: 100, sellExchangeKrwBalance: 0,
    });
    expect(r.kind).toBe('flatten_failed');
    if (r.kind === 'flatten_failed') expect(r.imbalanceQty).toBeCloseTo(6, 6);
  });

  it('imbalance가 dust(< 5000 KRW)면 flatten 없이 filled + dust 로그', async () => {
    const sellLeg = mockLeg({ sellIoc: async () => ({ filledQty: 9, grossKrw: 9090, feeKrw: 4 }) });
    const buyLeg = mockLeg({ buyIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }) });
    // imbalance 1 * 1000 = 1000 KRW < 5000 → dust
    const r = await executeArb({
      buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010,
      fallbackMode: 'market_flatten', buyExchangeCoinBalance: 100, sellExchangeKrwBalance: 0,
    });
    expect(r.kind).toBe('filled');
    if (r.kind === 'filled') expect(r.note).toContain('dust');
  });

  it('fallback=hold + imbalance면 partial_hold', async () => {
    const sellLeg = mockLeg({ sellIoc: async () => ({ filledQty: 4, grossKrw: 4040, feeKrw: 2 }) });
    const buyLeg = mockLeg({ buyIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }) });
    // imbalance 6 × 1000 = 6000 > 5000 (dust 아님) → hold 모드에서 partial_hold
    const r = await executeArb({
      buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010,
      fallbackMode: 'hold', buyExchangeCoinBalance: 100, sellExchangeKrwBalance: 0,
    });
    expect(r.kind).toBe('partial_hold');
  });

  it('양쪽 모두 미체결(null) → failed', async () => {
    const r = await executeArb({
      buyLeg: mockLeg({}), sellLeg: mockLeg({}), symbol: 'XRP', qty: QTY,
      buyPrice: PRICE, sellPrice: 1010, fallbackMode: 'market_flatten',
      buyExchangeCoinBalance: 0, sellExchangeKrwBalance: 0,
    });
    expect(r.kind).toBe('failed');
  });
});
