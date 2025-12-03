import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import {
  createStock,
  getStocks,
  getStock,
  updateStock,
  deleteStock,
  executeBuy,
  executeSell,
  stopStock,
  resumeStock,
  getRecords,
  getHistory,
  getTodaySchedule,
  getSummary,
  getSchedulerStatus,
  triggerManualBuy,
  triggerPriceCheck,
  updateSchedulerConfig,
} from '../controllers/infinite-buy.controller';

const router = Router();

// 모든 라우트에 인증 필요
router.use(authenticate);

// 대시보드 요약 정보
router.get('/summary', getSummary);

// 오늘의 매수 예정
router.get('/today', getTodaySchedule);

// 전체 히스토리
router.get('/history', getHistory);

// 종목 CRUD
router.post('/stocks', createStock);
router.get('/stocks', getStocks);
router.get('/stocks/:id', getStock);
router.put('/stocks/:id', updateStock);
router.delete('/stocks/:id', deleteStock);

// 종목 액션
router.post('/stocks/:id/buy', executeBuy);
router.post('/stocks/:id/sell', executeSell);
router.post('/stocks/:id/stop', stopStock);
router.post('/stocks/:id/resume', resumeStock);

// 종목별 기록
router.get('/stocks/:id/records', getRecords);

// 스케줄러 제어
router.get('/scheduler/status', getSchedulerStatus);
router.post('/scheduler/trigger-buy', triggerManualBuy);
router.post('/scheduler/trigger-price-check', triggerPriceCheck);
router.put('/scheduler/config', updateSchedulerConfig);

export default router;
