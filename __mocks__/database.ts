// Prisma 클라이언트 Mock
const prisma = {
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
