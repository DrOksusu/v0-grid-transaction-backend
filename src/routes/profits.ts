import { Router } from 'express';
import {
  getProfitSummary,
  getMonthlyProfits,
  getMonthlyDetails,
  getDeletedBots,
  getMonthlyRanking,
  getInfiniteBuyRanking,
  getRankingUserDetail,
} from '../controllers/profit.controller';
import { authenticate } from '../middlewares/auth';

const router = Router();

// 인증 필요
router.use(authenticate);

// 수익 요약 조회
router.get('/summary', getProfitSummary);

// 그리드 매매 수익 랭킹
router.get('/ranking', getMonthlyRanking);

// 랭킹 사용자 상세 조회 (종목별 수익)
router.get('/ranking/user', getRankingUserDetail);

// 무한매수 수익 랭킹
router.get('/ranking/infinite-buy', getInfiniteBuyRanking);

// 월별 수익 목록
router.get('/monthly', getMonthlyProfits);

// 특정 월 상세 수익 (봇별)
router.get('/monthly/:month', getMonthlyDetails);

// 삭제된 봇 성과 목록
router.get('/deleted-bots', getDeletedBots);

export default router;
