import { executeArb } from '../../src/services/inventory-arb/executor';
import type { ExchangeLeg } from '../../src/services/exchange-leg';

// 체결 결과를 시나리오로 주입하는 mock ExchangeLeg
function mockLeg(overrides: Partial<Record<keyof ExchangeLeg, any>>): ExchangeLeg {
  const notImpl = () => {
    throw new Error('not implemented in test');
  };
  return {
    sellIoc: overrides.sellIoc ?? (async () => null),
    buyIoc: overrides.buyIoc ?? (async () => null),
    // 지정가 IOC(가격 보호)는 옵션 메서드 — 지정한 경우에만 leg에 존재 (미지원 거래소 시뮬레이션)
    ...(overrides.buyLimitIoc ? { buyLimitIoc: overrides.buyLimitIoc } : {}),
    ...(overrides.sellLimitIoc ? { sellLimitIoc: overrides.sellLimitIoc } : {}),
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
    const sellLeg = mockLeg({ sellIoc: async () => ({ filledQty: 10, grossKrw: 10100, feeKrw: 4 }) });
    const buyLeg = mockLeg({ buyIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }) });
    const r = await executeArb({ buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010, fallbackMode: 'market_flatten' });
    expect(r.kind).toBe('filled');
    if (r.kind === 'filled') expect(r.netKrw).toBeCloseTo(10100 - 10000 - 9, 6);
  });

  it('fee-in-coin으로 buyQty 9.98 (dust 범위) → filled (부분체결 오판 금지)', async () => {
    const sellLeg = mockLeg({ sellIoc: async () => ({ filledQty: 10, grossKrw: 10100, feeKrw: 4 }) });
    const buyLeg = mockLeg({ buyIoc: async () => ({ filledQty: 9.98, grossKrw: 10000, feeKrw: 0 }) });
    // imbalance 0.02 × 1010 = 20.2 KRW < 5000 → dust 수용
    const r = await executeArb({ buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010, fallbackMode: 'market_flatten' });
    expect(r.kind).toBe('filled');
  });

  it('minOrderQuote(USDT 3) 지정: imbalance*price < 3 이면 flatten 없이 filled 수용', async () => {
    // ALEO 시나리오: buy 500, sell 499 (imbalance 1), price 0.017 → 1*0.017 = 0.017 USDT < 3 → dust 수용
    const sellLeg = mockLeg({ sellIoc: async () => ({ filledQty: 499, grossKrw: 9.19, feeKrw: 0.01 }) });
    const buyLeg = mockLeg({ buyIoc: async () => ({ filledQty: 500, grossKrw: 8.72, feeKrw: 0.01 }) });
    const r = await executeArb({ buyLeg, sellLeg, symbol: 'ALEO', qty: 500, buyPrice: 0.01744, sellPrice: 0.01842, fallbackMode: 'market_flatten', minOrderQuote: 3 });
    expect(r.kind).toBe('filled'); // flatten 미발생
  });

  it('minOrderQuote 미전달 시 KRW 기본(5000) 유지 — 같은 imbalance라도 flatten (무회귀)', async () => {
    // imbalance 6 × 1000 = 6000 KRW ≥ 5000 → dust 아님 → flatten 발생
    const sellLeg = mockLeg({ sellIoc: async () => ({ filledQty: 4, grossKrw: 4040, feeKrw: 2 }) });
    const buyLeg = mockLeg({
      buyIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }),
      sellIoc: async () => ({ filledQty: 6, grossKrw: 6000, feeKrw: 2 }),
    });
    const r = await executeArb({ buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010, fallbackMode: 'market_flatten' });
    expect(r.kind).toBe('partial_flattened');
  });

  // flatten/hold 경로: imbalance × price ≥ 5000 KRW 여야 dust 단락을 피함 (imbalance 6 × 1000 = 6000)
  it('net long (buy 10, sell 4) → 초과 6을 buyExchange에서 시장가 매도로 flatten', async () => {
    const sellCalls: any[] = [];
    const sellLeg = mockLeg({ sellIoc: async () => ({ filledQty: 4, grossKrw: 4040, feeKrw: 2 }) });
    const buyLeg = mockLeg({
      buyIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }),
      // buyLeg에서 flatten 매도 발생 — 6개 매도
      sellIoc: async (sym: string, q: number) => {
        sellCalls.push({ sym, q });
        return { filledQty: 6, grossKrw: 6000, feeKrw: 2 };
      },
    });
    const r = await executeArb({ buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010, fallbackMode: 'market_flatten' });
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
      buyIoc: async (sym: string, q: number) => {
        buyCalls.push({ sym, q });
        return { filledQty: 6, grossKrw: 6060, feeKrw: 2 };
      },
    });
    const buyLeg = mockLeg({ buyIoc: async () => ({ filledQty: 4, grossKrw: 4000, feeKrw: 3 }) });
    const r = await executeArb({ buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010, fallbackMode: 'market_flatten' });
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
    const r = await executeArb({ buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010, fallbackMode: 'market_flatten' });
    expect(r.kind).toBe('flatten_failed');
    if (r.kind === 'flatten_failed') expect(r.imbalanceQty).toBeCloseTo(6, 6);
  });

  it('net short flatten 매수가 실패(null)하면 → flatten_failed (터미널)', async () => {
    const sellLeg = mockLeg({
      sellIoc: async () => ({ filledQty: 10, grossKrw: 10100, feeKrw: 4 }),
      buyIoc: async () => null, // flatten 매수 실패
    });
    const buyLeg = mockLeg({ buyIoc: async () => ({ filledQty: 4, grossKrw: 4000, feeKrw: 3 }) });
    const r = await executeArb({ buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010, fallbackMode: 'market_flatten' });
    expect(r.kind).toBe('flatten_failed');
    if (r.kind === 'flatten_failed') expect(r.imbalanceQty).toBeCloseTo(-6, 6);
  });

  it('net long flatten 매도가 throw하면 → flatten_failed (터미널, 예외도 안전 매핑)', async () => {
    const sellLeg = mockLeg({ sellIoc: async () => ({ filledQty: 4, grossKrw: 4040, feeKrw: 2 }) });
    const buyLeg = mockLeg({
      buyIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }),
      sellIoc: async () => {
        throw new Error('exchange 5xx');
      },
    });
    const r = await executeArb({ buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010, fallbackMode: 'market_flatten' });
    expect(r.kind).toBe('flatten_failed');
  });

  it('net short flatten 매수가 throw하면 → flatten_failed (터미널, 예외도 안전 매핑)', async () => {
    const sellLeg = mockLeg({
      sellIoc: async () => ({ filledQty: 10, grossKrw: 10100, feeKrw: 4 }),
      buyIoc: async () => {
        throw new Error('network');
      },
    });
    const buyLeg = mockLeg({ buyIoc: async () => ({ filledQty: 4, grossKrw: 4000, feeKrw: 3 }) });
    const r = await executeArb({ buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010, fallbackMode: 'market_flatten' });
    expect(r.kind).toBe('flatten_failed');
  });

  it('flatten이 목표 미달 체결(6 중 3)하면 → flatten_failed (터미널)', async () => {
    const sellLeg = mockLeg({ sellIoc: async () => ({ filledQty: 4, grossKrw: 4040, feeKrw: 2 }) });
    const buyLeg = mockLeg({
      buyIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }),
      sellIoc: async () => ({ filledQty: 3, grossKrw: 3000, feeKrw: 1 }), // 6 중 3만 체결 (< 99%)
    });
    const r = await executeArb({ buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010, fallbackMode: 'market_flatten' });
    expect(r.kind).toBe('flatten_failed');
  });

  it('flatten이 손실을 실현해도 partial_flattened로 정확히 기록 (netKrw 음수)', async () => {
    // buy 10@1000(gross 10000), sell 4@1010(gross 4040), flatten sell 6을 990/개(gross 5940)에 매도
    // netKrw = 4040 + 5940 - 10000 - fees(9) = -29
    const sellLeg = mockLeg({ sellIoc: async () => ({ filledQty: 4, grossKrw: 4040, feeKrw: 2 }) });
    const buyLeg = mockLeg({
      buyIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }),
      sellIoc: async () => ({ filledQty: 6, grossKrw: 5940, feeKrw: 2 }),
    });
    const r = await executeArb({ buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010, fallbackMode: 'market_flatten' });
    expect(r.kind).toBe('partial_flattened');
    if (r.kind === 'partial_flattened') expect(r.netKrw).toBeCloseTo(4040 + 5940 - 10000 - 9, 6);
  });

  it('한쪽 leg가 throw인데 반대편이 체결되면 → flatten_failed (체결상태 불명, 터미널)', async () => {
    const sellLeg = mockLeg({
      sellIoc: async () => {
        throw new Error('network');
      },
    });
    const buyLeg = mockLeg({ buyIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }) });
    const r = await executeArb({ buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010, fallbackMode: 'market_flatten' });
    expect(r.kind).toBe('flatten_failed');
  });

  it('imbalance가 dust(< 5000 KRW)면 flatten 없이 filled + dust 로그', async () => {
    const sellLeg = mockLeg({ sellIoc: async () => ({ filledQty: 9, grossKrw: 9090, feeKrw: 4 }) });
    const buyLeg = mockLeg({ buyIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }) });
    // imbalance 1 × 1000 = 1000 KRW < 5000 → dust
    const r = await executeArb({ buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010, fallbackMode: 'market_flatten' });
    expect(r.kind).toBe('filled');
    if (r.kind === 'filled') expect(r.note).toContain('dust');
  });

  it('fallback=hold + imbalance면 partial_hold', async () => {
    const sellLeg = mockLeg({ sellIoc: async () => ({ filledQty: 4, grossKrw: 4040, feeKrw: 2 }) });
    const buyLeg = mockLeg({ buyIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }) });
    // imbalance 6 × 1000 = 6000 > 5000 (dust 아님) → hold 모드에서 partial_hold
    const r = await executeArb({ buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010, fallbackMode: 'hold' });
    expect(r.kind).toBe('partial_hold');
  });

  it('양쪽 모두 미체결(null) → failed', async () => {
    const r = await executeArb({
      buyLeg: mockLeg({}),
      sellLeg: mockLeg({}),
      symbol: 'XRP',
      qty: QTY,
      buyPrice: PRICE,
      sellPrice: 1010,
      fallbackMode: 'market_flatten',
    });
    expect(r.kind).toBe('failed');
  });
});

// ── 가격 보호(지정가 IOC) — 2026-09-25 ALEO 슬리피지 손실 재발 방지 ──
describe('executeArb protect (지정가 IOC 가격 보호)', () => {
  const PROTECT = { buyLimitPrice: 1003, sellLimitPrice: 1006.97 };

  it('protect + 지원 leg → buyLimitIoc/sellLimitIoc가 보호 가격으로 호출, 시장가 미호출', async () => {
    const calls: Record<string, any[]> = { buyLimit: [], sellLimit: [], buyMkt: [], sellMkt: [] };
    const sellLeg = mockLeg({
      sellIoc: async (...a: any[]) => { calls.sellMkt.push(a); return { filledQty: 10, grossKrw: 10100, feeKrw: 4 }; },
      sellLimitIoc: async (sym: string, q: number, p: number) => {
        calls.sellLimit.push({ sym, q, p });
        return { filledQty: 10, grossKrw: 10080, feeKrw: 4 };
      },
    });
    const buyLeg = mockLeg({
      buyIoc: async (...a: any[]) => { calls.buyMkt.push(a); return { filledQty: 10, grossKrw: 10000, feeKrw: 5 }; },
      buyLimitIoc: async (sym: string, q: number, p: number) => {
        calls.buyLimit.push({ sym, q, p });
        return { filledQty: 10, grossKrw: 10010, feeKrw: 5 };
      },
    });
    const r = await executeArb({
      buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010,
      fallbackMode: 'market_flatten', protect: PROTECT,
    });
    expect(r.kind).toBe('filled');
    if (r.kind === 'filled') expect(r.netKrw).toBeCloseTo(10080 - 10010 - 9, 6);
    expect(calls.buyLimit).toEqual([{ sym: 'XRP', q: QTY, p: 1003 }]);
    expect(calls.sellLimit).toEqual([{ sym: 'XRP', q: QTY, p: 1006.97 }]);
    expect(calls.buyMkt).toHaveLength(0);
    expect(calls.sellMkt).toHaveLength(0);
  });

  it('protect 지정했지만 leg가 지정가 IOC 미구현 → 기존 시장가 폴백 (KRW권 무회귀)', async () => {
    const mkt: string[] = [];
    const sellLeg = mockLeg({
      sellIoc: async () => { mkt.push('sell'); return { filledQty: 10, grossKrw: 10100, feeKrw: 4 }; },
    });
    const buyLeg = mockLeg({
      buyIoc: async () => { mkt.push('buy'); return { filledQty: 10, grossKrw: 10000, feeKrw: 5 }; },
    });
    const r = await executeArb({
      buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010,
      fallbackMode: 'market_flatten', protect: PROTECT,
    });
    expect(r.kind).toBe('filled');
    expect(mkt.sort()).toEqual(['buy', 'sell']);
  });

  it('가격 이탈로 양쪽 지정가 IOC 미체결(null) → failed (돈 안 나감, 무손실 스킵)', async () => {
    const sellLeg = mockLeg({ sellLimitIoc: async () => null });
    const buyLeg = mockLeg({ buyLimitIoc: async () => null });
    const r = await executeArb({
      buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010,
      fallbackMode: 'market_flatten', protect: PROTECT,
    });
    expect(r.kind).toBe('failed');
  });

  it('protect여도 flatten은 시장가 유지 — net long flatten은 buyLeg.sellIoc(시장가)로 발주', async () => {
    const flattenCalls: any[] = [];
    const sellLimitCalls: any[] = [];
    const sellLeg = mockLeg({
      sellLimitIoc: async () => ({ filledQty: 4, grossKrw: 4040, feeKrw: 2 }),
    });
    const buyLeg = mockLeg({
      buyLimitIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }),
      // flatten 경로 — 시장가 sellIoc여야 함
      sellIoc: async (sym: string, q: number) => { flattenCalls.push({ sym, q }); return { filledQty: 6, grossKrw: 6000, feeKrw: 2 }; },
      sellLimitIoc: async (...a: any[]) => { sellLimitCalls.push(a); return null; },
    });
    const r = await executeArb({
      buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010,
      fallbackMode: 'market_flatten', protect: PROTECT,
    });
    expect(r.kind).toBe('partial_flattened');
    expect(flattenCalls).toHaveLength(1);
    expect(flattenCalls[0].q).toBeCloseTo(6, 6);
    expect(sellLimitCalls).toHaveLength(0); // flatten에 지정가 IOC 사용 금지
  });

  it('protect + 한쪽만 체결(다른쪽 가격 이탈 미체결) → 시장가 flatten으로 정리', async () => {
    // 매도만 체결(10), 매수 0 → net short 10 → sellLeg에서 시장가 되사기
    const buyBackCalls: any[] = [];
    const sellLeg = mockLeg({
      sellLimitIoc: async () => ({ filledQty: 10, grossKrw: 10100, feeKrw: 4 }),
      buyIoc: async (sym: string, q: number, hint: number) => {
        buyBackCalls.push({ sym, q, hint });
        return { filledQty: 10, grossKrw: 10120, feeKrw: 4 };
      },
    });
    const buyLeg = mockLeg({ buyLimitIoc: async () => null });
    const r = await executeArb({
      buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010,
      fallbackMode: 'market_flatten', flattenBuyRefPrice: 1011, protect: PROTECT,
    });
    expect(r.kind).toBe('partial_flattened');
    expect(buyBackCalls).toHaveLength(1);
    expect(buyBackCalls[0].hint).toBeCloseTo(1011 * 1.05, 6); // flatten 예산 = top-of-book ask + 5% 헤드룸
  });
});
