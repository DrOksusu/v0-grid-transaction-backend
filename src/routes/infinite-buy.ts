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
  getSchedulerDiagnostics,
  getSchedulerLogs,
  triggerManualBuy,
  triggerPriceCheck,
  triggerOrderCheck,
  updateSchedulerConfig,
  // 무한매수전략1 API
  executeStrategy1Buy,
  executeStrategy1Sell,
  getStrategy1Status,
  updateStockStrategy,
  // VR (밸류 리밸런싱) API
  initializeVR,
  getVRStatus,
  generateVROrders,
  executeVRCycle,
  syncVROrders,
  updateVRSettings,
  // 계좌 잔고 API
  getAccountBalance,
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
router.get('/scheduler/diagnostics', getSchedulerDiagnostics);  // 진단 API
router.get('/scheduler/logs', getSchedulerLogs);  // 로그 조회 API
router.post('/scheduler/trigger-buy', triggerManualBuy);
router.post('/scheduler/trigger-price-check', triggerPriceCheck);
router.post('/scheduler/trigger-order-check', triggerOrderCheck);  // 체결 확인 트리거
router.put('/scheduler/config', updateSchedulerConfig);

// =====================
// 무한매수전략1 API
// =====================
// 전략 변경
router.put('/stocks/:id/strategy', updateStockStrategy);

// 전략1 상태 조회 (다음 매수/매도 가격 등)
router.get('/stocks/:id/strategy1/status', getStrategy1Status);

// 전략1 매수 실행 (LOC 주문)
router.post('/stocks/:id/strategy1/buy', executeStrategy1Buy);

// 전략1 매도 실행 (LOC + 지정가)
router.post('/stocks/:id/strategy1/sell', executeStrategy1Sell);

// =====================
// VR (밸류 리밸런싱) API
// =====================
// VR 초기화
router.post('/stocks/:id/vr/init', initializeVR);

// VR 상태 조회
router.get('/stocks/:id/vr/status', getVRStatus);

// VR 주문 생성
router.post('/stocks/:id/vr/orders', generateVROrders);

// VR 사이클 수동 실행
router.post('/stocks/:id/vr/cycle', executeVRCycle);

// VR 체결 동기화
router.post('/stocks/:id/vr/sync', syncVROrders);

// VR 설정 변경
router.put('/stocks/:id/vr/settings', updateVRSettings);

// =====================
// 계좌 잔고 API
// =====================
router.get('/balance', getAccountBalance);

export default router;
