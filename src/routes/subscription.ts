/**
 * 구독 라우트
 *
 * USDT 결제만 지원
 */

import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import {
  getPlans,
  getCurrentPlan,
  getBotUsage,
} from '../controllers/subscription.controller';

const router = Router();

// 플랜 정보 (공개)
router.get('/plans', getPlans);

// 인증 필요
router.get('/current', authenticate, getCurrentPlan);
router.get('/usage', authenticate, getBotUsage);

export default router;
