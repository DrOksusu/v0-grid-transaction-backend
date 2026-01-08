import { PrismaClient } from '@prisma/client';

const isProduction = process.env.NODE_ENV === 'production';

// Prisma 클라이언트 싱글톤 패턴 (Hot reload 대응)
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    // 프로덕션에서는 에러와 경고만, 개발에서는 쿼리도 로깅
    log: isProduction ? ['warn', 'error'] : ['query', 'info', 'warn', 'error'],
    // 데이터소스 설정 (connection pool은 DATABASE_URL에서 관리)
    datasources: {
      db: {
        url: process.env.DATABASE_URL,
      },
    },
  });

if (!isProduction) globalForPrisma.prisma = prisma;

// 연결 상태 확인 및 재연결 헬퍼
export const ensureConnection = async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    console.error('[Prisma] Connection check failed, attempting reconnect:', error);
    await prisma.$disconnect();
    await prisma.$connect();
    return true;
  }
};

// Graceful shutdown
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});

export default prisma;
