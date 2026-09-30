import { executeReclaim } from '../../src/services/reclaim/executor';
import type { ExchangeLeg } from '../../src/services/exchange-leg';

function mockLeg(over: Partial<Record<keyof ExchangeLeg, any>>): ExchangeLeg {
  const ni = () => { throw new Error('not impl'); };
  return {
    sellIoc: over.sellIoc ?? (async () => null),
    buyIoc: over.buyIoc ?? (async () => null),
    ...(over.sellLimitIoc ? { sellLimitIoc: over.sellLimitIoc } : {}),
    ...(over.buyLimitIoc ? { buyLimitIoc: over.buyLimitIoc } : {}),
    buyGtc: ni, placeMakerBid: ni, pollOrder: ni, placeMakerAsk: ni, cancelOrder: ni,
  } as ExchangeLeg;
}

describe('executeReclaim (production 경로: 빗썸 sellLimitIoc + 업비트 buyIoc)', () => {
  it('양쪽 완전체결 → filled, netKrw = 매도gross - 매수gross - 수수료', async () => {
    const bithumbLeg = mockLeg({ sellLimitIoc: async () => ({ filledQty: 10, grossKrw: 10100, feeKrw: 4 }) });
    const upbitLeg = mockLeg({ buyIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }) });
    const r = await executeReclaim({ bithumbLeg, upbitLeg, symbol: 'XRP', qty: 10, bithumbBid: 1010, upbitAsk: 1000 });
    expect(r.status).toBe('filled');
    expect(r.netKrw).toBeCloseTo(10100 - 10000 - 9, 6);
  });

  it('빗썸 sellLimitIoc가 있으면 시장가 sellIoc 대신 그것을 사용(가격 보호)', async () => {
    const sellLimitIoc = jest.fn(async () => ({ filledQty: 10, grossKrw: 10100, feeKrw: 4 }));
    const sellIoc = jest.fn(async () => ({ filledQty: 10, grossKrw: 9000, feeKrw: 4 })); // 시장가(슬리피지)면 안 불림
    const bithumbLeg = mockLeg({ sellLimitIoc, sellIoc });
    const upbitLeg = mockLeg({ buyIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }) });
    await executeReclaim({ bithumbLeg, upbitLeg, symbol: 'XRP', qty: 10, bithumbBid: 1010, upbitAsk: 1000 });
    expect(sellLimitIoc).toHaveBeenCalledWith('XRP', 10, 1010);
    expect(sellIoc).not.toHaveBeenCalled();
  });

  it('한쪽만 체결 → partial (flatten 안 함, 남김)', async () => {
    const bithumbLeg = mockLeg({ sellLimitIoc: async () => ({ filledQty: 10, grossKrw: 10100, feeKrw: 4 }) });
    const upbitLeg = mockLeg({ buyIoc: async () => null });   // 업비트 미체결
    const r = await executeReclaim({ bithumbLeg, upbitLeg, symbol: 'XRP', qty: 10, bithumbBid: 1010, upbitAsk: 1000 });
    expect(r.status).toBe('partial');
    expect(r.sellFilled).toBe(10);
    expect(r.buyFilled).toBe(0);
  });

  it('둘 다 미체결 → failed', async () => {
    const r = await executeReclaim({ bithumbLeg: mockLeg({}), upbitLeg: mockLeg({}), symbol: 'X', qty: 1, bithumbBid: 1, upbitAsk: 1 });
    expect(r.status).toBe('failed');
  });
});
