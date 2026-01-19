/**
 * Stripe 서비스 (Placeholder)
 *
 * Stripe 결제는 추후 구현 예정
 * 현재는 USDT 결제만 지원
 */

import { PlanType } from '../config/plans';

export class StripeService {
  /**
   * Stripe 사용 가능 여부
   */
  isEnabled(): boolean {
    return false; // Stripe 미구현
  }

  /**
   * Price에서 플랜 타입 추출 (placeholder)
   */
  getPlanFromPriceId(priceId: string): PlanType {
    return 'free';
  }
}

export const stripeService = new StripeService();
