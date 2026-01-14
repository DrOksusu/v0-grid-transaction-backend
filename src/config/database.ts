import { PrismaClient } from '@prisma/client';

const isProduction = process.env.NODE_ENV === 'production';

// Connection pool 디버깅용 카운터 (메트릭 서비스에서 참조)
export const poolStats = {
  totalQueries: 0,
  slowQueries: 0,  // 100ms 이상
  verySlowQueries: 0,  // 500ms 이상
  lastQueryTime: 0,
  avgQueryTime: 0,
  queryTimes: [] as number[],  // 최근 20개 쿼리 시간 저장
};

// Prisma 클라이언트 싱글톤 패턴 (Hot reload 대응)
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    // 쿼리 이벤트 로깅 활성화
    log: [
      { level: 'query', emit: 'event' },
      { level: 'warn', emit: 'stdout' },
      { level: 'error', emit: 'stdout' },
    ],
    // 데이터소스 설정 (connection pool은 DATABASE_URL에서 관리)
    datasources: {
      db: {
        url: process.env.DATABASE_URL,
      },
    },
  });

// 쿼리 이벤트 리스너 - connection pool 디버깅
(prisma.$on as any)('query', (e: any) => {
  const duration = e.duration as number;

  poolStats.totalQueries++;
  poolStats.lastQueryTime = duration;

  // 최근 20개 쿼리 시간 유지
  poolStats.queryTimes.push(duration);
  if (poolStats.queryTimes.length > 20) {
    poolStats.queryTimes.shift();
  }
  poolStats.avgQueryTime = Math.round(
    poolStats.queryTimes.reduce((a, b) => a + b, 0) / poolStats.queryTimes.length
  );

  if (duration >= 500) {
    poolStats.verySlowQueries++;
    console.log(`[Prisma] 🐢 매우 느린 쿼리 (${duration}ms): ${e.query.substring(0, 100)}...`);
  } else if (duration >= 100) {
    poolStats.slowQueries++;
    console.log(`[Prisma] 🐌 느린 쿼리 (${duration}ms): ${e.query.substring(0, 80)}...`);
  }
});

// Connection pool 상태 출력 함수
export const logPoolStats = () => {
  console.log(`[Prisma Pool] 총 쿼리: ${poolStats.totalQueries}, 느린(100ms+): ${poolStats.slowQueries}, 매우느린(500ms+): ${poolStats.verySlowQueries}, 평균: ${poolStats.avgQueryTime}ms, 최근: ${poolStats.lastQueryTime}ms`);
};

// 10초마다 pool 상태 출력
setInterval(() => {
  if (poolStats.totalQueries > 0) {
    logPoolStats();
  }
}, 10000);

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
