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
  },
  makerTakerSimTrade: {
    findMany: jest.fn(),
    groupBy: jest.fn(),
    aggregate: jest.fn(),
  },
};

// withRetry: 전달된 함수를 그냥 실행 (재시도 없이)
export const withRetry = jest.fn(async <T>(operation: () => Promise<T>) => {
  return operation();
});

export default prisma;
export { prisma, stablecoinPrisma };
