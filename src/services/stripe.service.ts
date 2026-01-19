/**
 * Stripe 서비스
 *
 * Stripe API와의 통신을 담당
 */

import Stripe from 'stripe';
import { config } from '../config/env';
import { PlanType } from '../config/plans';

// Stripe 클라이언트 초기화 (키가 없으면 null)
const stripe = config.stripe.secretKey
  ? new Stripe(config.stripe.secretKey, {
      apiVersion: '2025-12-15.clover',
    })
  : null;

// Stripe 사용 가능 여부 확인
const ensureStripe = (): Stripe => {
  if (!stripe) {
    throw new Error('Stripe is not configured. Please set STRIPE_SECRET_KEY in environment variables.');
  }
  return stripe;
};

export class StripeService {
  /**
   * Stripe Customer 생성
   */
  async createCustomer(email: string, userId: number): Promise<Stripe.Customer> {
    return ensureStripe().customers.create({
      email,
      metadata: {
        userId: userId.toString(),
      },
    });
  }

  /**
   * Stripe Customer 조회
   */
  async getCustomer(customerId: string): Promise<Stripe.Customer | null> {
    try {
      const customer = await ensureStripe().customers.retrieve(customerId);
      if (customer.deleted) return null;
      return customer as Stripe.Customer;
    } catch {
      return null;
    }
  }

  /**
   * Stripe Price ID 조회
   */
  getPriceId(plan: 'pro' | 'premium', interval: 'month' | 'year'): string {
    const prices = config.stripe.prices;

    if (plan === 'pro') {
      return interval === 'month' ? prices.proMonthly : prices.proYearly;
    } else {
      return interval === 'month' ? prices.premiumMonthly : prices.premiumYearly;
    }
  }

  /**
   * Checkout Session 생성
   */
  async createCheckoutSession(
    customerId: string,
    priceId: string,
    userId: number
  ): Promise<Stripe.Checkout.Session> {
    return ensureStripe().checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: config.stripe.successUrl,
      cancel_url: config.stripe.cancelUrl,
      metadata: {
        userId: userId.toString(),
      },
      subscription_data: {
        metadata: {
          userId: userId.toString(),
        },
      },
      locale: 'ko',
    });
  }

  /**
   * Billing Portal Session 생성 (구독 관리)
   */
  async createBillingPortalSession(customerId: string): Promise<Stripe.BillingPortal.Session> {
    return ensureStripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: config.stripe.successUrl.split('?')[0], // settings 페이지로 리턴
    });
  }

  /**
   * 구독 조회
   */
  async getSubscription(subscriptionId: string): Promise<Stripe.Subscription | null> {
    try {
      return await ensureStripe().subscriptions.retrieve(subscriptionId);
    } catch {
      return null;
    }
  }

  /**
   * 구독 취소 (기간 종료 시)
   */
  async cancelSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    return ensureStripe().subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });
  }

  /**
   * 구독 즉시 취소
   */
  async cancelSubscriptionImmediately(subscriptionId: string): Promise<Stripe.Subscription> {
    return ensureStripe().subscriptions.cancel(subscriptionId);
  }

  /**
   * 구독 재활성화 (취소 예정 상태에서)
   */
  async reactivateSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    return ensureStripe().subscriptions.update(subscriptionId, {
      cancel_at_period_end: false,
    });
  }

  /**
   * Price에서 플랜 타입 추출
   */
  getPlanFromPriceId(priceId: string): PlanType {
    const prices = config.stripe.prices;

    if (priceId === prices.proMonthly || priceId === prices.proYearly) {
      return 'pro';
    } else if (priceId === prices.premiumMonthly || priceId === prices.premiumYearly) {
      return 'premium';
    }

    return 'free';
  }

  /**
   * Webhook 이벤트 검증
   */
  constructWebhookEvent(payload: Buffer, signature: string): Stripe.Event {
    return ensureStripe().webhooks.constructEvent(
      payload,
      signature,
      config.stripe.webhookSecret
    );
  }
}

export const stripeService = new StripeService();
