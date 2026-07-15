// Prisma 클라이언트 Mock
const prisma = {
  // BTC LTH regime 스냅샷 테이블
  btcDormantSnapshot: {
    count: jest.fn(),
    createMany: jest.fn(),
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
  crossExchangeSnapshot: {
    createMany: jest.fn().mockResolvedValue({ count: 5 }),
  },
  bot: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
  },
  gridLevel: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    create: jest.fn(),
    count: jest.fn(),
    groupBy: jest.fn(),
  },
  trade: {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  credential: {
    findFirst: jest.fn(),
  },
  user: {
    findUnique: jest.fn(),
  },
  // 업비트/빗썸 신규상장 announcement 테이블 (source enum으로 구분)
  upbitListingAnnouncement: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  // 업비트 KRW 마켓 캐시 — listing-auto-trader가 false-positive 차단 시 조회
  upbitKnownMarket: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    createMany: jest.fn(),
  },
  // 신규상장 자동매수 설정 (source @unique — UPBIT/BITHUMB 별 1 row)
  listingAutoTradeConfig: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
  // 신규상장 자동매수 주문 기록 (source enum 필드)
  listingAutoOrder: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
};

// Stablecoin Prisma 클라이언트 Mock
const stablecoinPrisma = {
  stablecoinArbBot: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  stablecoinArbOpportunity: {
    count: jest.fn(),
    findMany: jest.fn(),
  },
  makerTakerSimBot: {
    findMany: jest.fn(),
    findFirst: jest.fn(),     // PR H — patchMakerBot prev row 조회
    findUnique: jest.fn(),    // PR H — reconcileBotAssets bot 조회
    update: jest.fn(),        // PR H — patchMakerBot 업데이트
    create: jest.fn(),
  },
  makerTakerSimTrade: {
    findMany: jest.fn(),
    findFirst: jest.fn(),     // PR H — pending trade 조회
    count: jest.fn(),         // PR H — reconcileBotAssets pending count
    groupBy: jest.fn(),
    aggregate: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  arbAutoConfig: {
    findFirst: jest.fn().mockResolvedValue({
      crossBotMinSpreadBps: 50,
      crossBotDailyCountLimit: 5,
      crossBotDailyLossLimitKrw: 50000,
    }),
  },
  crossExchangeArbBot: {
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    create: jest.fn().mockResolvedValue({}),
    findFirst: jest.fn().mockResolvedValue(null),
  },
  crossExchangeArbTrade: {
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    count: jest.fn().mockResolvedValue(0),
    aggregate: jest.fn().mockResolvedValue({ _sum: { profitKrw: 0 } }),
  },
};

// withRetry: 전달된 함수를 그냥 실행 (재시도 없이)
export const withRetry = jest.fn(async <T>(operation: () => Promise<T>) => {
  return operation();
});

export default prisma;
export { prisma, stablecoinPrisma };
