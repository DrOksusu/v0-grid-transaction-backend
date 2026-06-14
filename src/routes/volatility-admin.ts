import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import { requireAdmin } from '../middlewares/requireAdmin';
import {
  listBots,
  createBot,
  updateBot,
  deleteBot,
  listTrades,
  backtest,
} from '../controllers/volatility-admin.controller';

const router = Router();

// 모든 엔드포인트: JWT 인증 + 관리자 전용
router.use(authenticate);
router.use(requireAdmin);

router.get('/bots', listBots);
router.post('/bots', createBot);
router.put('/bots/:id', updateBot);
router.delete('/bots/:id', deleteBot);
router.get('/bots/:id/trades', listTrades);
router.post('/backtest', backtest);

export default router;
