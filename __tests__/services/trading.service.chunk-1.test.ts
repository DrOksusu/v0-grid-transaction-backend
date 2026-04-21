/**
 * TradingService chunk-1 테스트: 캐시 및 자격증명 관리
 *
 * 대상 함수:
 * - clearLastCheckedPrice (public static)
 * - getUserCredential (private static)
 * - getCachedCredential (private static)
 * - getCachedBotInfo (private static)
 *
 * 모듈 레벨 Map(캐시)에 직접 접근할 수 없으므로,
 * 테스트 격리를 위해 매 테스트마다 모듈을 재로딩한다.
 * jest.resetModules() 후 동적 import 시 mock 인스턴스도 함께 재생성되므로,
 * loadTradingService()에서 mock 참조도 함께 갱신한다.
 */

// trading.service.ts 가 import하는 서비스 모듈들을 mock 처리
// (database, encryption은 moduleNameMapper로 자동 매핑됨)
jest.mock('../../src/services/upbit.service', () => ({
  UpbitService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../src/services/grid.service', () => ({
  GridService: { findExecutableGrids: jest.fn(), updateGridLevel: jest.fn() },
}));
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
  priceManager: { getPriceWithFallback: jest.fn() },
}));
jest.mock('../../src/services/profit.service', () => ({
  ProfitService: { recordProfit: jest.fn() },
}));

// 매 테스트에서 갱신될 mock 참조
let prisma: any;
let withRetry: jest.Mock;
let decrypt: jest.Mock;
let TradingService: any;

beforeEach(() => {
  jest.clearAllMocks();
  // 모듈 캐시 초기화 → 모듈 레벨 Map(캐시) 인스턴스 리셋
  jest.resetModules();
});

/**
 * 모듈을 동적으로 import하여 TradingService와 mock 참조를 갱신한다.
 * beforeEach에서 jest.resetModules()를 호출하므로 매번 새로운 모듈이 로드된다.
 *
 * 중요: trading.service.ts 내부가 참조하는 mock 인스턴스와 동일한 것을 사용하기 위해,
 *       moduleNameMapper가 매핑하는 동일 경로(__mocks__/)에서 import한다.
 */
async function loadTradingService() {
  // mock 모듈 재로딩 (trading.service.ts와 같은 인스턴스 참조)
  const dbMock = await import('../../__mocks__/database');
  prisma = dbMock.default;
  withRetry = dbMock.withRetry as jest.Mock;

  const encMock = await import('../../__mocks__/encryption');
  decrypt = encMock.decrypt as jest.Mock;

  // TradingService 로드
  const mod = await import('../../src/services/trading.service');
  TradingService = mod.TradingService;
  return TradingService;
}

describe('TradingService - chunk-1: 캐시 및 자격증명 관리', () => {
  // ──────────────────────────────────────────────
  // clearLastCheckedPrice
  // ──────────────────────────────────────────────
  describe('clearLastCheckedPrice', () => {
    it('lastCheckedPriceMap과 balanceErrorCooldownMap에서 botId를 삭제한다', async () => {
      await loadTradingService();

      // clearLastCheckedPrice는 lastCheckedPriceMap.delete(botId)와
      // balanceErrorCooldownMap.delete(botId)를 호출한다.
      // Map.delete는 키 존재 여부와 무관하게 에러를 던지지 않으므로,
      // 호출 자체가 정상적으로 완료되는지 확인한다.
      expect(() => TradingService.clearLastCheckedPrice(1)).not.toThrow();

      // 두 번 호출해도 문제 없음 (이미 삭제된 상태에서 다시 삭제 시도)
      expect(() => TradingService.clearLastCheckedPrice(1)).not.toThrow();
    });

    it('존재하지 않는 botId로 호출해도 에러가 발생하지 않는다', async () => {
      await loadTradingService();

      // 한 번도 등록되지 않은 다양한 botId 값
      expect(() => TradingService.clearLastCheckedPrice(99999)).not.toThrow();
      expect(() => TradingService.clearLastCheckedPrice(-1)).not.toThrow();
      expect(() => TradingService.clearLastCheckedPrice(0)).not.toThrow();
    });
  });

  // ──────────────────────────────────────────────
  // getUserCredential
  // ──────────────────────────────────────────────
  describe('getUserCredential', () => {
    it('캐시 히트 시 DB 조회 없이 캐시된 값을 반환한다', async () => {
      await loadTradingService();

      // 첫 번째 호출: DB에서 조회 → userCredentialCache에 저장
      prisma.credential.findFirst.mockResolvedValueOnce({
        apiKey: 'encrypted_test-api-key',
        secretKey: 'encrypted_test-secret-key',
      });

      const result1 = await (TradingService as any).getUserCredential(1);
      expect(result1).toEqual({
        apiKey: 'test-api-key',
        secretKey: 'test-secret-key',
      });
      expect(prisma.credential.findFirst).toHaveBeenCalledTimes(1);

      // 두 번째 호출: 캐시에서 반환 → DB 조회 안 함
      const result2 = await (TradingService as any).getUserCredential(1);
      expect(result2).toEqual({
        apiKey: 'test-api-key',
        secretKey: 'test-secret-key',
      });
      // DB 호출 횟수는 여전히 1번 (캐시 히트)
      expect(prisma.credential.findFirst).toHaveBeenCalledTimes(1);
    });

    it('캐시 미스 시 DB에서 조회 후 캐시에 저장한다', async () => {
      await loadTradingService();

      prisma.credential.findFirst.mockResolvedValueOnce({
        apiKey: 'encrypted_my-api-key',
        secretKey: 'encrypted_my-secret-key',
      });

      const result = await (TradingService as any).getUserCredential(42);

      // DB 조회가 올바른 파라미터로 호출됨
      expect(prisma.credential.findFirst).toHaveBeenCalledWith({
        where: { userId: 42, exchange: 'upbit' },
        select: { apiKey: true, secretKey: true },
      });

      // decrypt가 apiKey, secretKey에 대해 각각 호출됨
      expect(decrypt).toHaveBeenCalledWith('encrypted_my-api-key');
      expect(decrypt).toHaveBeenCalledWith('encrypted_my-secret-key');

      // 복호화된 결과 반환
      expect(result).toEqual({
        apiKey: 'my-api-key',
        secretKey: 'my-secret-key',
      });

      // 같은 userId로 다시 호출하면 캐시에서 반환 (DB 조회 안 함)
      const result2 = await (TradingService as any).getUserCredential(42);
      expect(result2).toEqual({
        apiKey: 'my-api-key',
        secretKey: 'my-secret-key',
      });
      expect(prisma.credential.findFirst).toHaveBeenCalledTimes(1);
    });

    it('캐시 만료 시 DB에서 재조회한다', async () => {
      await loadTradingService();

      // 첫 번째 호출: 캐시 저장
      prisma.credential.findFirst.mockResolvedValueOnce({
        apiKey: 'encrypted_key-v1',
        secretKey: 'encrypted_secret-v1',
      });

      await (TradingService as any).getUserCredential(10);
      expect(prisma.credential.findFirst).toHaveBeenCalledTimes(1);

      // 시간을 5분 + 1초 후로 이동하여 캐시 만료 시뮬레이션
      const originalDateNow = Date.now;
      const frozenNow = originalDateNow();
      Date.now = jest.fn(() => frozenNow + 5 * 60 * 1000 + 1000);

      try {
        // 두 번째 호출: 캐시 만료(expireAt < now) → DB 재조회
        prisma.credential.findFirst.mockResolvedValueOnce({
          apiKey: 'encrypted_key-v2',
          secretKey: 'encrypted_secret-v2',
        });

        const result = await (TradingService as any).getUserCredential(10);
        expect(prisma.credential.findFirst).toHaveBeenCalledTimes(2);
        expect(result).toEqual({
          apiKey: 'key-v2',
          secretKey: 'secret-v2',
        });
      } finally {
        // Date.now 복원 (에러 발생 시에도 반드시 복원)
        Date.now = originalDateNow;
      }
    });

    it('DB에 자격증명이 없으면 null을 반환한다', async () => {
      await loadTradingService();

      prisma.credential.findFirst.mockResolvedValueOnce(null);

      const result = await (TradingService as any).getUserCredential(999);
      expect(result).toBeNull();
      expect(prisma.credential.findFirst).toHaveBeenCalledTimes(1);
      // decrypt는 호출되지 않아야 함
      expect(decrypt).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────
  // getCachedCredential
  // ──────────────────────────────────────────────
  describe('getCachedCredential', () => {
    // getCachedCredential에서 DB 조회 시 반환되는 봇 데이터 형태
    const mockBotWithCredentials = {
      id: 1,
      userId: 100,
      ticker: 'KRW-BTC',
      orderAmount: 10000,
      user: {
        credentials: [
          {
            apiKey: 'encrypted_bot-api-key',
            secretKey: 'encrypted_bot-secret-key',
          },
        ],
      },
    };

    it('봇/자격증명 캐시 모두 히트 시 DB 조회 없이 즉시 반환한다', async () => {
      await loadTradingService();

      // 첫 번째 호출: DB에서 조회 → credentialCache + botInfoCache 저장
      prisma.bot.findUnique.mockResolvedValueOnce(mockBotWithCredentials);

      const result1 = await (TradingService as any).getCachedCredential(1);
      expect(result1).toEqual({
        apiKey: 'bot-api-key',
        secretKey: 'bot-secret-key',
        userId: 100,
      });
      expect(withRetry).toHaveBeenCalledTimes(1);

      // 두 번째 호출: 양쪽 캐시 모두 유효 → withRetry/DB 조회 안 함
      const result2 = await (TradingService as any).getCachedCredential(1);
      expect(result2).toEqual({
        apiKey: 'bot-api-key',
        secretKey: 'bot-secret-key',
        userId: 100,
      });
      // withRetry는 첫 번째 호출에서만 사용됨
      expect(withRetry).toHaveBeenCalledTimes(1);
    });

    it('캐시 미스 시 withRetry로 DB 조회 후 양쪽 캐시에 저장한다', async () => {
      await loadTradingService();

      prisma.bot.findUnique.mockResolvedValueOnce(mockBotWithCredentials);

      const result = await (TradingService as any).getCachedCredential(1);

      // withRetry가 올바른 operationName으로 호출됨
      expect(withRetry).toHaveBeenCalledTimes(1);
      expect(withRetry).toHaveBeenCalledWith(
        expect.any(Function),
        { operationName: 'getCachedCredential(botId=1)' },
      );

      // prisma.bot.findUnique가 user.credentials include와 함께 호출됨
      expect(prisma.bot.findUnique).toHaveBeenCalledWith({
        where: { id: 1 },
        include: {
          user: {
            include: {
              credentials: {
                where: { exchange: 'upbit' },
                select: { apiKey: true, secretKey: true },
              },
            },
          },
        },
      });

      // decrypt가 apiKey, secretKey 각각에 대해 호출됨
      expect(decrypt).toHaveBeenCalledWith('encrypted_bot-api-key');
      expect(decrypt).toHaveBeenCalledWith('encrypted_bot-secret-key');

      // 결과 검증
      expect(result).toEqual({
        apiKey: 'bot-api-key',
        secretKey: 'bot-secret-key',
        userId: 100,
      });

      // 캐시 저장 확인: 두 번째 호출 시 DB 조회 없음
      const result2 = await (TradingService as any).getCachedCredential(1);
      expect(result2).toEqual(result);
      expect(withRetry).toHaveBeenCalledTimes(1); // 추가 호출 없음
    });

    it('봇이 없거나 credentials 배열이 비어있으면 null을 반환한다', async () => {
      await loadTradingService();

      // 케이스 1: 봇이 DB에 존재하지 않는 경우 (withRetry가 null 반환)
      prisma.bot.findUnique.mockResolvedValueOnce(null);

      const result1 = await (TradingService as any).getCachedCredential(1);
      expect(result1).toBeNull();

      // 케이스 2: 봇은 있지만 credentials 배열이 비어있는 경우
      prisma.bot.findUnique.mockResolvedValueOnce({
        id: 2,
        userId: 200,
        ticker: 'KRW-ETH',
        orderAmount: 5000,
        user: {
          credentials: [], // 빈 배열 — upbit 자격증명이 설정되지 않음
        },
      });

      const result2 = await (TradingService as any).getCachedCredential(2);
      expect(result2).toBeNull();

      // 두 케이스 모두 decrypt는 호출되지 않음
      expect(decrypt).not.toHaveBeenCalled();
    });

    it('자격증명 캐시만 만료됐을 때 DB에서 재조회한다', async () => {
      await loadTradingService();

      const originalDateNow = Date.now;
      const baseTime = originalDateNow();

      // Date.now를 고정하여 캐시 TTL을 정밀하게 제어
      Date.now = jest.fn(() => baseTime);

      try {
        // 첫 번째 호출: DB에서 조회 → credentialCache(5분 TTL) + botInfoCache(1분 TTL) 저장
        prisma.bot.findUnique.mockResolvedValueOnce(mockBotWithCredentials);

        await (TradingService as any).getCachedCredential(1);
        expect(withRetry).toHaveBeenCalledTimes(1);

        // 시간을 1분 + 1초 후로 이동
        // - botInfoCache TTL(1분) 만료 → 캐시 미스 조건 충족
        // - credentialCache TTL(5분)은 아직 유효하지만,
        //   getCachedCredential은 두 캐시 모두 유효해야 캐시 히트이므로 DB 재조회 발생
        Date.now = jest.fn(() => baseTime + 61 * 1000);

        prisma.bot.findUnique.mockResolvedValueOnce({
          ...mockBotWithCredentials,
          user: {
            credentials: [
              {
                apiKey: 'encrypted_new-api-key',
                secretKey: 'encrypted_new-secret-key',
              },
            ],
          },
        });

        const result = await (TradingService as any).getCachedCredential(1);
        // 두 번째 withRetry 호출 발생
        expect(withRetry).toHaveBeenCalledTimes(2);
        expect(result).toEqual({
          apiKey: 'new-api-key',
          secretKey: 'new-secret-key',
          userId: 100,
        });
      } finally {
        Date.now = originalDateNow;
      }
    });
  });

  // ──────────────────────────────────────────────
  // getCachedBotInfo
  // ──────────────────────────────────────────────
  describe('getCachedBotInfo', () => {
    const mockBot = {
      userId: 100,
      ticker: 'KRW-BTC',
      orderAmount: 50000,
    };

    it('캐시 히트 시 DB 조회 없이 캐시된 값을 반환한다', async () => {
      await loadTradingService();

      // 첫 번째 호출: DB에서 조회 → botInfoCache에 저장
      prisma.bot.findUnique.mockResolvedValueOnce(mockBot);

      const result1 = await (TradingService as any).getCachedBotInfo(5);
      expect(result1).toMatchObject({
        userId: 100,
        ticker: 'KRW-BTC',
        orderAmount: 50000,
      });
      // expireAt이 현재 시점보다 미래여야 함 (TTL이 설정됨)
      expect(result1.expireAt).toBeGreaterThan(Date.now());
      expect(withRetry).toHaveBeenCalledTimes(1);

      // 두 번째 호출: 캐시 히트 → withRetry/DB 조회 안 함
      const result2 = await (TradingService as any).getCachedBotInfo(5);
      expect(result2).toMatchObject({
        userId: 100,
        ticker: 'KRW-BTC',
        orderAmount: 50000,
      });
      // withRetry 추가 호출 없음
      expect(withRetry).toHaveBeenCalledTimes(1);
    });

    it('캐시 미스 시 withRetry로 DB 조회 후 캐시에 저장한다', async () => {
      await loadTradingService();

      prisma.bot.findUnique.mockResolvedValueOnce(mockBot);

      const result = await (TradingService as any).getCachedBotInfo(7);

      // withRetry가 올바른 operationName으로 호출됨
      expect(withRetry).toHaveBeenCalledWith(
        expect.any(Function),
        { operationName: 'getCachedBotInfo(botId=7)' },
      );

      // prisma.bot.findUnique가 올바른 select 파라미터로 호출됨
      expect(prisma.bot.findUnique).toHaveBeenCalledWith({
        where: { id: 7 },
        select: { userId: true, ticker: true, orderAmount: true },
      });

      // 결과에 원본 데이터 + expireAt이 포함됨
      expect(result).toMatchObject({
        userId: 100,
        ticker: 'KRW-BTC',
        orderAmount: 50000,
      });
      expect(result.expireAt).toBeDefined();
      expect(result.expireAt).toBeGreaterThan(Date.now());

      // 캐시 저장 확인: 두 번째 호출 시 withRetry 추가 호출 없음
      const result2 = await (TradingService as any).getCachedBotInfo(7);
      expect(result2).toEqual(result);
      expect(withRetry).toHaveBeenCalledTimes(1);
    });

    it('봇이 존재하지 않으면 null을 반환한다', async () => {
      await loadTradingService();

      prisma.bot.findUnique.mockResolvedValueOnce(null);

      const result = await (TradingService as any).getCachedBotInfo(999);
      expect(result).toBeNull();
      expect(withRetry).toHaveBeenCalledTimes(1);
    });
  });
});
