/**
 * 구독 라우트
 */

import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import {
  getPlans,
  getCurrentPlan,
  getBotUsage,
  createCheckoutSession,
  createBillingPortal,
  cancelSubscription,
  reactivateSubscription,
} from '../controllers/subscription.controller';

const router = Router();

// 플랜 정보 (공개)
router.get('/plans', getPlans);

// 인증 필요
router.get('/current', authenticate, getCurrentPlan);
router.get('/usage', authenticate, getBotUsage);
router.post('/checkout', authenticate, createCheckoutSession);
router.post('/portal', authenticate, createBillingPortal);
router.post('/cancel', authenticate, cancelSubscription);
router.post('/reactivate', authenticate, reactivateSubscription);

export default router;
