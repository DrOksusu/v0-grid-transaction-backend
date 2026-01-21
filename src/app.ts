import express, { Express } from 'express';
import cors from 'cors';
import { errorHandler } from './middlewares/errorHandler';
import { metricsMiddleware } from './middlewares/metrics.middleware';
import routes from './routes';

const app: Express = express();

// 프록시 뒤에서 실행 시 (Railway, Vercel 등) X-Forwarded-For 헤더 신뢰
app.set('trust proxy', 1);

// CORS 설정: 쉼표로 구분된 여러 도메인 허용
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000,http://localhost:3009,https://v0-grid-transaction.vercel.app')
  .split(',')
  .map(origin => origin.trim());

// Vercel 프리뷰 URL 패턴
const vercelPreviewPattern = /^https:\/\/v0-grid-transaction.*\.vercel\.app$/;

app.use(cors({
  origin: (origin, callback) => {
    // origin이 없는 경우 (같은 origin 또는 서버 간 요청)
    if (!origin) return callback(null, true);

    // 정확히 일치하는 도메인 또는 Vercel 프리뷰 URL 패턴 허용
    if (allowedOrigins.includes(origin) || vercelPreviewPattern.test(origin)) {
      callback(null, true);
    } else {
      console.log(`[CORS] Blocked origin: ${origin}`);
      callback(new Error('CORS not allowed'));
    }
  },
  credentials: true,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 메트릭 수집 미들웨어 (라우트 전에 위치)
app.use(metricsMiddleware);

app.use('/api', routes);

app.use(errorHandler);

export default app;
