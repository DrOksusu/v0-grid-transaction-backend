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
    expect(result.failureReason).toMatch(/not filled|timeout/i);
  });

  it('happy path profitKrw 정확 계산 (regression guard)', async () => {
    // legA buy 10 @ 1000, fee 5
    // legB sell 10 @ 1010, fee 5
    // profitKrw = 10*1010 - 10*1000 - 5 - 5 = 90
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
    expect(result.profitKrw).toBe(90);
  });

  it('BU 방향 양쪽 success → status FILLED + correct leg routing', async () => {
    const upbit = mockClient({
      placeMarketOrder: jest.fn().mockResolvedValue({ orderId: 'U-2', status: 'pending', filledQty: 0, avgFillPrice: 0, totalFeeKrw: 0 }),
      getOrder: jest.fn().mockResolvedValue({ orderId: 'U-2', status: 'filled', filledQty: 10, avgFillPrice: 1010, totalFeeKrw: 5 }),
    });
    const bithumb = mockClient({
      exchangeName: 'bithumb',
      placeMarketOrder: jest.fn().mockResolvedValue({ orderId: 'B-2', status: 'pending', filledQty: 0, avgFillPrice: 0, totalFeeKrw: 0 }),
      getOrder: jest.fn().mockResolvedValue({ orderId: 'B-2', status: 'filled', filledQty: 10, avgFillPrice: 1000, totalFeeKrw: 5 }),
    });
    const result = await execute({
      botId: 1, direction: 'BU', coin: 'USDE', quantity: 10, spreadBps: 100,
      upbit, bithumb, pollingMaxMs: 100, pollingIntervalMs: 10,
    });
    expect(result.status).toBe('FILLED');
    expect(result.legA?.exchange).toBe('bithumb');
    expect(result.legA?.side).toBe('buy');
    expect(result.legB?.exchange).toBe('upbit');
    expect(result.legB?.side).toBe('sell');
    expect(result.profitKrw).toBe(90);
  });

  it('LegA partial fill → LEG_A_FAILED + shouldKillSwitch=true (재고 노출)', async () => {
    const upbit = mockClient({
      placeMarketOrder: jest.fn().mockResolvedValue({ orderId: 'U-3', status: 'pending', filledQty: 0, avgFillPrice: 0, totalFeeKrw: 0 }),
      getOrder: jest.fn().mockResolvedValue({ orderId: 'U-3', status: 'partial', filledQty: 7, avgFillPrice: 1000, totalFeeKrw: 4 }),
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
    expect(result.shouldKillSwitch).toBe(true);
    expect(result.legA?.filledQty).toBe(7);
    expect(bithumb.placeMarketOrder).not.toHaveBeenCalled();
  });

  it('LegB getOrder throw → LEG_B_FAILED + shouldKillSwitch=true', async () => {
    const upbit = mockClient({
      placeMarketOrder: jest.fn().mockResolvedValue({ orderId: 'U-4', status: 'pending', filledQty: 0, avgFillPrice: 0, totalFeeKrw: 0 }),
      getOrder: jest.fn().mockResolvedValue({ orderId: 'U-4', status: 'filled', filledQty: 10, avgFillPrice: 1000, totalFeeKrw: 5 }),
    });
    const bithumb = mockClient({
      exchangeName: 'bithumb',
      placeMarketOrder: jest.fn().mockResolvedValue({ orderId: 'B-4', status: 'pending', filledQty: 0, avgFillPrice: 0, totalFeeKrw: 0 }),
      getOrder: jest.fn().mockRejectedValue(new Error('Bithumb 503')),
    });
    const result = await execute({
      botId: 1, direction: 'UB', coin: 'USDE', quantity: 10, spreadBps: 100,
      upbit, bithumb, pollingMaxMs: 100, pollingIntervalMs: 10,
    });
    expect(result.status).toBe('LEG_B_FAILED');
    expect(result.shouldKillSwitch).toBe(true);
    expect(result.failureReason).toMatch(/polling error|Bithumb 503/);
  });

  it('quantity mismatch (양쪽 fill but qty 다름) → LEG_B_FAILED + shouldKillSwitch=true', async () => {
    const upbit = mockClient({
      placeMarketOrder: jest.fn().mockResolvedValue({ orderId: 'U-5', status: 'filled', filledQty: 10, avgFillPrice: 1000, totalFeeKrw: 5 }),
    });
    const bithumb = mockClient({
      exchangeName: 'bithumb',
      placeMarketOrder: jest.fn().mockResolvedValue({ orderId: 'B-5', status: 'filled', filledQty: 9, avgFillPrice: 1010, totalFeeKrw: 5 }),
    });
    const result = await execute({
      botId: 1, direction: 'UB', coin: 'USDE', quantity: 10, spreadBps: 100,
      upbit, bithumb, pollingMaxMs: 100, pollingIntervalMs: 10,
    });
    expect(result.status).toBe('LEG_B_FAILED');
    expect(result.shouldKillSwitch).toBe(true);
    expect(result.failureReason).toMatch(/quantity mismatch/i);
  });
});
