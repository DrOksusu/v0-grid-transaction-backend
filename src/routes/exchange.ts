import { Router } from 'express';
import {
  getTickers,
  getPrice,
  validateCredentials,
} from '../controllers/exchange.controller';
import { authenticate } from '../middlewares/auth';

const router = Router();

// 공개 API - 인증 불필요
router.get('/tickers/:exchange', getTickers);
router.get('/price/:exchange/:ticker', getPrice);

// 인증 필요한 API
router.post('/validate-credentials', authenticate, validateCredentials);

export default router;
