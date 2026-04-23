import { PrismaClient } from '@prisma/client';
// 스테이블코인 아비트리지 전용 별도 DB client (grid_stablecoin_arb)
// prisma-stablecoin/schema.prisma에서 생성됨
import { PrismaClient as StablecoinPrismaClient } from '.prisma/client-stablecoin';

const isProduction = process.env.NODE_ENV === 'production';

// 느린 쿼리 상세 정보 타입
interface SlowQueryInfo {
  query: string;
  duration: number;
  timestamp: Date;
  params?: string;
}

// Connection pool 디버깅용 카운터 (메트릭 서비스에서 참조)
export const poolStats = {
  totalQueries: 0,
  slowQueries: 0,  // 100ms 이상
  verySlowQueries: 0,  // 500ms 이상
  lastQueryTime: 0,
  avgQueryTime: 0,
  queryTimes: [] as number[],  // 최근 20개 쿼리 시간 저장
  slowQueryDetails: [] as SlowQueryInfo[],  // 최근 50개 느린 쿼리 상세
  verySlowQueryDetails: [] as SlowQueryInfo[],  // 최근 50개 매우 느린 쿼리 상세
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
    const queryInfo: SlowQueryInfo = {
      query: e.query,
      duration,
      timestamp: new Date(),
      params: e.params,
    };
    poolStats.verySlowQueryDetails.push(queryInfo);
    if (poolStats.verySlowQueryDetails.length > 50) {
      poolStats.verySlowQueryDetails.shift();
    }
    console.log(`[Prisma] 🐢 매우 느린 쿼리 (${duration}ms): ${e.query.substring(0, 200)}`);
    console.log(`[Prisma] 🐢 파라미터: ${e.params}`);
  } else if (duration >= 100) {
    poolStats.slowQueries++;
    const queryInfo: SlowQueryInfo = {
      query: e.query,
      duration,
      timestamp: new Date(),
      params: e.params,
    };
    poolStats.slowQueryDetails.push(queryInfo);
    if (poolStats.slowQueryDetails.length > 50) {
      poolStats.slowQueryDetails.shift();
    }
    console.log(`[Prisma] 🐌 느린 쿼리 (${duration}ms): ${e.query.substring(0, 150)}`);
  }
});

// Connection pool 상태 출력 함수
export const logPoolStats = () => {
  console.log(`[Prisma Pool] 총 쿼리: ${poolStats.totalQueries}, 느린(100ms+): ${poolStats.slowQueries}, 매우느린(500ms+): ${poolStats.verySlowQueries}, 평균: ${poolStats.avgQueryTime}ms, 최근: ${poolStats.lastQueryTime}ms`);
};

// 느린 쿼리 분석 리포트 출력
export const getSlowQueryReport = () => {
  console.log('\n========== 느린 쿼리 분석 리포트 ==========');
  console.log(`총 쿼리: ${poolStats.totalQueries}`);
  console.log(`느린 쿼리 (100ms+): ${poolStats.slowQueries} (${((poolStats.slowQueries / poolStats.totalQueries) * 100).toFixed(4)}%)`);
  console.log(`매우 느린 쿼리 (500ms+): ${poolStats.verySlowQueries} (${((poolStats.verySlowQueries / poolStats.totalQueries) * 100).toFixed(4)}%)`);

  if (poolStats.verySlowQueryDetails.length > 0) {
    console.log('\n--- 최근 매우 느린 쿼리 TOP 10 (500ms+) ---');
    const top10 = [...poolStats.verySlowQueryDetails]
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 10);
    top10.forEach((q, i) => {
      console.log(`\n${i + 1}. [${q.duration}ms] ${q.timestamp.toISOString()}`);
      console.log(`   쿼리: ${q.query}`);
      if (q.params) console.log(`   파라미터: ${q.params}`);
    });
  }

  console.log('\n==========================================\n');

  return {
    totalQueries: poolStats.totalQueries,
    slowQueries: poolStats.slowQueries,
    verySlowQueries: poolStats.verySlowQueries,
    slowQueryDetails: poolStats.slowQueryDetails,
    verySlowQueryDetails: poolStats.verySlowQueryDetails,
  };
};

// 10초마다 pool 상태 출력
setInterval(() => {
  if (poolStats.totalQueries > 0) {
    logPoolStats();
  }
}, 10000);

if (!isProduction) globalForPrisma.prisma = prisma;

// Stablecoin arbitrage DB client (별도 database: grid_stablecoin_arb)
// 싱글톤 패턴 + HMR 대응
const globalForStablecoinPrisma = globalThis as unknown as {
  stablecoinPrisma: StablecoinPrismaClient | undefined;
};

export const stablecoinPrisma =
  globalForStablecoinPrisma.stablecoinPrisma ??
  new StablecoinPrismaClient({
    log: [
      { level: 'warn', emit: 'stdout' },
      { level: 'error', emit: 'stdout' },
    ],
    datasources: {
      db: {
        url: process.env.STABLECOIN_DATABASE_URL,
      },
    },
  });

if (!isProduction) globalForStablecoinPrisma.stablecoinPrisma = stablecoinPrisma;

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
  await Promise.allSettled([
    prisma.$disconnect(),
    stablecoinPrisma.$disconnect(),
  ]);
});

// Connection pool 타임아웃 에러 감지
const isPoolTimeoutError = (error: any): boolean => {
  const message = error?.message || '';
  return message.includes('Timed out fetching a new connection from the connection pool') ||
         message.includes('Connection pool timeout') ||
         error?.code === 'P2024';
};

// 재시도 가능한 Prisma 쿼리 래퍼
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: { maxRetries?: number; delayMs?: number; operationName?: string } = {}
): Promise<T> {
  const { maxRetries = 3, delayMs = 1000, operationName = 'DB 작업' } = options;
  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;

      if (isPoolTimeoutError(error)) {
        console.warn(`[Prisma Retry] ${operationName} 연결 풀 타임아웃 (시도 ${attempt}/${maxRetries})`);

        if (attempt < maxRetries) {
          const delay = delayMs * attempt; // 지수 백오프
          console.log(`[Prisma Retry] ${delay}ms 후 재시도...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }

      // 연결 풀 에러가 아니거나 최대 재시도 초과 시 에러 throw
      throw error;
    }
  }

  throw lastError;
}

export default prisma;
