/**
 * trading.service.ts - chunk-3 테스트
 * 대상 함수: checkAllFilledOrders (중앙 집중식 체결 확인)
 */

import prisma from '../../__mocks__/database';
import { TradingService } from '../../src/services/trading.service';

// UpbitService mock
jest.mock('../../src/services/upbit.service', () => {
  const mockGetFilledOrders = jest.fn();
  const mockGetOrdersByUuids = jest.fn();
  return {
    UpbitService: jest.fn().mockImplementation(() => ({
      getFilledOrders: mockGetFilledOrders,
      getOrdersByUuids: mockGetOrdersByUuids,
    })),
    __mockGetFilledOrders: mockGetFilledOrders,
    __mockGetOrdersByUuids: mockGetOrdersByUuids,
  };
});

// socketService mock
jest.mock('../../src/services/socket.service', () => ({
  socketService: {
    emitError: jest.fn(),
    emitBotUpdate: jest.fn(),
    emitNewTrade: jest.fn(),
    emitTradeFilled: jest.fn(),
    emitBalanceUpdate: jest.fn(),
  },
}));

// priceManager mock (trading.service.ts에서 import하므로)
jest.mock('../../src/services/upbit-price-manager', () => ({
  priceManager: {
    getPriceWithFallback: jest.fn(),
  },
}));

// GridService mock
jest.mock('../../src/services/grid.service', () => ({
  GridService: {
    findExecutableGrids: jest.fn(),
    updateGridLevel: jest.fn(),
  },
}));

// ProfitService mock
jest.mock('../../src/services/profit.service', () => ({
  ProfitService: {
    recordProfit: jest.fn(),
  },
}));

const { socketService } = require('../../src/services/socket.service');
const { UpbitService, __mockGetFilledOrders, __mockGetOrdersByUuids } = require('../../src/services/upbit.service');

// processFilledOrder, getUserCredential은 private → spyOn으로 설정
let processFilledOrderSpy: jest.SpyInstance;
let getUserCredentialSpy: jest.SpyInstance;

// setTimeout을 spy하기 위한 설정
let setTimeoutSpy: jest.SpyInstance;

// 테스트용 헬퍼: pending 그리드 데이터 생성
function createPendingGrid(overrides: Record<string, any> = {}) {
  return {
    id: 100,
    botId: 1,
    type: 'buy',
    price: 50000,
    status: 'pending',
    orderId: 'order-uuid-1',
    sellPrice: 55000,
    buyPrice: null,
    updatedAt: new Date(),
    bot: {
      id: 1,
      userId: 10,
      ticker: 'KRW-BTC',
      orderAmount: 10000,
      status: 'running',
    },
    ...overrides,
  };
}

describe('TradingService.checkAllFilledOrders - 중앙 집중식 체결 확인', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // private 메서드 spy 설정
    processFilledOrderSpy = jest.spyOn(TradingService as any, 'processFilledOrder').mockResolvedValue(undefined);
    getUserCredentialSpy = jest.spyOn(TradingService as any, 'getUserCredential').mockResolvedValue({
      apiKey: 'test-api-key',
      secretKey: 'test-secret-key',
    });

    // 기본 mock 설정
    (prisma.gridLevel.findMany as jest.Mock).mockResolvedValue([]);
    __mockGetFilledOrders.mockResolvedValue([]);
    __mockGetOrdersByUuids.mockResolvedValue([]);

    // setTimeout spy (300ms 대기 검증용) - 즉시 실행되도록
    setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation((fn: any) => {
      fn();
      return 0 as any;
    });

    // console 메서드 spy
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ========== 테스트 1: 빈 runningBotIds 배열이면 즉시 리턴 ==========
  it('빈 runningBotIds 배열이면 즉시 리턴', async () => {
    await TradingService.checkAllFilledOrders([]);

    // prisma 조회가 호출되지 않아야 함
    expect(prisma.gridLevel.findMany).not.toHaveBeenCalled();
    expect(getUserCredentialSpy).not.toHaveBeenCalled();
  });

  // ========== 테스트 2: pending 그리드가 없으면 조기 리턴 ==========
  it('pending 그리드가 없으면 조기 리턴', async () => {
    (prisma.gridLevel.findMany as jest.Mock).mockResolvedValue([]);

    await TradingService.checkAllFilledOrders([1, 2, 3]);

    expect(prisma.gridLevel.findMany).toHaveBeenCalledWith({
      where: {
        botId: { in: [1, 2, 3] },
        status: 'pending',
        orderId: { not: null },
      },
      include: {
        bot: {
          select: { id: true, userId: true, ticker: true, orderAmount: true, status: true },
        },
      },
    });
    // 자격증명 조회는 호출되지 않아야 함
    expect(getUserCredentialSpy).not.toHaveBeenCalled();
  });

  // ========== 테스트 3: 사용자별 그리드 그룹화 정상 동작 ==========
  it('사용자별 그리드 그룹화 정상 동작', async () => {
    // 사용자 10과 20의 그리드
    const grid1 = createPendingGrid({ id: 100, botId: 1, orderId: 'uuid-1', bot: { id: 1, userId: 10, ticker: 'KRW-BTC', orderAmount: 10000, status: 'running' } });
    const grid2 = createPendingGrid({ id: 101, botId: 2, orderId: 'uuid-2', bot: { id: 2, userId: 10, ticker: 'KRW-ETH', orderAmount: 5000, status: 'running' } });
    const grid3 = createPendingGrid({ id: 102, botId: 3, orderId: 'uuid-3', bot: { id: 3, userId: 20, ticker: 'KRW-XRP', orderAmount: 3000, status: 'running' } });

    (prisma.gridLevel.findMany as jest.Mock).mockResolvedValue([grid1, grid2, grid3]);
    __mockGetFilledOrders.mockResolvedValue([]);

    await TradingService.checkAllFilledOrders([1, 2, 3]);

    // 두 명의 사용자에 대해 getUserCredential이 호출됨
    expect(getUserCredentialSpy).toHaveBeenCalledTimes(2);
    expect(getUserCredentialSpy).toHaveBeenCalledWith(10);
    expect(getUserCredentialSpy).toHaveBeenCalledWith(20);
  });

  // ========== 테스트 4: 1단계 - 전체 마켓 체결 조회 후 매칭된 주문 processFilledOrder 호출 ==========
  it('1단계: 전체 마켓 체결 조회 후 매칭된 주문 processFilledOrder 호출', async () => {
    const grid1 = createPendingGrid({ id: 100, orderId: 'order-uuid-1' });
    const grid2 = createPendingGrid({ id: 101, orderId: 'order-uuid-2' });

    (prisma.gridLevel.findMany as jest.Mock).mockResolvedValue([grid1, grid2]);

    // getFilledOrders에서 order-uuid-1만 체결됨
    __mockGetFilledOrders.mockResolvedValue([
      { uuid: 'order-uuid-1', state: 'done', price: '50000', executed_volume: '0.001' },
      { uuid: 'other-order', state: 'done', price: '60000', executed_volume: '0.002' },
    ]);

    await TradingService.checkAllFilledOrders([1]);

    // order-uuid-1 매칭 → processFilledOrder 호출
    expect(processFilledOrderSpy).toHaveBeenCalledTimes(1);
    expect(processFilledOrderSpy).toHaveBeenCalledWith(
      grid1,
      expect.objectContaining({ uuid: 'order-uuid-1', state: 'done' }),
      expect.any(Object), // upbit 인스턴스
      10 // userId
    );
  });

  // ========== 테스트 5: 1단계 - 체결 조회 API 실패 시 에러 로깅 후 계속 진행 ==========
  it('1단계: 체결 조회 API 실패 시 에러 로깅 후 계속 진행', async () => {
    // 30분 이상 된 stale 그리드 (2단계에서 처리될 수 있도록)
    const staleTime = new Date(Date.now() - 35 * 60 * 1000);
    const grid1 = createPendingGrid({ id: 100, orderId: 'order-uuid-1', updatedAt: staleTime });

    (prisma.gridLevel.findMany as jest.Mock).mockResolvedValue([grid1]);

    // 1단계 실패
    __mockGetFilledOrders.mockRejectedValue(new Error('API 연결 실패'));

    // 2단계에서 처리 (stale 주문 조회 성공)
    __mockGetOrdersByUuids.mockResolvedValue([
      { uuid: 'order-uuid-1', state: 'done', price: '50000', executed_volume: '0.001' },
    ]);

    await TradingService.checkAllFilledOrders([1]);

    // 에러 로깅 확인
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('체결 조회 실패'),
      'API 연결 실패'
    );

    // 2단계가 계속 실행되어 processFilledOrder가 호출됨
    expect(processFilledOrderSpy).toHaveBeenCalledTimes(1);
  });

  // ========== 테스트 6: 2단계 - 30분 이상 된 pending 주문만 직접 조회 ==========
  it('2단계: 30분 이상 된 pending 주문만 직접 조회', async () => {
    const recentTime = new Date(); // 방금 생성된 주문
    const staleTime = new Date(Date.now() - 35 * 60 * 1000); // 35분 전

    const recentGrid = createPendingGrid({ id: 100, orderId: 'recent-uuid', updatedAt: recentTime });
    const staleGrid = createPendingGrid({ id: 101, orderId: 'stale-uuid', updatedAt: staleTime });

    (prisma.gridLevel.findMany as jest.Mock).mockResolvedValue([recentGrid, staleGrid]);
    __mockGetFilledOrders.mockResolvedValue([]); // 1단계에서 매칭 없음

    __mockGetOrdersByUuids.mockResolvedValue([
      { uuid: 'stale-uuid', state: 'done', price: '50000', executed_volume: '0.001' },
    ]);

    await TradingService.checkAllFilledOrders([1]);

    // stale-uuid만 getOrdersByUuids로 조회됨
    expect(__mockGetOrdersByUuids).toHaveBeenCalledWith(['stale-uuid']);
    // recent-uuid는 getOrdersByUuids에 포함되지 않음
  });

  // ========== 테스트 7: 2단계 - staleGrids 최대 20개 제한 ==========
  it('2단계: staleGrids 최대 20개 제한', async () => {
    const staleTime = new Date(Date.now() - 35 * 60 * 1000);

    // 25개의 stale 그리드 생성
    const staleGrids = Array.from({ length: 25 }, (_, i) =>
      createPendingGrid({
        id: 200 + i,
        orderId: `stale-uuid-${i}`,
        updatedAt: staleTime,
      })
    );

    (prisma.gridLevel.findMany as jest.Mock).mockResolvedValue(staleGrids);
    __mockGetFilledOrders.mockResolvedValue([]); // 1단계에서 매칭 없음
    __mockGetOrdersByUuids.mockResolvedValue([]); // 2단계에서도 체결 없음

    await TradingService.checkAllFilledOrders([1]);

    // getOrdersByUuids에 전달된 uuid 배열이 최대 20개
    expect(__mockGetOrdersByUuids).toHaveBeenCalledTimes(1);
    const calledUuids = __mockGetOrdersByUuids.mock.calls[0][0];
    expect(calledUuids).toHaveLength(20);
  });

  // ========== 테스트 8: 2단계 - order.state='done' 시 processFilledOrder 호출 ==========
  it("2단계: order.state='done' 시 processFilledOrder 호출", async () => {
    const staleTime = new Date(Date.now() - 35 * 60 * 1000);
    const grid = createPendingGrid({ id: 100, orderId: 'stale-uuid', updatedAt: staleTime });

    (prisma.gridLevel.findMany as jest.Mock).mockResolvedValue([grid]);
    __mockGetFilledOrders.mockResolvedValue([]); // 1단계에서 매칭 없음

    __mockGetOrdersByUuids.mockResolvedValue([
      { uuid: 'stale-uuid', state: 'done', price: '50000', executed_volume: '0.001' },
    ]);

    await TradingService.checkAllFilledOrders([1]);

    expect(processFilledOrderSpy).toHaveBeenCalledTimes(1);
    expect(processFilledOrderSpy).toHaveBeenCalledWith(
      grid,
      expect.objectContaining({ uuid: 'stale-uuid', state: 'done' }),
      expect.any(Object),
      10
    );
  });

  // ========== 테스트 9: 2단계 - order.state='cancel' 시 그리드를 available로 복원 ==========
  it("2단계: order.state='cancel' 시 그리드를 available로 복원", async () => {
    const staleTime = new Date(Date.now() - 35 * 60 * 1000);
    const grid = createPendingGrid({ id: 100, orderId: 'cancelled-uuid', updatedAt: staleTime });

    (prisma.gridLevel.findMany as jest.Mock).mockResolvedValue([grid]);
    __mockGetFilledOrders.mockResolvedValue([]);

    __mockGetOrdersByUuids.mockResolvedValue([
      { uuid: 'cancelled-uuid', state: 'cancel' },
    ]);

    await TradingService.checkAllFilledOrders([1]);

    // gridLevel.update로 available 복원
    expect(prisma.gridLevel.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { status: 'available', orderId: null },
    });

    // processFilledOrder는 호출되지 않음
    expect(processFilledOrderSpy).not.toHaveBeenCalled();
  });

  // ========== 테스트 10: 2단계 - order.state='wait' 시 updatedAt만 갱신 ==========
  it("2단계: order.state='wait' 시 updatedAt만 갱신", async () => {
    const staleTime = new Date(Date.now() - 35 * 60 * 1000);
    const grid = createPendingGrid({ id: 100, orderId: 'waiting-uuid', updatedAt: staleTime });

    (prisma.gridLevel.findMany as jest.Mock).mockResolvedValue([grid]);
    __mockGetFilledOrders.mockResolvedValue([]);

    __mockGetOrdersByUuids.mockResolvedValue([
      { uuid: 'waiting-uuid', state: 'wait' },
    ]);

    await TradingService.checkAllFilledOrders([1]);

    // updatedAt만 갱신
    expect(prisma.gridLevel.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { updatedAt: expect.any(Date) },
    });

    // processFilledOrder 호출 안 됨
    expect(processFilledOrderSpy).not.toHaveBeenCalled();
  });

  // ========== 테스트 11: 2단계 - staleGrids 조회 실패 시 에러 로깅 후 계속 ==========
  it('2단계: staleGrids 조회 실패 시 에러 로깅 후 계속', async () => {
    const staleTime = new Date(Date.now() - 35 * 60 * 1000);
    // 사용자 10과 20의 stale 그리드
    const grid1 = createPendingGrid({ id: 100, orderId: 'stale-1', updatedAt: staleTime, bot: { id: 1, userId: 10, ticker: 'KRW-BTC', orderAmount: 10000, status: 'running' } });
    const grid2 = createPendingGrid({ id: 101, orderId: 'stale-2', updatedAt: staleTime, bot: { id: 2, userId: 20, ticker: 'KRW-ETH', orderAmount: 5000, status: 'running' } });

    (prisma.gridLevel.findMany as jest.Mock).mockResolvedValue([grid1, grid2]);
    __mockGetFilledOrders.mockResolvedValue([]);

    // 첫 번째 사용자(10)의 stale 조회 실패, 두 번째 사용자(20)는 성공
    __mockGetOrdersByUuids
      .mockRejectedValueOnce(new Error('네트워크 에러'))
      .mockResolvedValueOnce([{ uuid: 'stale-2', state: 'done', price: '3000', executed_volume: '1' }]);

    await TradingService.checkAllFilledOrders([1, 2]);

    // 에러 로깅 확인
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('오래된 주문 조회 실패'),
      '네트워크 에러'
    );

    // 두 번째 사용자의 처리는 정상 진행
    expect(processFilledOrderSpy).toHaveBeenCalledTimes(1);
    expect(processFilledOrderSpy).toHaveBeenCalledWith(
      grid2,
      expect.objectContaining({ uuid: 'stale-2', state: 'done' }),
      expect.any(Object),
      20
    );
  });

  // ========== 테스트 12: 사용자 자격증명 없으면 해당 사용자 스킵 ==========
  it('사용자 자격증명 없으면 해당 사용자 스킵', async () => {
    const grid1 = createPendingGrid({ id: 100, orderId: 'uuid-1', bot: { id: 1, userId: 10, ticker: 'KRW-BTC', orderAmount: 10000, status: 'running' } });
    const grid2 = createPendingGrid({ id: 101, orderId: 'uuid-2', bot: { id: 2, userId: 20, ticker: 'KRW-ETH', orderAmount: 5000, status: 'running' } });

    (prisma.gridLevel.findMany as jest.Mock).mockResolvedValue([grid1, grid2]);

    // 사용자 10은 자격증명 없음, 20은 있음
    getUserCredentialSpy
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ apiKey: 'key-20', secretKey: 'secret-20' });

    __mockGetFilledOrders.mockResolvedValue([]);

    await TradingService.checkAllFilledOrders([1, 2]);

    // 사용자 10 스킵 로그
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('자격증명 없음')
    );

    // UpbitService 생성은 사용자 20에 대해서만 (1회)
    expect(UpbitService).toHaveBeenCalledTimes(1);
    expect(UpbitService).toHaveBeenCalledWith({
      accessKey: 'key-20',
      secretKey: 'secret-20',
    });
  });

  // ========== 테스트 13: API 인증 에러(401/403) 시 해당 사용자의 모든 봇 자동 중지 ==========
  it('API 인증 에러(401/403) 시 해당 사용자의 모든 봇 자동 중지', async () => {
    const grid1 = createPendingGrid({ id: 100, orderId: 'uuid-1', bot: { id: 1, userId: 10, ticker: 'KRW-BTC', orderAmount: 10000, status: 'running' } });
    const grid2 = createPendingGrid({ id: 101, orderId: 'uuid-2', bot: { id: 2, userId: 10, ticker: 'KRW-ETH', orderAmount: 5000, status: 'running' } });

    (prisma.gridLevel.findMany as jest.Mock).mockResolvedValue([grid1, grid2]);
    (prisma.bot.update as jest.Mock).mockResolvedValue({});

    // getUserCredential이 인증 에러를 throw (외부 catch 블록에 도달)
    const authError: any = new Error('Unauthorized');
    authError.response = { status: 401 };
    getUserCredentialSpy.mockRejectedValue(authError);

    await TradingService.checkAllFilledOrders([1, 2]);

    // 해당 사용자의 모든 봇(1, 2) 중지
    expect(prisma.bot.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { status: 'stopped' },
    });
    expect(prisma.bot.update).toHaveBeenCalledWith({
      where: { id: 2 },
      data: { status: 'stopped' },
    });

    // 각 봇에 대해 emitError, emitBotUpdate 호출
    expect(socketService.emitError).toHaveBeenCalledWith(1, expect.objectContaining({
      type: 'api_error',
      message: expect.stringContaining('API 인증 실패'),
    }));
    expect(socketService.emitError).toHaveBeenCalledWith(2, expect.objectContaining({
      type: 'api_error',
    }));
    expect(socketService.emitBotUpdate).toHaveBeenCalledWith(1, { status: 'stopped' });
    expect(socketService.emitBotUpdate).toHaveBeenCalledWith(2, { status: 'stopped' });
  });

  // ========== 테스트 14: 봇 자동 중지 중 개별 봇 업데이트 실패 시 에러 로깅 후 계속 ==========
  it('봇 자동 중지 중 개별 봇 업데이트 실패 시 에러 로깅 후 계속', async () => {
    const grid1 = createPendingGrid({ id: 100, orderId: 'uuid-1', bot: { id: 1, userId: 10, ticker: 'KRW-BTC', orderAmount: 10000, status: 'running' } });
    const grid2 = createPendingGrid({ id: 101, orderId: 'uuid-2', bot: { id: 2, userId: 10, ticker: 'KRW-ETH', orderAmount: 5000, status: 'running' } });

    (prisma.gridLevel.findMany as jest.Mock).mockResolvedValue([grid1, grid2]);

    // 첫 번째 봇 업데이트 실패, 두 번째 성공
    (prisma.bot.update as jest.Mock)
      .mockRejectedValueOnce(new Error('DB 연결 실패'))
      .mockResolvedValueOnce({});

    // getUserCredential이 인증 에러를 throw (외부 catch 블록에 도달)
    const authError: any = new Error('401 Unauthorized');
    authError.response = { status: 401 };
    getUserCredentialSpy.mockRejectedValue(authError);

    await TradingService.checkAllFilledOrders([1, 2]);

    // 에러 로깅 확인 (봇 1 중지 실패)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Bot 1 중지 실패'),
      'DB 연결 실패'
    );

    // 두 번째 봇은 정상 중지
    expect(prisma.bot.update).toHaveBeenCalledWith({
      where: { id: 2 },
      data: { status: 'stopped' },
    });
  });

  // ========== 테스트 15: 인증 에러가 아닌 일반 에러 시 에러 로깅만 ==========
  it('인증 에러가 아닌 일반 에러 시 에러 로깅만', async () => {
    const grid = createPendingGrid({ id: 100, orderId: 'uuid-1' });

    (prisma.gridLevel.findMany as jest.Mock).mockResolvedValue([grid]);

    // getUserCredential이 일반 에러를 throw (외부 catch에서 isAuthError = false)
    const generalError = new Error('네트워크 타임아웃');
    getUserCredentialSpy.mockRejectedValue(generalError);

    await TradingService.checkAllFilledOrders([1]);

    // 에러 로깅만 확인 (봇 중지는 하지 않음)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('체결 확인 실패'),
      '네트워크 타임아웃'
    );

    // 봇 상태 변경이나 emitError/emitBotUpdate가 호출되지 않음
    expect(prisma.bot.update).not.toHaveBeenCalled();
    expect(socketService.emitError).not.toHaveBeenCalled();
    expect(socketService.emitBotUpdate).not.toHaveBeenCalled();
  });

  // ========== 테스트 16: 다음 사용자 처리 전 300ms 대기 ==========
  it('다음 사용자 처리 전 300ms 대기', async () => {
    const grid1 = createPendingGrid({ id: 100, orderId: 'uuid-1', bot: { id: 1, userId: 10, ticker: 'KRW-BTC', orderAmount: 10000, status: 'running' } });
    const grid2 = createPendingGrid({ id: 101, orderId: 'uuid-2', bot: { id: 2, userId: 20, ticker: 'KRW-ETH', orderAmount: 5000, status: 'running' } });

    (prisma.gridLevel.findMany as jest.Mock).mockResolvedValue([grid1, grid2]);
    __mockGetFilledOrders.mockResolvedValue([]);

    await TradingService.checkAllFilledOrders([1, 2]);

    // setTimeout이 300ms로 호출되었는지 확인 (사용자 수만큼)
    const timeoutCalls = setTimeoutSpy.mock.calls.filter(
      (call: any[]) => call[1] === 300
    );
    expect(timeoutCalls).toHaveLength(2); // 사용자 2명이므로 2번
  });
});
