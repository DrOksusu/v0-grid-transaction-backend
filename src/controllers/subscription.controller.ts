/**
 * 구독 컨트롤러
 */

import { Response } from 'express';
import { AuthRequest } from '../types';
import { subscriptionService } from '../services/subscription.service';
import { stripeService } from '../services/stripe.service';
import { PLAN_FEATURES, PLAN_PRICES } from '../config/plans';
import { successResponse, errorResponse } from '../utils/response';
import prisma from '../config/database';

/**
 * 플랜 목록 조회
 */
export const getPlans = async (_req: AuthRequest, res: Response) => {
  try {
    const plans = {
      free: {
        ...PLAN_FEATURES.free,
        prices: null,
      },
      pro: {
        ...PLAN_FEATURES.pro,
        prices: PLAN_PRICES.pro,
      },
      premium: {
        ...PLAN_FEATURES.premium,
        prices: PLAN_PRICES.premium,
      },
    };

    return successResponse(res, plans);
  } catch (error) {
    console.error('플랜 목록 조회 실패:', error);
    return errorResponse(res, 'PLANS_FETCH_ERROR', '플랜 목록 조회에 실패했습니다.');
  }
};

/**
 * 현재 구독 상태 조회
 */
export const getCurrentPlan = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;

    // 사용자 이메일 조회
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    if (!user) {
      return errorResponse(res, 'USER_NOT_FOUND', '사용자를 찾을 수 없습니다.', 404);
    }

    // 구독 정보 조회 (없으면 생성)
    const subscription = await subscriptionService.getOrCreateSubscription(userId, user.email);
    const usage = await subscriptionService.getBotUsage(userId);

    return successResponse(res, {
      subscription: {
        plan: subscription.plan,
        status: subscription.status,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      },
      usage,
    });
  } catch (error) {
    console.error('구독 상태 조회 실패:', error);
    return errorResponse(res, 'SUBSCRIPTION_FETCH_ERROR', '구독 상태 조회에 실패했습니다.');
  }
};

/**
 * 봇 사용량 조회
 */
export const getBotUsage = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const usage = await subscriptionService.getBotUsage(userId);

    return successResponse(res, usage);
  } catch (error) {
    console.error('봇 사용량 조회 실패:', error);
    return errorResponse(res, 'USAGE_FETCH_ERROR', '봇 사용량 조회에 실패했습니다.');
  }
};

/**
 * Stripe Checkout Session 생성
 */
export const createCheckoutSession = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { plan, interval } = req.body as { plan: 'pro' | 'premium'; interval: 'month' | 'year' };

    // 유효성 검사
    if (!plan || !['pro', 'premium'].includes(plan)) {
      return errorResponse(res, 'INVALID_PLAN', '유효하지 않은 플랜입니다.');
    }

    if (!interval || !['month', 'year'].includes(interval)) {
      return errorResponse(res, 'INVALID_INTERVAL', '유효하지 않은 결제 주기입니다.');
    }

    // 사용자 이메일 조회
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    if (!user) {
      return errorResponse(res, 'USER_NOT_FOUND', '사용자를 찾을 수 없습니다.', 404);
    }

    // 구독 정보 조회 (Stripe Customer ID 필요)
    const subscription = await subscriptionService.getOrCreateSubscription(userId, user.email);

    if (!subscription.stripeCustomerId) {
      return errorResponse(res, 'CUSTOMER_NOT_FOUND', 'Stripe 고객 정보를 찾을 수 없습니다.');
    }

    // Price ID 조회
    const priceId = stripeService.getPriceId(plan, interval);

    if (!priceId) {
      return errorResponse(res, 'PRICE_NOT_FOUND', '가격 정보를 찾을 수 없습니다.');
    }

    // Checkout Session 생성
    const session = await stripeService.createCheckoutSession(
      subscription.stripeCustomerId,
      priceId,
      userId
    );

    return successResponse(res, { url: session.url });
  } catch (error) {
    console.error('Checkout Session 생성 실패:', error);
    return errorResponse(res, 'CHECKOUT_ERROR', 'Checkout 세션 생성에 실패했습니다.');
  }
};

/**
 * Stripe Billing Portal Session 생성
 */
export const createBillingPortal = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;

    const subscription = await subscriptionService.getSubscription(userId);

    if (!subscription?.stripeCustomerId) {
      return errorResponse(res, 'CUSTOMER_NOT_FOUND', 'Stripe 고객 정보를 찾을 수 없습니다.');
    }

    const session = await stripeService.createBillingPortalSession(subscription.stripeCustomerId);

    return successResponse(res, { url: session.url });
  } catch (error) {
    console.error('Billing Portal 생성 실패:', error);
    return errorResponse(res, 'PORTAL_ERROR', '구독 관리 페이지 생성에 실패했습니다.');
  }
};

/**
 * 구독 취소 (기간 종료 시)
 */
export const cancelSubscription = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;

    const subscription = await subscriptionService.getSubscription(userId);

    if (!subscription?.stripeSubscriptionId) {
      return errorResponse(res, 'SUBSCRIPTION_NOT_FOUND', '활성 구독을 찾을 수 없습니다.');
    }

    // Stripe에서 구독 취소 (기간 종료 시)
    await stripeService.cancelSubscription(subscription.stripeSubscriptionId);

    // DB 업데이트
    await prisma.subscription.update({
      where: { userId },
      data: { cancelAtPeriodEnd: true },
    });

    return successResponse(res, { message: '구독이 취소되었습니다. 현재 결제 기간이 끝나면 Free 플랜으로 전환됩니다.' });
  } catch (error) {
    console.error('구독 취소 실패:', error);
    return errorResponse(res, 'CANCEL_ERROR', '구독 취소에 실패했습니다.');
  }
};

/**
 * 구독 취소 철회
 */
export const reactivateSubscription = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;

    const subscription = await subscriptionService.getSubscription(userId);

    if (!subscription?.stripeSubscriptionId) {
      return errorResponse(res, 'SUBSCRIPTION_NOT_FOUND', '활성 구독을 찾을 수 없습니다.');
    }

    if (!subscription.cancelAtPeriodEnd) {
      return errorResponse(res, 'NOT_CANCELED', '취소 예정 상태가 아닙니다.');
    }

    // Stripe에서 구독 재활성화
    await stripeService.reactivateSubscription(subscription.stripeSubscriptionId);

    // DB 업데이트
    await prisma.subscription.update({
      where: { userId },
      data: { cancelAtPeriodEnd: false },
    });

    return successResponse(res, { message: '구독 취소가 철회되었습니다.' });
  } catch (error) {
    console.error('구독 재활성화 실패:', error);
    return errorResponse(res, 'REACTIVATE_ERROR', '구독 재활성화에 실패했습니다.');
  }
};
