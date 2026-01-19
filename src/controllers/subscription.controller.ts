/**
 * 구독 컨트롤러
 *
 * 현재 USDT 결제만 지원
 * Stripe 결제는 추후 구현 예정
 */

import { Response } from 'express';
import { AuthRequest } from '../types';
import { subscriptionService } from '../services/subscription.service';
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

    // 구독 정보 조회 (없으면 생성)
    const subscription = await subscriptionService.getOrCreateSubscription(userId);
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
 * Stripe Checkout Session 생성 (미구현)
 */
export const createCheckoutSession = async (_req: AuthRequest, res: Response) => {
  return errorResponse(res, 'NOT_IMPLEMENTED', 'Stripe 결제는 현재 지원되지 않습니다. USDT 결제를 이용해주세요.');
};

/**
 * Stripe Billing Portal Session 생성 (미구현)
 */
export const createBillingPortal = async (_req: AuthRequest, res: Response) => {
  return errorResponse(res, 'NOT_IMPLEMENTED', 'Stripe 결제는 현재 지원되지 않습니다. USDT 결제를 이용해주세요.');
};

/**
 * 구독 취소 (기간 종료 시)
 */
export const cancelSubscription = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;

    const subscription = await subscriptionService.getSubscription(userId);

    if (!subscription || subscription.plan === 'free') {
      return errorResponse(res, 'SUBSCRIPTION_NOT_FOUND', '활성 구독을 찾을 수 없습니다.');
    }

    // USDT 구독의 경우: 즉시 취소는 불가, 기간 종료 시 자동 만료
    if (subscription.paymentMethod === 'usdt') {
      return successResponse(res, {
        message: 'USDT 구독은 기간 종료 시 자동으로 만료됩니다.',
        periodEnd: subscription.currentPeriodEnd,
      });
    }

    return errorResponse(res, 'NOT_IMPLEMENTED', 'Stripe 구독 취소는 현재 지원되지 않습니다.');
  } catch (error) {
    console.error('구독 취소 실패:', error);
    return errorResponse(res, 'CANCEL_ERROR', '구독 취소에 실패했습니다.');
  }
};

/**
 * 구독 취소 철회 (미구현)
 */
export const reactivateSubscription = async (_req: AuthRequest, res: Response) => {
  return errorResponse(res, 'NOT_IMPLEMENTED', 'Stripe 결제는 현재 지원되지 않습니다. USDT 결제를 이용해주세요.');
};
