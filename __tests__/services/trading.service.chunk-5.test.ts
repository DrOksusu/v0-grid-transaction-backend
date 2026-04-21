/**
 * TradingService chunk-5 테스트: executeOppositeOrder, trimBuyOrdersOnInsufficientBalance
 *
 * 대상 함수:
 * - executeOppositeOrder (private static) - 체결 후 즉시 반대 주문 실행
 * - trimBuyOrdersOnInsufficientBalance (private static) - 잔고 부족 시 원거리 매수 주문 정리
 *
 * 두 메서드 모두 private static이므로 (TradingService as any)로 접근한다.
 */

// mock 모듈은 jest.config.ts의 moduleNameMapper로 자동 매핑됨
import prisma, { withRetry } from '../../__mocks__/database';
import { decrypt } from '../../__mocks__/encryption';

// 외부 서비스 mock
jest.mock('../../src/services/upbit.service');
jest.mock('../../src/services/socket.service');
jest.mock('../../src/services/grid.service');
jest.mock('../../src/services/upbit-price-manager');
jest.mock('../../src/services/profit.service');

// mock된 모듈 import
import { UpbitService } from '../../src/services/upbit.service';
import { socketService } from '../../src/services/socket.service';
import { GridService } from '../../src/services/grid.service';
import { TradingService } from '../../src/services/trading.service';

// mock 타입 캐스팅
const mockSocketService = socketService as jest.Mocked<typeof socketService>;
const MockUpbitService = UpbitService as jest.MockedClass<typeof UpbitService>;
const MockGridService = GridService as jest.Mocked<typeof GridService>;

// UpbitService 인스턴스 mock 생성 헬퍼
function createMockUpbit() {
  return {
    sellLimit: jest.fn(),
    buyLimit: jest.fn(),
    cancelOrder: jest.fn(),
    getAccounts: jest.fn(),
    getFilledOrders: jest.fn(),
    getOrder: jest.fn(),
    getOrdersByUuids: jest.fn(),
  } as any;
}

// 기본 봇 정보
const defaultBot = { id: 1, ticker: 'BTC', orderAmount: 100000 };

// 기본 매수 체결 그리드 (sellPrice 있음)
const filledBuyGrid = {
  id: 10,
  type: 'buy',
  sellPrice: 55000000,
  buyPrice: 50000000,
  botId: 1,
};

// 기본 매도 체결 그리드 (buyPrice 있음)
const filledSellGrid = {
  id: 20,
  type: 'sell',
  sellPrice: 55000000,
  buyPrice: 50000000,
  botId: 1,
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
  // setTimeout을 mock하여 즉시 실행 (재시도 테스트용)
  jest.spyOn(global, 'setTimeout').mockImplementation((fn: any) => {
    if (typeof fn === 'function') fn();
    return 0 as any;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('TradingService - chunk-5: executeOppositeOrder, trimBuyOrdersOnInsufficientBalance', () => {
  // ══════════════════════════════════════════════════
  // executeOppositeOrder
  // ══════════════════════════════════════════════════
  describe('executeOppositeOrder', () => {
    // ─── 1. 매수 체결 후 매도 반대 주문 실행 전체 플로우 ───
    it('매수 체결 후 매도 반대 주문 실행 전체 플로우', async () => {
      const mockUpbit = createMockUpbit();
      const sellPrice = filledBuyGrid.sellPrice!;
      const volume = defaultBot.orderAmount / sellPrice;

      // 매도 그리드 레벨 찾기
      prisma.gridLevel.findFirst.mockResolvedValueOnce({
        id: 100,
        price: sellPrice,
        status: 'inactive',
        type: 'sell',
      });

      // 매도 주문 실행
      mockUpbit.sellLimit.mockResolvedValueOnce({ uuid: 'sell-order-uuid' });

      // GridService.updateGridLevel mock
      (GridService.updateGridLevel as jest.Mock).mockResolvedValueOnce(undefined);

      // 거래 기록 생성
      prisma.trade.create.mockResolvedValueOnce({
        id: 200,
        type: 'sell',
        price: sellPrice,
        amount: volume,
        total: defaultBot.orderAmount,
        orderId: 'sell-order-uuid',
        createdAt: new Date(),
      });

      await (TradingService as any).executeOppositeOrder(
        mockUpbit, defaultBot, filledBuyGrid
      );

      // 매도 그리드를 검색했는지 확인
      expect(prisma.gridLevel.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            botId: defaultBot.id,
            type: 'sell',
            status: { in: ['inactive', 'filled'] },
          }),
        })
      );

      // sellLimit 호출 확인
      expect(mockUpbit.sellLimit).toHaveBeenCalledWith(
        defaultBot.ticker, sellPrice, volume
      );

      // GridService.updateGridLevel 호출 확인
      expect(GridService.updateGridLevel).toHaveBeenCalledWith(
        100, 'pending', 'sell-order-uuid'
      );

      // 거래 기록 저장 확인
      expect(prisma.trade.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          botId: defaultBot.id,
          gridLevelId: 100,
          type: 'sell',
          price: sellPrice,
          orderId: 'sell-order-uuid',
        }),
      });

      // 소켓 알림 확인
      expect(mockSocketService.emitNewTrade).toHaveBeenCalledWith(
        defaultBot.id,
        expect.objectContaining({
          id: 200,
          type: 'sell',
          orderId: 'sell-order-uuid',
          status: 'pending',
        })
      );
    });

    // ─── 2. 매도 체결 후 매수 반대 주문 실행 전체 플로우 ───
    it('매도 체결 후 매수 반대 주문 실행 전체 플로우', async () => {
      const mockUpbit = createMockUpbit();
      const buyPrice = filledSellGrid.buyPrice!;
      const volume = defaultBot.orderAmount / buyPrice;

      // 매수 그리드 레벨 찾기 (filled 상태)
      prisma.gridLevel.findFirst.mockResolvedValueOnce({
        id: 101,
        price: buyPrice,
        status: 'filled',
        type: 'buy',
      });

      // 매수 주문 실행
      mockUpbit.buyLimit.mockResolvedValueOnce({ uuid: 'buy-order-uuid' });

      // GridService.updateGridLevel mock
      (GridService.updateGridLevel as jest.Mock).mockResolvedValueOnce(undefined);

      // 거래 기록 생성
      prisma.trade.create.mockResolvedValueOnce({
        id: 201,
        type: 'buy',
        price: buyPrice,
        amount: volume,
        total: defaultBot.orderAmount,
        orderId: 'buy-order-uuid',
        createdAt: new Date(),
      });

      await (TradingService as any).executeOppositeOrder(
        mockUpbit, defaultBot, filledSellGrid
      );

      // 매수 그리드를 검색했는지 확인
      expect(prisma.gridLevel.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            botId: defaultBot.id,
            type: 'buy',
            status: 'filled',
          }),
        })
      );

      // buyLimit 호출 확인
      expect(mockUpbit.buyLimit).toHaveBeenCalledWith(
        defaultBot.ticker, buyPrice, volume
      );

      // GridService.updateGridLevel 호출 확인
      expect(GridService.updateGridLevel).toHaveBeenCalledWith(
        101, 'pending', 'buy-order-uuid'
      );

      // 거래 기록 저장 확인
      expect(prisma.trade.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          botId: defaultBot.id,
          gridLevelId: 101,
          type: 'buy',
          price: buyPrice,
          orderId: 'buy-order-uuid',
        }),
      });

      // 소켓 알림 확인
      expect(mockSocketService.emitNewTrade).toHaveBeenCalledWith(
        defaultBot.id,
        expect.objectContaining({
          id: 201,
          type: 'buy',
          orderId: 'buy-order-uuid',
          status: 'pending',
        })
      );
    });

    // ─── 3. 매수 그리드인데 sellPrice 없으면 즉시 리턴 ───
    it('매수 그리드인데 sellPrice 없으면 즉시 리턴', async () => {
      const mockUpbit = createMockUpbit();
      const gridWithoutSellPrice = {
        id: 10,
        type: 'buy',
        sellPrice: null, // sellPrice 없음
        buyPrice: 50000000,
        botId: 1,
      };

      await (TradingService as any).executeOppositeOrder(
        mockUpbit, defaultBot, gridWithoutSellPrice
      );

      // 어떤 DB 조회도 하지 않음
      expect(prisma.gridLevel.findFirst).not.toHaveBeenCalled();
      expect(prisma.gridLevel.findMany).not.toHaveBeenCalled();
      expect(mockUpbit.sellLimit).not.toHaveBeenCalled();
      expect(mockUpbit.buyLimit).not.toHaveBeenCalled();
    });

    // ─── 4. 매도 그리드인데 buyPrice 없으면 즉시 리턴 ───
    it('매도 그리드인데 buyPrice 없으면 즉시 리턴', async () => {
      const mockUpbit = createMockUpbit();
      const gridWithoutBuyPrice = {
        id: 20,
        type: 'sell',
        sellPrice: 55000000,
        buyPrice: null, // buyPrice 없음
        botId: 1,
      };

      await (TradingService as any).executeOppositeOrder(
        mockUpbit, defaultBot, gridWithoutBuyPrice
      );

      // 어떤 DB 조회도 하지 않음
      expect(prisma.gridLevel.findFirst).not.toHaveBeenCalled();
      expect(prisma.gridLevel.findMany).not.toHaveBeenCalled();
      expect(mockUpbit.sellLimit).not.toHaveBeenCalled();
      expect(mockUpbit.buyLimit).not.toHaveBeenCalled();
    });

    // ─── 5. 매도 그리드 검색 실패 시 리턴 (inactive/filled 상태 없음) ───
    it('매도 그리드 검색 실패 시 리턴 (inactive/filled 상태 없음)', async () => {
      const mockUpbit = createMockUpbit();

      // 매도 그리드 찾기 실패
      prisma.gridLevel.findFirst.mockResolvedValueOnce(null);

      // 디버깅용 모든 매도 그리드 조회
      prisma.gridLevel.findMany.mockResolvedValueOnce([
        { id: 30, price: 55000000, status: 'pending', orderId: 'existing-order' },
      ]);

      await (TradingService as any).executeOppositeOrder(
        mockUpbit, defaultBot, filledBuyGrid
      );

      // 매도 주문이 실행되지 않음
      expect(mockUpbit.sellLimit).not.toHaveBeenCalled();

      // 디버깅용 전체 매도 그리드 조회 확인
      expect(prisma.gridLevel.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            botId: defaultBot.id,
            type: 'sell',
          },
        })
      );
    });

    // ─── 6. 매수 그리드 검색 실패 시 리턴 (filled 상태 없음) ───
    it('매수 그리드 검색 실패 시 리턴 (filled 상태 없음)', async () => {
      const mockUpbit = createMockUpbit();

      // 매수 그리드 찾기 실패
      prisma.gridLevel.findFirst.mockResolvedValueOnce(null);

      // 디버깅용 모든 매수 그리드 조회
      prisma.gridLevel.findMany.mockResolvedValueOnce([
        { id: 31, price: 50000000, status: 'available', orderId: null },
      ]);

      await (TradingService as any).executeOppositeOrder(
        mockUpbit, defaultBot, filledSellGrid
      );

      // 매수 주문이 실행되지 않음
      expect(mockUpbit.buyLimit).not.toHaveBeenCalled();

      // 디버깅용 전체 매수 그리드 조회 확인
      expect(prisma.gridLevel.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            botId: defaultBot.id,
            type: 'buy',
          },
        })
      );
    });

    // ─── 7. 부동소수점 오차 처리 (priceMargin = Math.max(price * 0.001, 0.000001)) ───
    it('부동소수점 오차 처리 (priceMargin = Math.max(price * 0.001, 0.000001))', async () => {
      const mockUpbit = createMockUpbit();

      // 일반 가격대 (55,000,000원) - priceMargin = 55000000 * 0.001 = 55000
      const highPriceGrid = {
        id: 10,
        type: 'buy',
        sellPrice: 55000000,
        buyPrice: 50000000,
        botId: 1,
      };

      prisma.gridLevel.findFirst.mockResolvedValueOnce({
        id: 100, price: 55000000, status: 'inactive', type: 'sell',
      });
      mockUpbit.sellLimit.mockResolvedValueOnce({ uuid: 'uuid-1' });
      (GridService.updateGridLevel as jest.Mock).mockResolvedValueOnce(undefined);
      prisma.trade.create.mockResolvedValueOnce({
        id: 300, createdAt: new Date(),
      });

      await (TradingService as any).executeOppositeOrder(
        mockUpbit, defaultBot, highPriceGrid
      );

      // findFirst에 전달된 가격 범위 확인 (55000000 +/- 55000)
      const firstCallArgs = prisma.gridLevel.findFirst.mock.calls[0][0];
      const priceMarginHigh = Math.max(55000000 * 0.001, 0.000001);
      expect(firstCallArgs.where.price.gte).toBeCloseTo(55000000 - priceMarginHigh, 6);
      expect(firstCallArgs.where.price.lte).toBeCloseTo(55000000 + priceMarginHigh, 6);

      // 저가 코인 (0.001원) - priceMargin = Math.max(0.001 * 0.001, 0.000001) = 0.000001
      jest.clearAllMocks();
      jest.spyOn(global, 'setTimeout').mockImplementation((fn: any) => {
        if (typeof fn === 'function') fn();
        return 0 as any;
      });

      const lowPriceGrid = {
        id: 11,
        type: 'buy',
        sellPrice: 0.001,
        buyPrice: 0.0009,
        botId: 1,
      };

      prisma.gridLevel.findFirst.mockResolvedValueOnce({
        id: 101, price: 0.001, status: 'inactive', type: 'sell',
      });
      mockUpbit.sellLimit.mockResolvedValueOnce({ uuid: 'uuid-2' });
      (GridService.updateGridLevel as jest.Mock).mockResolvedValueOnce(undefined);
      prisma.trade.create.mockResolvedValueOnce({
        id: 301, createdAt: new Date(),
      });

      await (TradingService as any).executeOppositeOrder(
        mockUpbit, defaultBot, lowPriceGrid
      );

      // findFirst에 전달된 가격 범위 확인 (0.001 +/- 0.000001)
      const secondCallArgs = prisma.gridLevel.findFirst.mock.calls[0][0];
      const priceMarginLow = Math.max(0.001 * 0.001, 0.000001);
      expect(priceMarginLow).toBe(0.000001);
      expect(secondCallArgs.where.price.gte).toBeCloseTo(0.001 - priceMarginLow, 10);
      expect(secondCallArgs.where.price.lte).toBeCloseTo(0.001 + priceMarginLow, 10);
    });

    // ─── 8. 비잔고 에러 시 점진적 재시도 (5초, 10초, 15초) ───
    it('비잔고 에러 시 점진적 재시도 (5초, 10초, 15초)', async () => {
      const mockUpbit = createMockUpbit();
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation((fn: any) => {
        if (typeof fn === 'function') fn();
        return 0 as any;
      });

      // 매도 그리드 찾기: 매번 성공
      prisma.gridLevel.findFirst.mockResolvedValue({
        id: 100, price: 55000000, status: 'inactive', type: 'sell',
      });

      // sellLimit: 계속 실패 (비잔고가 아닌 일반 에러 -> 재시도 대상)
      // retryCount 0,1,2,3 총 4번 호출되며 모두 실패
      mockUpbit.sellLimit.mockRejectedValue(new Error('network timeout'));

      // 최대 재시도 초과 시 에러 저장 mock
      prisma.bot.update.mockResolvedValue({});

      await (TradingService as any).executeOppositeOrder(
        mockUpbit, defaultBot, filledBuyGrid
      );

      // sellLimit이 총 4번 호출됨 (최초 1번 + 재시도 3번)
      expect(mockUpbit.sellLimit).toHaveBeenCalledTimes(4);

      // setTimeout이 점진적 지연으로 호출됨 (5초, 10초, 15초)
      // 재시도 지연 시간이 있는 호출만 필터링
      const delayCalls = setTimeoutSpy.mock.calls.filter(
        call => typeof call[1] === 'number' && call[1] >= 5000
      );
      expect(delayCalls).toHaveLength(3);
      expect(delayCalls[0][1]).toBe(5000);  // retryCount=0 -> delay=5000*(0+1)=5초
      expect(delayCalls[1][1]).toBe(10000); // retryCount=1 -> delay=5000*(1+1)=10초
      expect(delayCalls[2][1]).toBe(15000); // retryCount=2 -> delay=5000*(2+1)=15초
    });

    // ─── 9. 최대 재시도(3회) 초과 시 에러 저장 및 소켓 알림 ───
    it('최대 재시도(3회) 초과 시 에러 저장 및 소켓 알림', async () => {
      const mockUpbit = createMockUpbit();

      // 매도 그리드 찾기: 매번 성공
      prisma.gridLevel.findFirst.mockResolvedValue({
        id: 100, price: 55000000, status: 'inactive', type: 'sell',
      });

      // sellLimit: 계속 실패 (일반 에러 - 재시도 대상)
      mockUpbit.sellLimit.mockRejectedValue(new Error('unknown server error'));

      // bot.update mock
      prisma.bot.update.mockResolvedValue({});

      await (TradingService as any).executeOppositeOrder(
        mockUpbit, defaultBot, filledBuyGrid
      );

      // 총 4번 시도 (최초 1번 + 재시도 3번)
      expect(mockUpbit.sellLimit).toHaveBeenCalledTimes(4);

      // 최종 에러 저장 확인
      expect(prisma.bot.update).toHaveBeenCalledWith({
        where: { id: defaultBot.id },
        data: { errorMessage: expect.stringContaining('반대 주문 실패') },
      });

      // 소켓 에러 알림 확인
      expect(mockSocketService.emitError).toHaveBeenCalledWith(
        defaultBot.id,
        expect.objectContaining({
          type: 'order_failed',
          message: expect.stringContaining('반대 주문 실패'),
        })
      );
    });

    // ─── 10. 잔고 부족 에러(매도->매수) 시 trimBuyOrdersOnInsufficientBalance 호출 ───
    it('잔고 부족 에러(매도->매수) 시 trimBuyOrdersOnInsufficientBalance 호출', async () => {
      const mockUpbit = createMockUpbit();

      // 매수 그리드 찾기 성공
      prisma.gridLevel.findFirst.mockResolvedValue({
        id: 101, price: 50000000, status: 'filled', type: 'buy',
      });

      // buyLimit: 잔고 부족 에러 (매도 체결 후 매수 주문 실행 시)
      mockUpbit.buyLimit.mockRejectedValue(new Error('잔고가 부족합니다'));

      // trimBuyOrdersOnInsufficientBalance를 spy하여 호출 확인
      const trimSpy = jest.spyOn(TradingService as any, 'trimBuyOrdersOnInsufficientBalance')
        .mockResolvedValueOnce({ cancelled: 0, kept: 5 });

      // bot.update mock (에러 저장용)
      prisma.bot.update.mockResolvedValue({});

      await (TradingService as any).executeOppositeOrder(
        mockUpbit, defaultBot, filledSellGrid
      );

      // trimBuyOrdersOnInsufficientBalance가 호출됨
      expect(trimSpy).toHaveBeenCalledWith(
        mockUpbit,
        defaultBot.id,
        defaultBot.ticker,
        7 // keepCount 기본값
      );

      trimSpy.mockRestore();
    });

    // ─── 11. 주문 정리 후 cancelled>0이면 1회 재시도 ───
    it('주문 정리 후 cancelled>0이면 1회 재시도', async () => {
      const mockUpbit = createMockUpbit();

      // 매수 그리드 찾기 성공 (재시도 포함하여 여러 번 호출)
      prisma.gridLevel.findFirst.mockResolvedValue({
        id: 101, price: 50000000, status: 'filled', type: 'buy',
      });

      // 첫 번째 시도: 잔고 부족 에러
      // 두 번째 시도 (재시도): 성공
      mockUpbit.buyLimit
        .mockRejectedValueOnce(new Error('insufficient balance'))
        .mockResolvedValueOnce({ uuid: 'retry-buy-uuid' });

      // trimBuyOrdersOnInsufficientBalance: cancelled > 0
      const trimSpy = jest.spyOn(TradingService as any, 'trimBuyOrdersOnInsufficientBalance')
        .mockResolvedValueOnce({ cancelled: 3, kept: 7 });

      // GridService.updateGridLevel mock
      (GridService.updateGridLevel as jest.Mock).mockResolvedValue(undefined);

      // 거래 기록 생성 mock
      prisma.trade.create.mockResolvedValue({
        id: 500, createdAt: new Date(),
      });

      await (TradingService as any).executeOppositeOrder(
        mockUpbit, defaultBot, filledSellGrid
      );

      // trim이 호출됨
      expect(trimSpy).toHaveBeenCalledTimes(1);

      // 재시도로 buyLimit이 총 2번 호출됨 (최초 1번 + 재시도 1번)
      expect(mockUpbit.buyLimit).toHaveBeenCalledTimes(2);

      trimSpy.mockRestore();
    });

    // ─── 12. 주문 정리 후 cancelled=0이면 에러 저장 ───
    it('주문 정리 후 cancelled=0이면 에러 저장', async () => {
      const mockUpbit = createMockUpbit();

      // 매수 그리드 찾기 성공
      prisma.gridLevel.findFirst.mockResolvedValue({
        id: 101, price: 50000000, status: 'filled', type: 'buy',
      });

      // buyLimit: 잔고 부족 에러
      mockUpbit.buyLimit.mockRejectedValue(new Error('잔고가 부족합니다'));

      // trimBuyOrdersOnInsufficientBalance: cancelled = 0 (정리할 주문 없음)
      const trimSpy = jest.spyOn(TradingService as any, 'trimBuyOrdersOnInsufficientBalance')
        .mockResolvedValueOnce({ cancelled: 0, kept: 3 });

      // bot.update mock
      prisma.bot.update.mockResolvedValue({});

      await (TradingService as any).executeOppositeOrder(
        mockUpbit, defaultBot, filledSellGrid
      );

      // trim이 호출됨
      expect(trimSpy).toHaveBeenCalledTimes(1);

      // 에러 메시지 저장 (정리할 주문 없음 메시지 포함)
      expect(prisma.bot.update).toHaveBeenCalledWith({
        where: { id: defaultBot.id },
        data: {
          errorMessage: expect.stringContaining('정리할 주문 없음'),
        },
      });

      // 재시도하지 않음 (buyLimit은 1번만 호출)
      expect(mockUpbit.buyLimit).toHaveBeenCalledTimes(1);

      trimSpy.mockRestore();
    });
  });

  // ══════════════════════════════════════════════════
  // trimBuyOrdersOnInsufficientBalance
  // ══════════════════════════════════════════════════
  describe('trimBuyOrdersOnInsufficientBalance', () => {
    // ─── 13. 정상 동작: 현재가 기준 가까운 N개 유지, 나머지 취소 ───
    it('정상 동작: 현재가 기준 가까운 N개 유지, 나머지 취소', async () => {
      const mockUpbit = createMockUpbit();
      const botId = 1;
      const ticker = 'BTC';
      const keepCount = 3;

      // 현재가 조회 (UpbitService.getCurrentPrice는 static 메서드)
      (UpbitService.getCurrentPrice as jest.Mock).mockResolvedValueOnce({
        trade_price: 50000000,
      });

      // 미체결 매수 주문 조회 (5개, keepCount=3이므로 2개 취소)
      const pendingBuyGrids = [
        { id: 1, price: 49500000, status: 'pending', orderId: 'order-1', type: 'buy' },
        { id: 2, price: 49000000, status: 'pending', orderId: 'order-2', type: 'buy' },
        { id: 3, price: 48500000, status: 'pending', orderId: 'order-3', type: 'buy' },
        { id: 4, price: 47000000, status: 'pending', orderId: 'order-4', type: 'buy' },
        { id: 5, price: 45000000, status: 'pending', orderId: 'order-5', type: 'buy' },
      ];
      prisma.gridLevel.findMany.mockResolvedValueOnce(pendingBuyGrids);

      // 주문 취소 성공
      mockUpbit.cancelOrder.mockResolvedValue(undefined);

      // 그리드 상태 업데이트
      prisma.gridLevel.update.mockResolvedValue({});

      // 에러 메시지 제거
      prisma.bot.update.mockResolvedValue({});

      const result = await (TradingService as any).trimBuyOrdersOnInsufficientBalance(
        mockUpbit, botId, ticker, keepCount
      );

      // 현재가 조회 확인
      expect(UpbitService.getCurrentPrice).toHaveBeenCalledWith('KRW-BTC');

      // 현재가(50,000,000)에서 가까운 3개 유지: 49,500,000, 49,000,000, 48,500,000
      // 원거리 2개 취소: 47,000,000, 45,000,000
      expect(mockUpbit.cancelOrder).toHaveBeenCalledTimes(2);
      expect(mockUpbit.cancelOrder).toHaveBeenCalledWith('order-4');
      expect(mockUpbit.cancelOrder).toHaveBeenCalledWith('order-5');

      // 그리드 상태를 inactive로 변경
      expect(prisma.gridLevel.update).toHaveBeenCalledTimes(2);

      // 결과 확인
      expect(result).toEqual({ cancelled: 2, kept: 3 });

      // 에러 메시지 제거 확인
      expect(prisma.bot.update).toHaveBeenCalledWith({
        where: { id: botId },
        data: { errorMessage: null },
      });

      // 소켓 알림 확인
      expect(mockSocketService.emitError).toHaveBeenCalledWith(
        botId,
        expect.objectContaining({
          type: 'system_error',
          message: expect.stringContaining('2개 취소'),
        })
      );
    });

    // ─── 14. 미체결 매수 주문이 keepCount 이하면 정리 불필요 ───
    it('미체결 매수 주문이 keepCount 이하면 정리 불필요', async () => {
      const mockUpbit = createMockUpbit();
      const botId = 1;
      const ticker = 'BTC';
      const keepCount = 7;

      // 현재가 조회
      (UpbitService.getCurrentPrice as jest.Mock).mockResolvedValueOnce({
        trade_price: 50000000,
      });

      // 미체결 매수 주문: 5개 (keepCount 7 이하)
      prisma.gridLevel.findMany.mockResolvedValueOnce([
        { id: 1, price: 49500000, status: 'pending', orderId: 'order-1', type: 'buy' },
        { id: 2, price: 49000000, status: 'pending', orderId: 'order-2', type: 'buy' },
        { id: 3, price: 48500000, status: 'pending', orderId: 'order-3', type: 'buy' },
        { id: 4, price: 48000000, status: 'pending', orderId: 'order-4', type: 'buy' },
        { id: 5, price: 47500000, status: 'pending', orderId: 'order-5', type: 'buy' },
      ]);

      const result = await (TradingService as any).trimBuyOrdersOnInsufficientBalance(
        mockUpbit, botId, ticker, keepCount
      );

      // 취소된 주문 없음
      expect(mockUpbit.cancelOrder).not.toHaveBeenCalled();
      expect(result).toEqual({ cancelled: 0, kept: 5 });
    });

    // ─── 15. 개별 주문 취소 실패 시 에러 로깅 후 계속 ───
    it('개별 주문 취소 실패 시 에러 로깅 후 계속', async () => {
      const mockUpbit = createMockUpbit();
      const botId = 1;
      const ticker = 'BTC';
      const keepCount = 2;

      // 현재가 조회
      (UpbitService.getCurrentPrice as jest.Mock).mockResolvedValueOnce({
        trade_price: 50000000,
      });

      // 미체결 매수 주문 4개 (keepCount=2이므로 2개 취소)
      prisma.gridLevel.findMany.mockResolvedValueOnce([
        { id: 1, price: 49500000, status: 'pending', orderId: 'order-1', type: 'buy' },
        { id: 2, price: 49000000, status: 'pending', orderId: 'order-2', type: 'buy' },
        { id: 3, price: 47000000, status: 'pending', orderId: 'order-3', type: 'buy' },
        { id: 4, price: 45000000, status: 'pending', orderId: 'order-4', type: 'buy' },
      ]);

      // 첫 번째 취소 실패, 두 번째 취소 성공
      mockUpbit.cancelOrder
        .mockRejectedValueOnce(new Error('order not found'))
        .mockResolvedValueOnce(undefined);

      // 그리드 상태 업데이트 (성공한 것만)
      prisma.gridLevel.update.mockResolvedValue({});
      prisma.bot.update.mockResolvedValue({});

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      const result = await (TradingService as any).trimBuyOrdersOnInsufficientBalance(
        mockUpbit, botId, ticker, keepCount
      );

      // 두 건 모두 취소 시도함
      expect(mockUpbit.cancelOrder).toHaveBeenCalledTimes(2);

      // 실패한 주문에 대해 에러 로깅 (단일 문자열 인수)
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('주문 취소 실패')
      );

      // 성공한 1건만 cancelled에 포함
      expect(result).toEqual({ cancelled: 1, kept: 2 });

      consoleSpy.mockRestore();
    });

    // ─── 16. 취소 성공 시 에러 메시지 제거 및 소켓 알림 ───
    it('취소 성공 시 에러 메시지 제거 및 소켓 알림', async () => {
      const mockUpbit = createMockUpbit();
      const botId = 1;
      const ticker = 'BTC';
      const keepCount = 1;

      // 현재가 조회
      (UpbitService.getCurrentPrice as jest.Mock).mockResolvedValueOnce({
        trade_price: 50000000,
      });

      // 미체결 매수 주문 3개 (keepCount=1이므로 2개 취소)
      prisma.gridLevel.findMany.mockResolvedValueOnce([
        { id: 1, price: 49500000, status: 'pending', orderId: 'order-1', type: 'buy' },
        { id: 2, price: 48000000, status: 'pending', orderId: 'order-2', type: 'buy' },
        { id: 3, price: 46000000, status: 'pending', orderId: 'order-3', type: 'buy' },
      ]);

      // 주문 취소 성공
      mockUpbit.cancelOrder.mockResolvedValue(undefined);
      prisma.gridLevel.update.mockResolvedValue({});
      prisma.bot.update.mockResolvedValue({});

      const result = await (TradingService as any).trimBuyOrdersOnInsufficientBalance(
        mockUpbit, botId, ticker, keepCount
      );

      expect(result.cancelled).toBe(2);

      // 에러 메시지 제거 (errorMessage: null)
      expect(prisma.bot.update).toHaveBeenCalledWith({
        where: { id: botId },
        data: { errorMessage: null },
      });

      // 소켓으로 정리 완료 알림
      expect(mockSocketService.emitError).toHaveBeenCalledWith(
        botId,
        expect.objectContaining({
          type: 'system_error',
          message: expect.stringContaining('2개 취소'),
        })
      );
    });

    // ─── 17. 전체 예외 발생 시 { cancelled: 0, kept: 0 } 반환 ───
    it('전체 예외 발생 시 { cancelled: 0, kept: 0 } 반환', async () => {
      const mockUpbit = createMockUpbit();
      const botId = 1;
      const ticker = 'BTC';

      // 현재가 조회에서 예외 발생
      (UpbitService.getCurrentPrice as jest.Mock).mockRejectedValueOnce(
        new Error('API connection failed')
      );

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      const result = await (TradingService as any).trimBuyOrdersOnInsufficientBalance(
        mockUpbit, botId, ticker
      );

      // 기본 반환값
      expect(result).toEqual({ cancelled: 0, kept: 0 });

      // 에러 로깅 확인 (단일 문자열 인수)
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('매수 주문 정리 실패')
      );

      consoleSpy.mockRestore();
    });
  });
});
