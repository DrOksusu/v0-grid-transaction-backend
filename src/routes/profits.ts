import { Router } from 'express';
import {
  getProfitSummary,
  getMonthlyProfits,
  getMonthlyDetails,
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

// 특정 월 상세 수익 (봇별)
router.get('/monthly/:month', getMonthlyDetails);

// 삭제된 봇 성과 목록
router.get('/deleted-bots', getDeletedBots);

export default router;
