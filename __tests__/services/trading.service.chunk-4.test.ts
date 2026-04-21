/**
 * TradingService chunk-4 테스트
 * 대상 메서드: processFilledOrder, checkFilledOrders, checkAndProcessSingleOrder
 */
import prisma from '../../__mocks__/database';
import { TradingService } from '../../src/services/trading.service';

// --- 외부 모듈 mock ---
jest.mock('../../src/services/upbit.service');
jest.mock('../../src/services/socket.service', () => ({
  socketService: {
    emitTradeFilled: jest.fn(),
    emitNewTrade: jest.fn(),
    emitBotUpdate: jest.fn(),
    emitError: jest.fn(),
    emitBalanceUpdate: jest.fn(),
  },
}));
jest.mock('../../src/services/grid.service', () => ({
  GridService: {
    updateGridLevel: jest.fn(),
    findExecutableGrids: jest.fn(),
  },
}));
jest.mock('../../src/services/profit.service', () => ({
  ProfitService: {
    recordProfit: jest.fn(),
  },
}));
jest.mock('../../src/services/upbit-price-manager', () => ({
  priceManager: {
    getPriceWithFallback: jest.fn(),
  },
}));

import { UpbitService } from '../../src/services/upbit.service';
import { socketService } from '../../src/services/socket.service';
import { GridService } from '../../src/services/grid.service';
import { ProfitService } from '../../src/services/profit.service';
import { withRetry } from '../../__mocks__/database';

// UpbitService 인스턴스 mock
const mockUpbitInstance = {
  getOrder: jest.fn(),
  getAccounts: jest.fn(),
  getFilledOrders: jest.fn(),
  getOrdersByUuids: jest.fn(),
  buyLimit: jest.fn(),
  sellLimit: jest.fn(),
  cancelOrder: jest.fn(),
};

(UpbitService as jest.MockedClass<typeof UpbitService>).mockImplementation(
  () => mockUpbitInstance as any
);

// executeOppositeOrder mock (private 메서드)
const executeOppositeOrderSpy = jest
  .spyOn(TradingService as any, 'executeOppositeOrder')
  .mockResolvedValue(undefined);

// getCachedBotInfo mock (private 메서드)
const getCachedBotInfoSpy = jest.spyOn(TradingService as any, 'getCachedBotInfo');

// getUserCredential mock (private 메서드)
const getUserCredentialSpy = jest.spyOn(TradingService as any, 'getUserCredential');

// getCachedCredential mock (private 메서드)
const getCachedCredentialSpy = jest.spyOn(TradingService as any, 'getCachedCredential');

// processFilledOrder 접근 헬퍼
const callProcessFilledOrder = (grid: any, order: any, upbit: any, userId: number) =>
  (TradingService as any).processFilledOrder(grid, order, upbit, userId);

// 콘솔 출력 억제 (테스트 출력 정리)
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation();
  jest.spyOn(console, 'warn').mockImplementation();
});

afterAll(() => {
  (console.log as jest.Mock).mockRestore();
  (console.warn as jest.Mock).mockRestore();
});

// 기본 grid / order 헬퍼
function makeGrid(overrides: Record<string, any> = {}) {
  return {
    id: 100,
    botId: 1,
    type: 'buy',
    price: 50000,
    buyPrice: 50000,
    sellPrice: 55000,
    status: 'pending',
    orderId: 'uuid-order-1',
    ...overrides,
  };
}

function makeOrder(overrides: Record<string, any> = {}) {
  return {
    uuid: 'uuid-order-1',
    state: 'done',
    avg_price: '51000',
    price: '50000',
    executed_volume: '0.001',
    trades: [
      { created_at: '2026-01-15T10:30:00+09:00' },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();

  // 기본 prisma mock 설정
  (prisma.gridLevel.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
  (prisma.gridLevel.update as jest.Mock).mockResolvedValue({});
  (prisma.bot.update as jest.Mock).mockResolvedValue({
    id: 1,
    totalTrades: 1,
    currentProfit: 0,
    status: 'running',
  });
  (prisma.trade.findFirst as jest.Mock).mockResolvedValue({
    id: 10,
    orderId: 'uuid-order-1',
  });
  (prisma.trade.update as jest.Mock).mockResolvedValue({});
  (prisma.trade.create as jest.Mock).mockResolvedValue({
    id: 11,
    createdAt: new Date(),
  });

  // withRetry: 전달된 함수를 그냥 실행 (기본 동작 유지)
  (withRetry as jest.Mock).mockImplementation(async (fn: Function) => fn());

  // 기본 봇 조회: running 상태 반환
  (prisma.bot.findUnique as jest.Mock).mockResolvedValue({
    id: 1,
    userId: 1,
    totalTrades: 1,
    currentProfit: 100,
    status: 'running',
  });

  // getCachedBotInfo 기본 반환
  getCachedBotInfoSpy.mockResolvedValue({
    userId: 1,
    ticker: 'KRW-BTC',
    orderAmount: 10000,
    expireAt: Date.now() + 60000,
  });

  // getUserCredential 기본 반환
  getUserCredentialSpy.mockResolvedValue({
    apiKey: 'test-api-key',
    secretKey: 'test-secret-key',
  });

  // getCachedCredential 기본 반환
  getCachedCredentialSpy.mockResolvedValue({
    apiKey: 'test-api-key',
    secretKey: 'test-secret-key',
    userId: 1,
  });

  // upbit 계좌 조회 기본 반환
  mockUpbitInstance.getAccounts.mockResolvedValue([
    { currency: 'KRW', balance: '1000000', locked: '50000' },
  ]);
});

// ==============================================================
// processFilledOrder 테스트
// ==============================================================
describe('processFilledOrder', () => {
  it('1. 중복 처리 방지: updateMany count=0이면 즉시 리턴', async () => {
    (prisma.gridLevel.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    const grid = makeGrid();
    const order = makeOrder();

    await callProcessFilledOrder(grid, order, mockUpbitInstance, 1);

    // count=0이면 이후 로직 실행 안 됨
    expect(prisma.gridLevel.update).not.toHaveBeenCalled();
    expect(prisma.bot.update).not.toHaveBeenCalled();
  });

  it('2. 업비트 실제 체결 시간 추출 (order.trades 존재)', async () => {
    const grid = makeGrid();
    const order = makeOrder({
      trades: [
        { created_at: '2026-01-15T10:00:00+09:00' },
        { created_at: '2026-01-15T10:30:00+09:00' },
      ],
    });

    await callProcessFilledOrder(grid, order, mockUpbitInstance, 1);

    // gridLevel.update에 filledAt이 마지막 trade의 시간과 일치
    const updateCall = (prisma.gridLevel.update as jest.Mock).mock.calls[0];
    const filledAt = updateCall[0].data.filledAt as Date;
    expect(filledAt.toISOString()).toBe(new Date('2026-01-15T10:30:00+09:00').toISOString());
  });

  it('3. order.trades가 없을 때 현재 시간 사용', async () => {
    const grid = makeGrid();
    const order = makeOrder({ trades: undefined });

    const beforeTime = Date.now();
    await callProcessFilledOrder(grid, order, mockUpbitInstance, 1);
    const afterTime = Date.now();

    const updateCall = (prisma.gridLevel.update as jest.Mock).mock.calls[0];
    const filledAt = (updateCall[0].data.filledAt as Date).getTime();
    // 현재 시간 근처여야 함
    expect(filledAt).toBeGreaterThanOrEqual(beforeTime - 100);
    expect(filledAt).toBeLessThanOrEqual(afterTime + 100);
  });

  it('4. 매도 체결 시 수익 계산 (수수료 0.05% 반영)', async () => {
    const grid = makeGrid({ type: 'sell', buyPrice: 50000 });
    const order = makeOrder({ avg_price: '55000', executed_volume: '1.0' });

    await callProcessFilledOrder(grid, order, mockUpbitInstance, 1);

    // 수익 계산 검증: profit = sellAmount - buyAmount - buyFee - sellFee
    // sellAmount = 1.0 * 55000 = 55000
    // buyAmount = 1.0 * 50000 = 50000
    // buyFee = 50000 * 0.0005 = 25
    // sellFee = 55000 * 0.0005 = 27.5
    // profit = 55000 - 50000 - 25 - 27.5 = 4947.5
    const botUpdate = (prisma.bot.update as jest.Mock).mock.calls[0];
    expect(botUpdate[0].data.currentProfit.increment).toBeCloseTo(4947.5, 1);
  });

  it('5. 매수 체결 시 profit=0', async () => {
    const grid = makeGrid({ type: 'buy' });
    const order = makeOrder();

    await callProcessFilledOrder(grid, order, mockUpbitInstance, 1);

    const botUpdate = (prisma.bot.update as jest.Mock).mock.calls[0];
    expect(botUpdate[0].data.currentProfit.increment).toBe(0);
  });

  it('6. order.avg_price 우선 사용, 없으면 order.price 폴백', async () => {
    // avg_price가 있는 경우
    const grid1 = makeGrid();
    const order1 = makeOrder({ avg_price: '51000', price: '50000' });

    await callProcessFilledOrder(grid1, order1, mockUpbitInstance, 1);

    let tradeUpdate = (prisma.trade.update as jest.Mock).mock.calls[0];
    expect(tradeUpdate[0].data.price).toBe(51000);

    jest.clearAllMocks();
    // 기본값 재설정
    (prisma.gridLevel.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (prisma.bot.update as jest.Mock).mockResolvedValue({});
    (prisma.trade.findFirst as jest.Mock).mockResolvedValue({ id: 10, orderId: 'uuid-order-1' });
    (prisma.trade.update as jest.Mock).mockResolvedValue({});
    (prisma.bot.findUnique as jest.Mock).mockResolvedValue({
      id: 1, status: 'running', totalTrades: 1, currentProfit: 0,
    });
    getCachedBotInfoSpy.mockResolvedValue({
      userId: 1, ticker: 'KRW-BTC', orderAmount: 10000, expireAt: Date.now() + 60000,
    });
    mockUpbitInstance.getAccounts.mockResolvedValue([
      { currency: 'KRW', balance: '1000000', locked: '50000' },
    ]);

    // avg_price가 없는 경우 — price 폴백
    const grid2 = makeGrid();
    const order2 = makeOrder({ avg_price: null, price: '49000' });

    await callProcessFilledOrder(grid2, order2, mockUpbitInstance, 1);

    tradeUpdate = (prisma.trade.update as jest.Mock).mock.calls[0];
    expect(tradeUpdate[0].data.price).toBe(49000);
  });

  it('7. 봇 통계 업데이트 (totalTrades +1, currentProfit +profit)', async () => {
    const grid = makeGrid({ type: 'sell', buyPrice: 50000 });
    const order = makeOrder({ avg_price: '55000', executed_volume: '1.0' });

    await callProcessFilledOrder(grid, order, mockUpbitInstance, 1);

    const botUpdate = (prisma.bot.update as jest.Mock).mock.calls[0];
    expect(botUpdate[0].data.totalTrades).toEqual({ increment: 1 });
    expect(botUpdate[0].data.currentProfit.increment).toBeGreaterThan(0);
  });

  it('8. 매도 체결 시 ProfitService.recordProfit 호출', async () => {
    const grid = makeGrid({ type: 'sell', buyPrice: 50000 });
    const order = makeOrder({ avg_price: '55000', executed_volume: '1.0' });

    await callProcessFilledOrder(grid, order, mockUpbitInstance, 1);

    expect(ProfitService.recordProfit).toHaveBeenCalledWith(
      1,        // userId
      'upbit',  // exchange
      expect.any(Number) // profit
    );
  });

  it('9. 기존 Trade 레코드 업데이트 (status=filled, 실제 체결가/량)', async () => {
    (prisma.trade.findFirst as jest.Mock).mockResolvedValue({ id: 10, orderId: 'uuid-order-1' });
    const grid = makeGrid();
    const order = makeOrder({ avg_price: '51000', executed_volume: '0.5' });

    await callProcessFilledOrder(grid, order, mockUpbitInstance, 1);

    expect(prisma.trade.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 10 },
        data: expect.objectContaining({
          status: 'filled',
          price: 51000,
          amount: 0.5,
          total: 51000 * 0.5,
        }),
      })
    );
  });

  it('10. Trade 레코드 없으면 새로 생성', async () => {
    (prisma.trade.findFirst as jest.Mock).mockResolvedValue(null);
    const grid = makeGrid({ type: 'buy' });
    const order = makeOrder({ avg_price: '51000', executed_volume: '0.5' });

    await callProcessFilledOrder(grid, order, mockUpbitInstance, 1);

    expect(prisma.trade.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          botId: 1,
          gridLevelId: 100,
          type: 'buy',
          status: 'filled',
          price: 51000,
          amount: 0.5,
          orderId: 'uuid-order-1',
        }),
      })
    );
  });

  it('11. 체결 후 잔고 업데이트 소켓 전송', async () => {
    mockUpbitInstance.getAccounts.mockResolvedValue([
      { currency: 'KRW', balance: '500000', locked: '100000' },
    ]);
    const grid = makeGrid();
    const order = makeOrder();

    await callProcessFilledOrder(grid, order, mockUpbitInstance, 1);

    expect(socketService.emitBalanceUpdate).toHaveBeenCalledWith(1, {
      availableBalance: 500000,
      lockedBalance: 100000,
      totalBalance: 600000,
    });
  });

  it('12. 잔고 조회 실패 시 에러 로깅만 (예외 전파 안 함)', async () => {
    mockUpbitInstance.getAccounts.mockRejectedValue(new Error('API 에러'));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    const grid = makeGrid();
    const order = makeOrder();

    // 예외가 전파되지 않아야 함 (정상적으로 완료)
    await callProcessFilledOrder(grid, order, mockUpbitInstance, 1);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('잔고 업데이트 소켓 전송 실패'),
      expect.any(String)
    );
    consoleSpy.mockRestore();
  });

  it('13. 봇이 running 상태면 executeOppositeOrder 호출', async () => {
    (prisma.bot.findUnique as jest.Mock).mockResolvedValue({
      id: 1, status: 'running', totalTrades: 2, currentProfit: 100,
    });
    const grid = makeGrid();
    const order = makeOrder();

    await callProcessFilledOrder(grid, order, mockUpbitInstance, 1);

    expect(executeOppositeOrderSpy).toHaveBeenCalledWith(
      mockUpbitInstance,
      expect.objectContaining({ id: 1, ticker: 'KRW-BTC' }),
      expect.objectContaining({ id: 100 })
    );
  });

  it('14. 봇이 running이 아니면 반대 주문 미실행', async () => {
    (prisma.bot.findUnique as jest.Mock).mockResolvedValue({
      id: 1, status: 'stopped', totalTrades: 2, currentProfit: 100,
    });
    const grid = makeGrid();
    const order = makeOrder();

    await callProcessFilledOrder(grid, order, mockUpbitInstance, 1);

    expect(executeOppositeOrderSpy).not.toHaveBeenCalled();
  });

  it('15. updatedBot이 null이면 반대 주문 미실행', async () => {
    (prisma.bot.findUnique as jest.Mock).mockResolvedValue(null);
    const grid = makeGrid();
    const order = makeOrder();

    await callProcessFilledOrder(grid, order, mockUpbitInstance, 1);

    expect(executeOppositeOrderSpy).not.toHaveBeenCalled();
    // emitBotUpdate도 호출되지 않아야 함
    expect(socketService.emitBotUpdate).not.toHaveBeenCalled();
  });
});

// ==============================================================
// checkAndProcessSingleOrder 테스트
// ==============================================================
describe('checkAndProcessSingleOrder', () => {
  // processFilledOrder를 spy로 감시
  let processFilledOrderSpy: jest.SpyInstance;

  beforeEach(() => {
    processFilledOrderSpy = jest
      .spyOn(TradingService as any, 'processFilledOrder')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    processFilledOrderSpy.mockRestore();
  });

  it('16. 그리드가 없거나 pending이 아니면 false 반환', async () => {
    // 그리드가 없는 경우
    (prisma.gridLevel.findUnique as jest.Mock).mockResolvedValue(null);
    expect(await TradingService.checkAndProcessSingleOrder(999)).toBe(false);

    // status가 pending이 아닌 경우
    (prisma.gridLevel.findUnique as jest.Mock).mockResolvedValue({
      id: 100, status: 'available', orderId: 'uuid-1',
      bot: { id: 1, userId: 1, ticker: 'KRW-BTC', orderAmount: 10000, status: 'running' },
    });
    expect(await TradingService.checkAndProcessSingleOrder(100)).toBe(false);

    // orderId가 없는 경우
    (prisma.gridLevel.findUnique as jest.Mock).mockResolvedValue({
      id: 100, status: 'pending', orderId: null,
      bot: { id: 1, userId: 1, ticker: 'KRW-BTC', orderAmount: 10000, status: 'running' },
    });
    expect(await TradingService.checkAndProcessSingleOrder(100)).toBe(false);
  });

  it('17. 봇이 running이 아니면 false', async () => {
    (prisma.gridLevel.findUnique as jest.Mock).mockResolvedValue({
      id: 100, status: 'pending', orderId: 'uuid-1',
      bot: { id: 1, userId: 1, ticker: 'KRW-BTC', orderAmount: 10000, status: 'stopped' },
    });

    const result = await TradingService.checkAndProcessSingleOrder(100);
    expect(result).toBe(false);
    expect(processFilledOrderSpy).not.toHaveBeenCalled();
  });

  it('18. order.state="done" 시 processFilledOrder 호출 후 true', async () => {
    (prisma.gridLevel.findUnique as jest.Mock).mockResolvedValue({
      id: 100, status: 'pending', orderId: 'uuid-1',
      bot: { id: 1, userId: 1, ticker: 'KRW-BTC', orderAmount: 10000, status: 'running' },
    });
    mockUpbitInstance.getOrder.mockResolvedValue({ state: 'done', uuid: 'uuid-1' });

    const result = await TradingService.checkAndProcessSingleOrder(100);
    expect(result).toBe(true);
    expect(processFilledOrderSpy).toHaveBeenCalled();
  });

  it('19. order.state="cancel" 시 available 복원 후 false', async () => {
    (prisma.gridLevel.findUnique as jest.Mock).mockResolvedValue({
      id: 100, status: 'pending', orderId: 'uuid-1',
      bot: { id: 1, userId: 1, ticker: 'KRW-BTC', orderAmount: 10000, status: 'running' },
    });
    mockUpbitInstance.getOrder.mockResolvedValue({ state: 'cancel', uuid: 'uuid-1' });

    const result = await TradingService.checkAndProcessSingleOrder(100);
    expect(result).toBe(false);
    expect(prisma.gridLevel.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { status: 'available', orderId: null },
    });
  });

  it('20. order.state="wait" 등 기타 상태면 false', async () => {
    (prisma.gridLevel.findUnique as jest.Mock).mockResolvedValue({
      id: 100, status: 'pending', orderId: 'uuid-1',
      bot: { id: 1, userId: 1, ticker: 'KRW-BTC', orderAmount: 10000, status: 'running' },
    });
    mockUpbitInstance.getOrder.mockResolvedValue({ state: 'wait', uuid: 'uuid-1' });

    const result = await TradingService.checkAndProcessSingleOrder(100);
    expect(result).toBe(false);
    expect(processFilledOrderSpy).not.toHaveBeenCalled();
  });

  it('21. 예외 발생 시 false 반환', async () => {
    (prisma.gridLevel.findUnique as jest.Mock).mockRejectedValue(new Error('DB 에러'));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    const result = await TradingService.checkAndProcessSingleOrder(100);
    expect(result).toBe(false);

    consoleSpy.mockRestore();
  });
});

// ==============================================================
// checkFilledOrders 테스트
// ==============================================================
describe('checkFilledOrders', () => {
  it('22. pending 그리드가 없으면 조기 리턴', async () => {
    (prisma.gridLevel.findMany as jest.Mock).mockResolvedValue([]);

    await TradingService.checkFilledOrders(1);

    // 자격증명 조회가 호출되지 않아야 함
    expect(getCachedCredentialSpy).not.toHaveBeenCalled();
  });

  it('23. 자격증명 없으면 조기 리턴', async () => {
    (prisma.gridLevel.findMany as jest.Mock).mockResolvedValue([
      { id: 100, orderId: 'uuid-1', status: 'pending', type: 'buy', price: 50000 },
    ]);
    getCachedCredentialSpy.mockResolvedValue(null);

    await TradingService.checkFilledOrders(1);

    // UpbitService 인스턴스가 생성되지 않아야 함 (getFilledOrders 호출 없음)
    expect(mockUpbitInstance.getFilledOrders).not.toHaveBeenCalled();
  });

  it('24. orderId 없는 그리드 필터링', async () => {
    (prisma.gridLevel.findMany as jest.Mock).mockResolvedValue([
      { id: 100, orderId: null, status: 'pending', type: 'buy', price: 50000 },
      { id: 101, orderId: undefined, status: 'pending', type: 'buy', price: 51000 },
    ]);
    getCachedCredentialSpy.mockResolvedValue({
      apiKey: 'key', secretKey: 'secret', userId: 1,
    });
    // orderId가 없는 그리드만 있으므로 getFilledOrders 후 매칭되는 게 없어 조기 리턴해야 함
    // 그러나 gridsWithOrderId.length === 0이면 return됨
    await TradingService.checkFilledOrders(1);

    // orderId 없는 그리드만이므로 getFilledOrders 호출 안 됨
    expect(mockUpbitInstance.getFilledOrders).not.toHaveBeenCalled();
  });
});
