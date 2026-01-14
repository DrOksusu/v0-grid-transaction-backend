import { createServer } from 'http';
import app from './app';
import { config } from './config/env';
import prisma, { logPoolStats, poolStats } from './config/database';
import { botEngine } from './services/bot-engine.service';
import { socketService } from './services/socket.service';
import { infiniteBuyScheduler } from './services/infinite-buy-scheduler.service';
import { whaleAlertService } from './services/whale-alert.service';
import { metricsService } from './services/metrics.service';

const startServer = async () => {
  try {
    await prisma.$connect();
    console.log('Database connected successfully');

    // Connection pool 워밍업 - 병렬 쿼리로 여러 연결 미리 생성
    console.log('[Prisma] Connection pool 워밍업 시작...');
    const warmupStart = Date.now();

    // 개별 쿼리 시간 측정
    const warmupQuery = async (id: number) => {
      const start = Date.now();
      await prisma.$queryRaw`SELECT 1`;
      const duration = Date.now() - start;
      console.log(`[Prisma] 워밍업 쿼리 #${id}: ${duration}ms`);
      return duration;
    };

    const warmupResults = await Promise.all([
      warmupQuery(1),
      warmupQuery(2),
      warmupQuery(3),
      warmupQuery(4),
      warmupQuery(5),
    ]);

    const totalWarmup = Date.now() - warmupStart;
    const maxWarmup = Math.max(...warmupResults);
    const minWarmup = Math.min(...warmupResults);
    console.log(`[Prisma] 워밍업 완료 - 총: ${totalWarmup}ms, 최소: ${minWarmup}ms, 최대: ${maxWarmup}ms`);

    // 순차 쿼리 테스트 (connection reuse 확인)
    console.log('[Prisma] Connection reuse 테스트...');
    for (let i = 1; i <= 3; i++) {
      const start = Date.now();
      await prisma.$queryRaw`SELECT 1`;
      console.log(`[Prisma] 순차 쿼리 #${i}: ${Date.now() - start}ms`);
    }

    // Connection keep-alive: 5분마다 연결 유지 (MySQL wait_timeout 대응)
    setInterval(async () => {
      try {
        const start = Date.now();
        await prisma.$queryRaw`SELECT 1`;
        console.log(`[Prisma] Keep-alive ping: ${Date.now() - start}ms`);
        logPoolStats();
      } catch (error) {
        console.error('[Prisma] Keep-alive ping failed:', error);
      }
    }, 5 * 60 * 1000); // 5분

    // HTTP 서버 생성
    const httpServer = createServer(app);

    // Socket.IO 초기화
    socketService.initialize(httpServer);

    httpServer.listen(config.port, () => {
      console.log(`Server is running on port ${config.port}`);
      console.log(`Environment: ${config.nodeEnv}`);

      // 메트릭 서비스 시작 (모든 환경)
      metricsService.start(poolStats);
      console.log('Metrics service started');

      // 프로덕션 환경에서만 스케줄러 시작 (중복 주문 방지)
      if (config.nodeEnv === 'production') {
        // 봇 엔진 시작
        botEngine.start();
        console.log('Bot trading engine started');

        // 무한매수법 스케줄러 시작
        infiniteBuyScheduler.start();
        console.log('Infinite buy scheduler started');

        // 고래 알림 서비스 시작
        whaleAlertService.start();
      } else {
        console.log('⚠️  Development mode: Schedulers disabled to prevent duplicate orders');
        console.log('   To enable schedulers, set NODE_ENV=production');
      }
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

process.on('SIGINT', async () => {
  metricsService.stop();
  botEngine.stop();
  infiniteBuyScheduler.stop();
  whaleAlertService.stop();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  metricsService.stop();
  botEngine.stop();
  infiniteBuyScheduler.stop();
  whaleAlertService.stop();
  await prisma.$disconnect();
  process.exit(0);
});
