import express, { Express } from 'express';
import cors from 'cors';
import { errorHandler } from './middlewares/errorHandler';
import routes from './routes';

const app: Express = express();

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

app.use('/api', routes);

app.use(errorHandler);

export default app;
