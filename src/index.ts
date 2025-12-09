import { createServer } from 'http';
import app from './app';
import { config } from './config/env';
import prisma from './config/database';
import { botEngine } from './services/bot-engine.service';
import { socketService } from './services/socket.service';
import { infiniteBuyScheduler } from './services/infinite-buy-scheduler.service';

const startServer = async () => {
  try {
    await prisma.$connect();
    console.log('Database connected successfully');

    // HTTP 서버 생성
    const httpServer = createServer(app);

    // Socket.IO 초기화
    socketService.initialize(httpServer);

    httpServer.listen(config.port, () => {
      console.log(`Server is running on port ${config.port}`);
      console.log(`Environment: ${config.nodeEnv}`);

      // 프로덕션 환경에서만 스케줄러 시작 (중복 주문 방지)
      if (config.nodeEnv === 'production') {
        // 봇 엔진 시작
        botEngine.start();
        console.log('Bot trading engine started');

        // 무한매수법 스케줄러 시작
        infiniteBuyScheduler.start();
        console.log('Infinite buy scheduler started');
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
  botEngine.stop();
  infiniteBuyScheduler.stop();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  botEngine.stop();
  infiniteBuyScheduler.stop();
  await prisma.$disconnect();
  process.exit(0);
});
