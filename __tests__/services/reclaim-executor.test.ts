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

  it('maxLossBps>0: 손실 허용 → 예산 확대(매도 순대금 초과) + net 음수 가능 + 전량 매수', async () => {
    // 0 스프레드: 빗썸 매도 10000(fee4), 업비트 전량 매수 10005(fee5) → net = 10000-10005-9 = -14
    const bithumbLeg = mockLeg({ sellIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 4 }) });
    const buyIoc = jest.fn(async () => ({ filledQty: 10, grossKrw: 10005, feeKrw: 5 }));
    const upbitLeg = mockLeg({ buyIoc });
    const r = await executeReclaim({ bithumbLeg, upbitLeg, symbol: 'XRP', qty: 10, bithumbBid: 1000, upbitAsk: 1000, buyFeeBps: 5, maxLossBps: 10 });
    const [, , , budget] = buyIoc.mock.calls[0] as unknown as [string, number, number, number];
    expect(budget).toBeGreaterThan(10000 - 4); // 손실 허용분만큼 예산이 매도 순대금보다 큼
    expect(r.netKrw).toBeLessThan(0);           // 수수료만큼 net 음수
    expect(r.status).toBe('filled');            // 전량 매수 → balanced
  });

  it('반올림/수수료로 매수량이 미세하게 적어도(0.5% 이내) filled로 표시', async () => {
    // 거래소 정밀도·수수료 코인차감으로 buy(9.99)가 sell(10)보다 0.1% 적음 → 전량 되돌림으로 간주
    const bithumbLeg = mockLeg({ sellIoc: async () => ({ filledQty: 10, grossKrw: 10100, feeKrw: 4 }) });
    const upbitLeg = mockLeg({ buyIoc: async () => ({ filledQty: 9.99, grossKrw: 10000, feeKrw: 5 }) });
    const r = await executeReclaim({ bithumbLeg, upbitLeg, symbol: 'XRP', qty: 10, bithumbBid: 1010, upbitAsk: 1000 });
    expect(r.status).toBe('filled'); // 0.1% < 0.5% 허용오차
  });

  it('진짜 부분체결(0.5% 초과 차이)은 partial 유지', async () => {
    // buy(9.9)가 sell(10)보다 1% 적음 → 호가 얇아 덜 체결된 진짜 부분 → partial
    const bithumbLeg = mockLeg({ sellIoc: async () => ({ filledQty: 10, grossKrw: 10100, feeKrw: 4 }) });
    const upbitLeg = mockLeg({ buyIoc: async () => ({ filledQty: 9.9, grossKrw: 9900, feeKrw: 5 }) });
    const r = await executeReclaim({ bithumbLeg, upbitLeg, symbol: 'XRP', qty: 10, bithumbBid: 1010, upbitAsk: 1000 });
    expect(r.status).toBe('partial'); // 1% > 0.5% 허용오차
  });

  it('maxLossBps=0(기본): 기존대로 net≥0 (손실 허용 안 함)', async () => {
    const bithumbLeg = mockLeg({ sellIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 4 }) });
    const buyIoc = jest.fn(async () => ({ filledQty: 10, grossKrw: 9990, feeKrw: 5 }));
    const upbitLeg = mockLeg({ buyIoc });
    const r = await executeReclaim({ bithumbLeg, upbitLeg, symbol: 'XRP', qty: 10, bithumbBid: 1000, upbitAsk: 1000, buyFeeBps: 5 });
    const [, , , budget] = buyIoc.mock.calls[0] as unknown as [string, number, number, number];
    expect(budget).toBeLessThanOrEqual(10000 - 4); // 매도 순대금 이내(손실 불가)
    expect(r.netKrw).toBeGreaterThanOrEqual(0);
  });
});
