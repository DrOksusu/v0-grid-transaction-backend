// 카카오 OAuth + BTC RSI 관리자 라우트
// Base path: /admin/btc-rsi (src/routes/index.ts에서 마운트)
import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import { requireAdmin } from '../middlewares/requireAdmin';
import {
  getAuthUrl,
  handleCallback,
  getStatus,
  getAlertHistory,
  sendTestMessage,
  runRsiCheck,
  sendDailyReportNow,
} from '../controllers/kakao-admin.controller';

const router = Router();

// OAuth 콜백은 인증 없이 (카카오에서 리다이렉트되므로)
router.get('/kakao/callback', handleCallback);

// 나머지는 관리자 인증 필요
router.use(authenticate);
router.use(requireAdmin);

router.get('/kakao/auth-url', getAuthUrl);
router.get('/kakao/status', getStatus);
router.get('/rsi/history', getAlertHistory);
router.post('/kakao/test', sendTestMessage);
router.post('/kakao/daily-report', sendDailyReportNow);
router.post('/rsi/check', runRsiCheck);

export default router;
