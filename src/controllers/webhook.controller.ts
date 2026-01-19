/**
 * Webhook 컨트롤러 (Placeholder)
 *
 * Stripe webhook은 추후 구현 예정
 * 현재는 USDT 결제만 지원
 */

import { Request, Response } from 'express';

/**
 * Stripe Webhook 처리 (미구현)
 */
export const handleStripeWebhook = async (req: Request, res: Response) => {
  console.log('[Webhook] Stripe webhook not implemented. Use USDT payment instead.');
  res.status(200).json({ received: true, message: 'Stripe not implemented' });
};
