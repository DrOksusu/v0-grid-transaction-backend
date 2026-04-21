/**
 * TradingService.executeTrade 테스트 (chunk-2)
 * 거래 실행 핵심 로직 - 봇 상태 확인, 매수/매도 주문, 에러 핸들링
 */

import prisma from '../../__mocks__/database';
import { TradingService } from '../../src/services/trading.service';

// --- 외부 서비스 Mock ---
jest.mock('../../src/services/upbit.service');
jest.mock('../../src/services/grid.service');
jest.mock('../../src/services/socket.service', () => ({
  socketService: {
    emitNewTrade: jest.fn(),
    emitTradeFilled: jest.fn(),
    emitBotUpdate: jest.fn(),
    emitError: jest.fn(),
    emitBalanceUpdate: jest.fn(),
  },
}));
jest.mock('../../src/services/upbit-price-manager', () => ({
  priceManager: {
    getPriceWithFallback: jest.fn(),
  },
}));
jest.mock('../../src/services/profit.service');

import { UpbitService } from '../../src/services/upbit.service';
import { GridService } from '../../src/services/grid.service';
import { socketService } from '../../src/services/socket.service';
import { priceManager } from '../../src/services/upbit-price-manager';

// UpbitService 인스턴스 메서드 mock
const mockBuyLimit = jest.fn();
const mockSellLimit = jest.fn();

(UpbitService as jest.MockedClass<typeof UpbitService>).mockImplementation(() => ({
  buyLimit: mockBuyLimit,
  sellLimit: mockSellLimit,
  getAccounts: jest.fn(),
  getOrder: jest.fn(),
  getFilledOrders: jest.fn(),
  getOrdersByUuids: jest.fn(),
  cancelOrder: jest.fn(),
} as any));

// GridService static mock
const mockFindExecutableGrids = GridService.findExecutableGrids as jest.Mock;

// priceManager mock
const mockGetPriceWithFallback = priceManager.getPriceWithFallback as jest.Mock;

// prisma mock 타입 캐스팅
const mockBotFindUnique = prisma.bot.findUnique as jest.Mock;
const mockBotUpdate = prisma.bot.update as jest.Mock;
const mockGridLevelUpdateMany = prisma.gridLevel.updateMany as jest.Mock;
const mockGridLevelUpdate = prisma.gridLevel.update as jest.Mock;
const mockTradeCreate = prisma.trade.create as jest.Mock;

// socketService mock 타입 캐스팅
const mockEmitNewTrade = socketService.emitNewTrade as jest.Mock;
const mockEmitError = socketService.emitError as jest.Mock;

/**
 * Date.now mock: 매 테스트마다 모듈 내부 캐시(credential, botInfo) TTL을 만료시키기 위해 사용
 * credentialCache TTL = 5분, botInfoCache TTL = 1분
 * 매 테스트 시작 시 6분(360000ms) 전진시켜 캐시 만료 보장
 */
let fakeNow: number;

// --- 헬퍼 함수 ---

/** 기본 봇 데이터 생성 */
function createBot(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    status: 'running',
    ticker: 'KRW-BTC',
    orderAmount: 10000,
    errorMessage: null,
    userId: 100,
    ...overrides,
  };
}

/** 기본 자격증명 봇 데이터 (getCachedCredential 내부 쿼리 결과) */
function createBotWithCredentials(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    userId: 100,
    ticker: 'KRW-BTC',
    orderAmount: 10000,
    user: {
      credentials: [
        { apiKey: 'encrypted_test-api-key', secretKey: 'encrypted_test-secret-key' },
      ],
    },
    ...overrides,
  };
}

/** findExecutableGrids 기본 빈 결과 */
function emptyGrids() {
  return { buys: [], sell: null };
}

/** 매수 그리드 데이터 생성 */
function createBuyGrid(overrides: Record<string, any> = {}) {
  return {
    id: 10,
    price: 50000,
    type: 'buy',
    status: 'available',
    ...overrides,
  };
}

/** 매도 그리드 데이터 생성 */
function createSellGrid(overrides: Record<string, any> = {}) {
  return {
    id: 20,
    price: 55000,
    type: 'sell',
    status: 'available',
    ...overrides,
  };
}

/**
 * 표준 설정: 봇 조회 + 자격증명 조회까지 정상 동작하도록 구성
 * executeTrade 내 withRetry(findUnique) 호출 순서:
 *  1회차: executeTrade 내 봇 상태 조회
 *  2회차: getCachedCredential 내 봇+자격증명 조회 (캐시 미스 시에만)
 */
function setupStandardMocks(bot = createBot()) {
  // 1) executeTrade.findBot - 봇 상태 조회
  mockBotFindUnique.mockResolvedValueOnce(bot);
  // 2) getCachedCredential - 봇+자격증명 조회 (캐시 만료 후 DB 조회)
  mockBotFindUnique.mockResolvedValueOnce(createBotWithCredentials({
    id: bot.id,
    userId: bot.userId ?? 100,
  }));

  // 현재가 조회
  mockGetPriceWithFallback.mockResolvedValue(52000);

  // 기본: 실행 가능한 그리드 없음
  mockFindExecutableGrids.mockResolvedValue(emptyGrids());
}

/**
 * 캐시 히트 설정: 이전 호출로 캐시가 이미 설정된 상태 (시간 미전진)
 * getCachedCredential이 캐시에서 반환하므로 findUnique 1회만 필요
 */
function setupCacheHitMocks(bot = createBot()) {
  // executeTrade.findBot만 (getCachedCredential은 캐시 히트)
  mockBotFindUnique.mockResolvedValueOnce(bot);

  mockGetPriceWithFallback.mockResolvedValue(52000);
  mockFindExecutableGrids.mockResolvedValue(emptyGrids());
}

// --- 테스트 시작 ---
describe('TradingService.executeTrade', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();

    // 캐시 만료를 위해 Date.now를 6분(360000ms) 전진
    if (!fakeNow) {
      fakeNow = Date.now() + 360000;
    } else {
      fakeNow += 360000;
    }
    jest.spyOn(Date, 'now').mockReturnValue(fakeNow);

    // 잔고 부족 쿨다운 및 lastCheckedPrice 초기화
    TradingService.clearLastCheckedPrice(1);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---- 1. 봇이 존재하지 않으면 실패 반환 ----
  it('봇이 존재하지 않으면 실패 반환', async () => {
    mockBotFindUnique.mockResolvedValueOnce(null);

    const result = await TradingService.executeTrade(1);

    expect(result).toEqual({
      success: false,
      message: '봇이 실행 중이 아닙니다',
    });
  });

  // ---- 2. 봇 상태가 running이 아니면 실패 반환 ----
  it('봇 상태가 running이 아니면 실패 반환', async () => {
    mockBotFindUnique.mockResolvedValueOnce(createBot({ status: 'stopped' }));

    const result = await TradingService.executeTrade(1);

    expect(result).toEqual({
      success: false,
      message: '봇이 실행 중이 아닙니다',
    });
  });

  // ---- 3. 자격증명이 없으면 봇 상태를 error로 변경 후 실패 반환 ----
  it('자격증명이 없으면 봇 상태를 error로 변경 후 실패 반환', async () => {
    mockBotFindUnique.mockResolvedValueOnce(createBot());
    mockBotFindUnique.mockResolvedValueOnce({
      id: 1,
      userId: 100,
      user: { credentials: [] },
    });
    mockBotUpdate.mockResolvedValue({});

    const result = await TradingService.executeTrade(1);

    expect(result).toEqual({
      success: false,
      message: 'API 인증 정보가 없습니다',
    });
    expect(mockBotUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        status: 'error',
        errorMessage: 'API 인증 정보가 없습니다',
      },
    });
  });

  // ---- 4. 정상 매수 주문 실행 ----
  it('정상 매수 주문 실행 - 그리드 상태 pending 변경, 주문, Trade 생성, 소켓 알림', async () => {
    setupStandardMocks();
    const buyGrid = createBuyGrid({ id: 10, price: 50000 });
    mockFindExecutableGrids.mockResolvedValue({ buys: [buyGrid], sell: null });

    mockGridLevelUpdateMany.mockResolvedValue({ count: 1 });
    mockBuyLimit.mockResolvedValue({ uuid: 'order-uuid-buy-1' });
    mockGridLevelUpdate.mockResolvedValue({});

    const createdTrade = {
      id: 100,
      createdAt: new Date('2026-02-18T10:00:00Z'),
    };
    mockTradeCreate.mockResolvedValue(createdTrade);
    mockBotUpdate.mockResolvedValue({});

    const result = await TradingService.executeTrade(1);

    expect(result).toEqual({ success: true, executed: true });

    // 그리드 상태를 pending으로 변경
    expect(mockGridLevelUpdateMany).toHaveBeenCalledWith({
      where: { id: 10, status: 'available' },
      data: { status: 'pending' },
    });

    // 매수 주문 실행
    expect(mockBuyLimit).toHaveBeenCalledWith(
      'KRW-BTC',
      50000,
      10000 / 50000,
    );

    // orderId 업데이트
    expect(mockGridLevelUpdate).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { orderId: 'order-uuid-buy-1' },
    });

    // Trade 생성
    expect(mockTradeCreate).toHaveBeenCalledWith({
      data: {
        botId: 1,
        gridLevelId: 10,
        type: 'buy',
        price: 50000,
        amount: 10000 / 50000,
        total: 10000,
        orderId: 'order-uuid-buy-1',
      },
    });

    // 소켓 알림
    expect(mockEmitNewTrade).toHaveBeenCalledWith(1, expect.objectContaining({
      id: 100,
      type: 'buy',
      price: 50000,
      orderId: 'order-uuid-buy-1',
      status: 'pending',
    }));
  });

  // ---- 5. 매수 주문 시 race condition 방지 ----
  it('매수 주문 시 race condition 방지 - updateMany count=0이면 스킵', async () => {
    setupStandardMocks();
    const buyGrid = createBuyGrid();
    mockFindExecutableGrids.mockResolvedValue({ buys: [buyGrid], sell: null });

    mockGridLevelUpdateMany.mockResolvedValue({ count: 0 });

    const result = await TradingService.executeTrade(1);

    expect(mockBuyLimit).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, executed: false });
  });

  // ---- 6. 매수 성공 시 잔고 부족 쿨다운 해제 ----
  it('매수 성공 시 잔고 부족 쿨다운 해제', async () => {
    // 1단계: 잔고 부족으로 쿨다운 설정
    setupStandardMocks();
    const buyGrid1 = createBuyGrid({ id: 10, price: 50000 });
    mockFindExecutableGrids.mockResolvedValue({ buys: [buyGrid1], sell: null });
    mockGridLevelUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({});
    mockBuyLimit.mockRejectedValue(new Error('잔고가 부족합니다'));
    mockBotUpdate.mockResolvedValue({});

    await TradingService.executeTrade(1);

    // 2단계: 쿨다운 중 매수 스킵 확인 (시간을 전진시키지 않아 캐시 히트 + 쿨다운 유지)
    jest.clearAllMocks();
    // 캐시는 이미 설정되어 있으므로 findUnique 1회만 필요
    setupCacheHitMocks();
    const buyGrid2 = createBuyGrid({ id: 11, price: 49000 });
    mockFindExecutableGrids.mockResolvedValue({ buys: [buyGrid2], sell: null });

    await TradingService.executeTrade(1);

    // 쿨다운 중이므로 매수 주문이 실행되지 않아야 함
    expect(mockBuyLimit).not.toHaveBeenCalled();

    // 3단계: clearLastCheckedPrice로 쿨다운 해제 후 매수 성공
    TradingService.clearLastCheckedPrice(1);
    jest.clearAllMocks();
    setupCacheHitMocks();
    const buyGrid3 = createBuyGrid({ id: 12, price: 48000 });
    mockFindExecutableGrids.mockResolvedValue({ buys: [buyGrid3], sell: null });
    mockGridLevelUpdateMany.mockResolvedValue({ count: 1 });
    mockBuyLimit.mockResolvedValue({ uuid: 'order-ok' });
    mockGridLevelUpdate.mockResolvedValue({});
    mockTradeCreate.mockResolvedValue({ id: 200, createdAt: new Date() });
    mockBotUpdate.mockResolvedValue({});

    await TradingService.executeTrade(1);

    // 쿨다운 해제 후 매수 성공
    expect(mockBuyLimit).toHaveBeenCalled();
  });

  // ---- 7. 매수 주문 실패 시 그리드 상태 available로 복구 ----
  it('매수 주문 실패 시 그리드 상태를 available로 복구', async () => {
    setupStandardMocks();
    const buyGrid = createBuyGrid({ id: 10, price: 50000 });
    mockFindExecutableGrids.mockResolvedValue({ buys: [buyGrid], sell: null });
    mockGridLevelUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockBuyLimit.mockRejectedValue(new Error('알 수 없는 에러'));
    mockGridLevelUpdateMany.mockResolvedValueOnce({});
    mockBotUpdate.mockResolvedValue({});

    await TradingService.executeTrade(1);

    // 실패 후 그리드 상태를 available로 복구
    expect(mockGridLevelUpdateMany).toHaveBeenCalledWith({
      where: { id: 10, status: 'pending', orderId: null },
      data: { status: 'available' },
    });
  });

  // ---- 8. 잔고 부족 에러 시 5분 쿨다운 설정 후 루프 중단(break) ----
  it('잔고 부족 에러 시 5분 쿨다운 설정 후 루프 중단(break)', async () => {
    setupStandardMocks();
    const buyGrid1 = createBuyGrid({ id: 10, price: 50000 });
    const buyGrid2 = createBuyGrid({ id: 11, price: 49000 });
    mockFindExecutableGrids.mockResolvedValue({ buys: [buyGrid1, buyGrid2], sell: null });

    mockGridLevelUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({});

    mockBuyLimit.mockRejectedValue(new Error('주문가능 금액(KRW)이 부족합니다'));
    mockBotUpdate.mockResolvedValue({});

    await TradingService.executeTrade(1);

    // 에러 메시지 저장
    expect(mockBotUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { errorMessage: '잔고 부족으로 매수 일시 중단 (5분 후 재시도)' },
    });

    // 소켓 에러 알림
    expect(mockEmitError).toHaveBeenCalledWith(1, expect.objectContaining({
      type: 'order_failed',
      message: expect.stringContaining('잔고 부족'),
    }));

    // break로 인해 두 번째 그리드는 처리되지 않음 (buyLimit 1회만 호출)
    expect(mockBuyLimit).toHaveBeenCalledTimes(1);
  });

  // ---- 9. 잔고 부족이 아닌 매수 에러 시 에러 메시지 저장 및 소켓 알림 ----
  it('잔고 부족이 아닌 매수 에러 시 에러 메시지 저장 및 소켓 알림', async () => {
    setupStandardMocks();
    const buyGrid = createBuyGrid({ id: 10, price: 50000 });
    mockFindExecutableGrids.mockResolvedValue({ buys: [buyGrid], sell: null });
    mockGridLevelUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({});
    mockBuyLimit.mockRejectedValue(new Error('서버 에러 발생'));
    mockBotUpdate.mockResolvedValue({});

    await TradingService.executeTrade(1);

    // 에러 메시지 저장
    expect(mockBotUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { errorMessage: '매수 주문 실패: 서버 에러 발생' },
    });

    // 소켓 에러 알림
    expect(mockEmitError).toHaveBeenCalledWith(1, {
      type: 'order_failed',
      message: '매수 주문 실패: 서버 에러 발생',
      details: '가격: 50,000원',
    });
  });

  // ---- 10. 잔고 부족 쿨다운 중에는 매수 주문 스킵 ----
  it('잔고 부족 쿨다운 중에는 매수 주문 스킵', async () => {
    // 1단계: 잔고 부족으로 쿨다운 설정
    setupStandardMocks();
    const buyGrid1 = createBuyGrid({ id: 10, price: 50000 });
    mockFindExecutableGrids.mockResolvedValue({ buys: [buyGrid1], sell: null });
    mockGridLevelUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({});
    mockBuyLimit.mockRejectedValue(new Error('insufficient balance'));
    mockBotUpdate.mockResolvedValue({});

    await TradingService.executeTrade(1);

    // 2단계: 쿨다운 중 매수 스킵 확인 (시간 미전진 → 캐시 히트 + 쿨다운 유지)
    jest.clearAllMocks();
    setupCacheHitMocks();
    const buyGrid2 = createBuyGrid({ id: 11, price: 49000 });
    mockFindExecutableGrids.mockResolvedValue({ buys: [buyGrid2], sell: null });

    const result = await TradingService.executeTrade(1);

    // 쿨다운 중이므로 매수 주문 실행 안 됨
    expect(mockBuyLimit).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, executed: false });
  });

  // ---- 11. 정상 매도 주문 실행 - 전체 플로우 ----
  it('정상 매도 주문 실행 - 전체 플로우', async () => {
    setupStandardMocks();
    const sellGrid = createSellGrid({ id: 20, price: 55000 });
    mockFindExecutableGrids.mockResolvedValue({ buys: [], sell: sellGrid });

    mockGridLevelUpdateMany.mockResolvedValue({ count: 1 });
    mockSellLimit.mockResolvedValue({ uuid: 'order-uuid-sell-1' });
    mockGridLevelUpdate.mockResolvedValue({});

    const createdTrade = {
      id: 200,
      createdAt: new Date('2026-02-18T11:00:00Z'),
    };
    mockTradeCreate.mockResolvedValue(createdTrade);
    mockBotUpdate.mockResolvedValue({});

    const result = await TradingService.executeTrade(1);

    expect(result).toEqual({ success: true, executed: true });

    // 그리드 상태를 pending으로 변경
    expect(mockGridLevelUpdateMany).toHaveBeenCalledWith({
      where: { id: 20, status: 'available' },
      data: { status: 'pending' },
    });

    // 매도 주문 실행
    expect(mockSellLimit).toHaveBeenCalledWith(
      'KRW-BTC',
      55000,
      10000 / 55000,
    );

    // orderId 업데이트
    expect(mockGridLevelUpdate).toHaveBeenCalledWith({
      where: { id: 20 },
      data: { orderId: 'order-uuid-sell-1' },
    });

    // Trade 생성
    expect(mockTradeCreate).toHaveBeenCalledWith({
      data: {
        botId: 1,
        gridLevelId: 20,
        type: 'sell',
        price: 55000,
        amount: 10000 / 55000,
        total: 10000,
        orderId: 'order-uuid-sell-1',
      },
    });

    // 소켓 알림
    expect(mockEmitNewTrade).toHaveBeenCalledWith(1, expect.objectContaining({
      id: 200,
      type: 'sell',
      price: 55000,
      orderId: 'order-uuid-sell-1',
      status: 'pending',
    }));
  });

  // ---- 12. 매도 주문 시 race condition 방지 ----
  it('매도 주문 시 race condition 방지 - 이미 처리 중이면 스킵', async () => {
    setupStandardMocks();
    const sellGrid = createSellGrid({ id: 20, price: 55000 });
    mockFindExecutableGrids.mockResolvedValue({ buys: [], sell: sellGrid });

    mockGridLevelUpdateMany.mockResolvedValue({ count: 0 });

    const result = await TradingService.executeTrade(1);

    expect(mockSellLimit).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, executed: false });
  });

  // ---- 13. 매도 주문 실패 시 그리드 available 복구 및 에러 알림 ----
  it('매도 주문 실패 시 그리드 available 복구 및 에러 알림', async () => {
    setupStandardMocks();
    const sellGrid = createSellGrid({ id: 20, price: 55000 });
    mockFindExecutableGrids.mockResolvedValue({ buys: [], sell: sellGrid });

    mockGridLevelUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({});

    mockSellLimit.mockRejectedValue(new Error('매도 주문 API 에러'));
    mockBotUpdate.mockResolvedValue({});

    await TradingService.executeTrade(1);

    // 그리드 상태를 available로 복구
    expect(mockGridLevelUpdateMany).toHaveBeenCalledWith({
      where: { id: 20, status: 'pending', orderId: null },
      data: { status: 'available' },
    });

    // 에러 메시지 저장
    expect(mockBotUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { errorMessage: '매도 주문 실패: 매도 주문 API 에러' },
    });

    // 소켓 에러 알림
    expect(mockEmitError).toHaveBeenCalledWith(1, {
      type: 'order_failed',
      message: '매도 주문 실패: 매도 주문 API 에러',
      details: '가격: 55,000원',
    });
  });

  // ---- 14. 주문 실행 후 lastExecutedAt 업데이트 ----
  it('주문 실행 후 lastExecutedAt 업데이트', async () => {
    setupStandardMocks();
    const buyGrid = createBuyGrid({ id: 10, price: 50000 });
    mockFindExecutableGrids.mockResolvedValue({ buys: [buyGrid], sell: null });
    mockGridLevelUpdateMany.mockResolvedValue({ count: 1 });
    mockBuyLimit.mockResolvedValue({ uuid: 'order-uuid-1' });
    mockGridLevelUpdate.mockResolvedValue({});
    mockTradeCreate.mockResolvedValue({ id: 100, createdAt: new Date() });
    mockBotUpdate.mockResolvedValue({});

    await TradingService.executeTrade(1);

    // lastExecutedAt 업데이트 호출 확인
    const lastExecutedCall = mockBotUpdate.mock.calls.find(
      (call: any[]) => call[0]?.data?.lastExecutedAt,
    );
    expect(lastExecutedCall).toBeDefined();
    expect(lastExecutedCall![0]).toEqual({
      where: { id: 1 },
      data: { lastExecutedAt: expect.any(Date) },
    });
  });

  // ---- 15. 실행된 주문이 없으면 lastExecutedAt 업데이트 안 함 ----
  it('실행된 주문이 없으면 lastExecutedAt 업데이트 안 함', async () => {
    setupStandardMocks();
    mockFindExecutableGrids.mockResolvedValue(emptyGrids());

    const result = await TradingService.executeTrade(1);

    expect(result).toEqual({ success: true, executed: false });

    // lastExecutedAt 업데이트가 호출되지 않아야 함
    const lastExecutedCall = mockBotUpdate.mock.calls.find(
      (call: any[]) => call[0]?.data?.lastExecutedAt,
    );
    expect(lastExecutedCall).toBeUndefined();
  });

  // ---- 16. 기존 errorMessage가 있으면 가격 조회 성공 시 null로 초기화 ----
  it('기존 errorMessage가 있으면 가격 조회 성공 시 null로 초기화', async () => {
    const bot = createBot({ errorMessage: '이전 에러 메시지' });
    mockBotFindUnique.mockResolvedValueOnce(bot);
    mockBotFindUnique.mockResolvedValueOnce(createBotWithCredentials());

    mockGetPriceWithFallback.mockResolvedValue(52000);
    mockFindExecutableGrids.mockResolvedValue(emptyGrids());
    mockBotUpdate.mockResolvedValue({});

    await TradingService.executeTrade(1);

    // errorMessage를 null로 초기화하는 호출이 있어야 함
    expect(mockBotUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { errorMessage: null },
    });
  });

  // ---- 17. 일시적 에러 시 상태 유지(running) ----
  describe('일시적 에러 처리', () => {
    const temporaryErrors = [
      '429 Too Many Requests',
      '현재가 조회 실패: timeout',
      'Too Many Requests',
      'connection pool timeout',
      'Timed out fetching data',
      'P2024: connection pool error',
    ];

    it.each(temporaryErrors)(
      '일시적 에러 "%s" 시 상태를 running으로 유지',
      async (errorMsg) => {
        mockBotFindUnique.mockResolvedValueOnce(createBot());
        mockBotFindUnique.mockResolvedValueOnce(createBotWithCredentials());
        mockGetPriceWithFallback.mockRejectedValue(new Error(errorMsg));
        mockBotUpdate.mockResolvedValue({});

        const result = await TradingService.executeTrade(1);

        expect(result).toEqual({ success: false, message: errorMsg });

        // 에러 메시지만 저장하고 status는 변경하지 않음
        expect(mockBotUpdate).toHaveBeenCalledWith({
          where: { id: 1 },
          data: { errorMessage: errorMsg },
        });

        // status: 'error'를 설정하는 호출이 없어야 함
        const errorStatusCall = mockBotUpdate.mock.calls.find(
          (call: any[]) => call[0]?.data?.status === 'error',
        );
        expect(errorStatusCall).toBeUndefined();
      },
    );
  });

  // ---- 18. 비일시적 에러 시 봇 상태를 error로 변경 ----
  it('비일시적 에러 시 봇 상태를 error로 변경', async () => {
    mockBotFindUnique.mockResolvedValueOnce(createBot());
    mockBotFindUnique.mockResolvedValueOnce(createBotWithCredentials());
    mockGetPriceWithFallback.mockRejectedValue(new Error('Unknown critical error'));
    mockBotUpdate.mockResolvedValue({});

    const result = await TradingService.executeTrade(1);

    expect(result).toEqual({ success: false, message: 'Unknown critical error' });

    // 상태를 error로 변경
    expect(mockBotUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        status: 'error',
        errorMessage: 'Unknown critical error',
      },
    });
  });

  // ---- 19. 여러 매수 그리드 사이에 200ms 대기 ----
  it('여러 매수 그리드 사이에 200ms 대기', async () => {
    setupStandardMocks();
    const buyGrid1 = createBuyGrid({ id: 10, price: 50000 });
    const buyGrid2 = createBuyGrid({ id: 11, price: 49000 });
    mockFindExecutableGrids.mockResolvedValue({ buys: [buyGrid1, buyGrid2], sell: null });

    mockGridLevelUpdateMany.mockResolvedValue({ count: 1 });
    mockBuyLimit.mockResolvedValue({ uuid: 'order-uuid' });
    mockGridLevelUpdate.mockResolvedValue({});
    mockTradeCreate.mockResolvedValue({ id: 100, createdAt: new Date() });
    mockBotUpdate.mockResolvedValue({});

    // setTimeout spy로 200ms 대기 호출 확인
    const originalSetTimeout = global.setTimeout;
    const setTimeoutCalls: number[] = [];
    const spiedSetTimeout = (fn: Function, ms?: number, ...args: any[]) => {
      if (ms !== undefined) setTimeoutCalls.push(ms);
      return originalSetTimeout(fn as (...args: any[]) => void, ms, ...args);
    };
    global.setTimeout = spiedSetTimeout as any;

    await TradingService.executeTrade(1);

    // 200ms 대기가 호출되었는지 확인
    expect(setTimeoutCalls).toContain(200);

    // 두 그리드 모두 처리됨
    expect(mockBuyLimit).toHaveBeenCalledTimes(2);

    // 복원
    global.setTimeout = originalSetTimeout;
  });
});
