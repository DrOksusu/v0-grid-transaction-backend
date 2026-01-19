/**
 * 구독 서비스
 *
 * 사용자 구독 상태 관리 및 플랜 제한 체크
 */

import prisma from '../config/database';
import { stripeService } from './stripe.service';
import { PLAN_LIMITS, PlanType, BotType } from '../config/plans';
import { SubscriptionPlan, SubscriptionStatus } from '@prisma/client';

export interface BotUsage {
  grid: { current: number; limit: number };
  infiniteBuy: { current: number; limit: number };
  vr: { current: number; limit: number };
}

export interface SubscriptionInfo {
  plan: PlanType;
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  stripeCustomerId: string | null;
}

class SubscriptionService {
  /**
   * 사용자 구독 정보 조회 (없으면 생성)
   */
  async getOrCreateSubscription(userId: number, email: string) {
    let subscription = await prisma.subscription.findUnique({
      where: { userId },
    });

    if (!subscription) {
      // Stripe Customer 생성
      const customer = await stripeService.createCustomer(email, userId);

      // 구독 레코드 생성 (Free 플랜)
      subscription = await prisma.subscription.create({
        data: {
          userId,
          stripeCustomerId: customer.id,
          plan: 'free',
          status: 'active',
        },
      });
    }

    return subscription;
  }

  /**
   * 사용자 구독 정보 조회
   */
  async getSubscription(userId: number) {
    return prisma.subscription.findUnique({
      where: { userId },
    });
  }

  /**
   * 사용자 플랜 조회
   */
  async getUserPlan(userId: number): Promise<PlanType> {
    const subscription = await this.getSubscription(userId);

    if (!subscription) {
      return 'free';
    }

    // 구독이 활성 상태가 아니면 free
    if (subscription.status !== 'active' && subscription.status !== 'trialing') {
      return 'free';
    }

    return subscription.plan as PlanType;
  }

  /**
   * 봇 사용량 조회
   */
  async getBotUsage(userId: number): Promise<BotUsage> {
    const plan = await this.getUserPlan(userId);
    const limits = PLAN_LIMITS[plan];

    // 그리드 봇 수
    const gridCount = await prisma.bot.count({
      where: { userId },
    });

    // 무한매수 봇 수 (VR 제외)
    const infiniteBuyCount = await prisma.infiniteBuyStock.count({
      where: {
        userId,
        strategy: { not: 'vr' },
      },
    });

    // VR 봇 수
    const vrCount = await prisma.infiniteBuyStock.count({
      where: {
        userId,
        strategy: 'vr',
      },
    });

    return {
      grid: {
        current: gridCount,
        limit: limits.grid === Infinity ? -1 : limits.grid,
      },
      infiniteBuy: {
        current: infiniteBuyCount,
        limit: limits.infiniteBuy === Infinity ? -1 : limits.infiniteBuy,
      },
      vr: {
        current: vrCount,
        limit: limits.vr === Infinity ? -1 : limits.vr,
      },
    };
  }

  /**
   * 봇 생성 가능 여부 확인
   */
  async canCreateBot(userId: number, botType: BotType): Promise<boolean> {
    const plan = await this.getUserPlan(userId);
    const limits = PLAN_LIMITS[plan];
    const limit = limits[botType];

    // 무제한인 경우
    if (limit === Infinity) {
      return true;
    }

    // 현재 봇 수 조회
    let currentCount = 0;

    if (botType === 'grid') {
      currentCount = await prisma.bot.count({
        where: { userId },
      });
    } else if (botType === 'infiniteBuy') {
      currentCount = await prisma.infiniteBuyStock.count({
        where: {
          userId,
          strategy: { not: 'vr' },
        },
      });
    } else if (botType === 'vr') {
      currentCount = await prisma.infiniteBuyStock.count({
        where: {
          userId,
          strategy: 'vr',
        },
      });
    }

    return currentCount < limit;
  }

  /**
   * Stripe 구독 상태 동기화
   */
  async syncFromStripe(
    userId: number,
    stripeSubscription: {
      id: string;
      status: string;
      current_period_start: number;
      current_period_end: number;
      cancel_at_period_end: boolean;
      items: { data: Array<{ price: { id: string } }> };
    }
  ) {
    const priceId = stripeSubscription.items.data[0]?.price?.id;
    const plan = stripeService.getPlanFromPriceId(priceId || '');

    // Stripe 상태를 우리 상태로 매핑
    let status: SubscriptionStatus = 'active';
    if (stripeSubscription.status === 'canceled') {
      status = 'canceled';
    } else if (stripeSubscription.status === 'past_due') {
      status = 'past_due';
    } else if (stripeSubscription.status === 'trialing') {
      status = 'trialing';
    }

    return prisma.subscription.update({
      where: { userId },
      data: {
        stripeSubscriptionId: stripeSubscription.id,
        stripePriceId: priceId,
        plan: plan as SubscriptionPlan,
        status,
        currentPeriodStart: new Date(stripeSubscription.current_period_start * 1000),
        currentPeriodEnd: new Date(stripeSubscription.current_period_end * 1000),
        cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end,
      },
    });
  }

  /**
   * 구독 취소 시 Free로 복귀
   */
  async downgradeToFree(userId: number) {
    return prisma.subscription.update({
      where: { userId },
      data: {
        stripeSubscriptionId: null,
        stripePriceId: null,
        plan: 'free',
        status: 'active',
        currentPeriodStart: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      },
    });
  }

  /**
   * 구독 정보 상세 조회
   */
  async getSubscriptionInfo(userId: number): Promise<SubscriptionInfo | null> {
    const subscription = await this.getSubscription(userId);

    if (!subscription) {
      return null;
    }

    return {
      plan: subscription.plan as PlanType,
      status: subscription.status,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      stripeCustomerId: subscription.stripeCustomerId,
    };
  }
}

export const subscriptionService = new SubscriptionService();
