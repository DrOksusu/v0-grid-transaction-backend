/**
 * 구독 컨트롤러
 *
 * USDT 결제만 지원
 */

import { Response } from 'express';
import { AuthRequest } from '../types';
import { subscriptionService } from '../services/subscription.service';
import { PLAN_FEATURES, PLAN_PRICES } from '../config/plans';
import { successResponse, errorResponse } from '../utils/response';

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
