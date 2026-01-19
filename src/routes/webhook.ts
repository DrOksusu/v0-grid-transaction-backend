/**
 * Webhook 라우트
 *
 * Stripe Webhook은 raw body가 필요하므로 별도 라우터로 분리
 */

import { Router } from 'express';
import { handleStripeWebhook } from '../controllers/webhook.controller';

const router = Router();

// Stripe Webhook
// Note: raw body 파싱은 app.ts에서 별도 처리
router.post('/stripe', handleStripeWebhook);

export default router;
