import { Router } from 'express';
import {
  getProfitSummary,
  getMonthlyProfits,
  getDeletedBots,
} from '../controllers/profit.controller';
import { authenticate } from '../middlewares/auth';

const router = Router();

// 인증 필요
router.use(authenticate);

// 수익 요약 조회
router.get('/summary', getProfitSummary);

// 월별 수익 목록
router.get('/monthly', getMonthlyProfits);

// 삭제된 봇 성과 목록
router.get('/deleted-bots', getDeletedBots);

export default router;
