import { executeReclaim } from '../../src/services/reclaim/executor';
import type { ExchangeLeg } from '../../src/services/exchange-leg';

function mockLeg(over: Partial<Record<keyof ExchangeLeg, any>>): ExchangeLeg {
  const ni = () => { throw new Error('not impl'); };
  return {
    sellIoc: over.sellIoc ?? (async () => null),
    buyIoc: over.buyIoc ?? (async () => null),
    buyGtc: ni, placeMakerBid: ni, pollOrder: ni, placeMakerAsk: ni, cancelOrder: ni,
  } as ExchangeLeg;
}

describe('executeReclaim (sell-first + 예산캡)', () => {
  it('매도 체결 후 매수 체결 → filled, net = 매도 - 매수 - 수수료', async () => {
    const bithumbLeg = mockLeg({ sellIoc: async () => ({ filledQty: 10, grossKrw: 10100, feeKrw: 4 }) });
    const upbitLeg = mockLeg({ buyIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }) });
    const r = await executeReclaim({ bithumbLeg, upbitLeg, symbol: 'XRP', qty: 10, bithumbBid: 1010, upbitAsk: 1000 });
    expect(r.status).toBe('filled');
    expect(r.netKrw).toBeCloseTo(10100 - 10000 - 9, 6);
  });

  it('빗썸 매도 미체결 → 업비트 매수 호출 안 함, failed (재고/손실 차단)', async () => {
    const buyIoc = jest.fn(async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }));
    const bithumbLeg = mockLeg({ sellIoc: async () => null });
    const upbitLeg = mockLeg({ buyIoc });
    const r = await executeReclaim({ bithumbLeg, upbitLeg, symbol: 'X', qty: 10, bithumbBid: 1010, upbitAsk: 1000 });
    expect(r.status).toBe('failed');
    expect(r.sellFilled).toBe(0);
    expect(r.buyFilled).toBe(0);
    expect(buyIoc).not.toHaveBeenCalled(); // 핵심: 매도 실패 시 매수 안 함
  });

  it('업비트 매수에 예산 상한(매도 순대금 이내) 전달', async () => {
    const bithumbLeg = mockLeg({ sellIoc: async () => ({ filledQty: 10, grossKrw: 10100, feeKrw: 4 }) });
    const buyIoc = jest.fn(async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }));
    const upbitLeg = mockLeg({ buyIoc });
    await executeReclaim({ bithumbLeg, upbitLeg, symbol: 'XRP', qty: 10, bithumbBid: 1010, upbitAsk: 1000, buyFeeBps: 5 });
    const [sym, qty, price, budget] = buyIoc.mock.calls[0] as unknown as [string, number, number, number];
    expect(sym).toBe('XRP');
    expect(qty).toBe(10);
    expect(price).toBe(1000);
    expect(budget).toBeLessThanOrEqual(10100 - 4); // 매도 순대금 이내
    expect(budget).toBeGreaterThan(10000);
  });

  it('매수가 예산캡으로 부분 체결 → partial, 순손익 ≥ 0 (현금 보유, 손실 없음)', async () => {
    const bithumbLeg = mockLeg({ sellIoc: async () => ({ filledQty: 10, grossKrw: 10100, feeKrw: 4 }) });
    const upbitLeg = mockLeg({ buyIoc: async () => ({ filledQty: 8, grossKrw: 8000, feeKrw: 4 }) });
    const r = await executeReclaim({ bithumbLeg, upbitLeg, symbol: 'XRP', qty: 10, bithumbBid: 1010, upbitAsk: 1000 });
    expect(r.status).toBe('partial');
    expect(r.netKrw).toBeGreaterThanOrEqual(0);
  });

  it('매도만 되고 업비트 매수 완전 실패 → partial, 순손익 ≥ 0', async () => {
    const bithumbLeg = mockLeg({ sellIoc: async () => ({ filledQty: 10, grossKrw: 10100, feeKrw: 4 }) });
    const upbitLeg = mockLeg({ buyIoc: async () => null });
    const r = await executeReclaim({ bithumbLeg, upbitLeg, symbol: 'XRP', qty: 10, bithumbBid: 1010, upbitAsk: 1000 });
    expect(r.status).toBe('partial');
    expect(r.sellFilled).toBe(10);
    expect(r.buyFilled).toBe(0);
    expect(r.netKrw).toBeGreaterThanOrEqual(0); // 매도 대금만 받고 안 씀 → 손실 아님
  });
});
