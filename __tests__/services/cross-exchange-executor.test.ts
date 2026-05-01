import { execute, ExecutorArgs } from '../../src/services/cross-exchange-executor';
import { ExchangeClient } from '../../src/services/exchange/exchange-client';

const mockClient = (overrides: Partial<ExchangeClient> = {}): ExchangeClient => ({
  exchangeName: 'upbit',
  getOrderbookTop: jest.fn(),
  getBalances: jest.fn(),
  placeMarketOrder: jest.fn(),
  getOrder: jest.fn(),
  ...overrides,
}) as any;

describe('cross-exchange executor', () => {
  it('UB 방향 양쪽 success → status FILLED + profitKrw 양수', async () => {
    const upbit = mockClient({
      placeMarketOrder: jest.fn().mockResolvedValue({ orderId: 'U-1', status: 'pending', filledQty: 0, avgFillPrice: 0, totalFeeKrw: 0 }),
      getOrder: jest.fn().mockResolvedValue({ orderId: 'U-1', status: 'filled', filledQty: 10, avgFillPrice: 1000, totalFeeKrw: 5 }),
    });
    const bithumb = mockClient({
      exchangeName: 'bithumb',
      placeMarketOrder: jest.fn().mockResolvedValue({ orderId: 'B-1', status: 'pending', filledQty: 0, avgFillPrice: 0, totalFeeKrw: 0 }),
      getOrder: jest.fn().mockResolvedValue({ orderId: 'B-1', status: 'filled', filledQty: 10, avgFillPrice: 1010, totalFeeKrw: 5 }),
    });
    const result = await execute({
      botId: 1, direction: 'UB', coin: 'USDE', quantity: 10, spreadBps: 100,
      upbit, bithumb, pollingMaxMs: 100, pollingIntervalMs: 10,
    });
    expect(result.status).toBe('FILLED');
    expect(result.profitKrw).toBeGreaterThan(0);
  });

  it('LegA 실패 → LEG_A_FAILED + LegB 호출 안 함', async () => {
    const upbit = mockClient({
      placeMarketOrder: jest.fn().mockRejectedValue(new Error('Upbit reject')),
    });
    const bithumb = mockClient({
      exchangeName: 'bithumb',
      placeMarketOrder: jest.fn(),
    });
    const result = await execute({
      botId: 1, direction: 'UB', coin: 'USDE', quantity: 10, spreadBps: 100,
      upbit, bithumb, pollingMaxMs: 100, pollingIntervalMs: 10,
    });
    expect(result.status).toBe('LEG_A_FAILED');
    expect(bithumb.placeMarketOrder).not.toHaveBeenCalled();
  });

  it('LegB 실패 → LEG_B_FAILED + autoKillSwitch trigger flag', async () => {
    const upbit = mockClient({
      placeMarketOrder: jest.fn().mockResolvedValue({ orderId: 'U-1', status: 'pending', filledQty: 0, avgFillPrice: 0, totalFeeKrw: 0 }),
      getOrder: jest.fn().mockResolvedValue({ orderId: 'U-1', status: 'filled', filledQty: 10, avgFillPrice: 1000, totalFeeKrw: 5 }),
    });
    const bithumb = mockClient({
      exchangeName: 'bithumb',
      placeMarketOrder: jest.fn().mockRejectedValue(new Error('Bithumb 5500')),
    });
    const result = await execute({
      botId: 1, direction: 'UB', coin: 'USDE', quantity: 10, spreadBps: 100,
      upbit, bithumb, pollingMaxMs: 100, pollingIntervalMs: 10,
    });
    expect(result.status).toBe('LEG_B_FAILED');
    expect(result.shouldKillSwitch).toBe(true);
  });

  it('LegA polling timeout → LEG_A_FAILED', async () => {
    const upbit = mockClient({
      placeMarketOrder: jest.fn().mockResolvedValue({ orderId: 'U-1', status: 'pending', filledQty: 0, avgFillPrice: 0, totalFeeKrw: 0 }),
      getOrder: jest.fn().mockResolvedValue({ orderId: 'U-1', status: 'pending', filledQty: 0, avgFillPrice: 0, totalFeeKrw: 0 }),
    });
    const bithumb = mockClient({
      exchangeName: 'bithumb',
      placeMarketOrder: jest.fn(),
    });
    const result = await execute({
      botId: 1, direction: 'UB', coin: 'USDE', quantity: 10, spreadBps: 100,
      upbit, bithumb, pollingMaxMs: 50, pollingIntervalMs: 10,
    });
    expect(result.status).toBe('LEG_A_FAILED');
    expect(result.failureReason).toMatch(/timeout/i);
  });
});
