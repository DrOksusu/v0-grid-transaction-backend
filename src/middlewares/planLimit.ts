/**
 * 플랜 제한 미들웨어
 *
 * 봇 생성 전 플랜 제한 체크
 */

import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { subscriptionService } from '../services/subscription.service';
import { BotType, PLAN_LIMITS } from '../config/plans';
import { errorResponse } from '../utils/response';

const botTypeKorean: Record<BotType, string> = {
  grid: '그리드 봇',
  infiniteBuy: '무한매수 봇',
  vr: 'VR 봇',
};

/**
 * 플랜 제한 체크 미들웨어
 */
export const checkPlanLimit = (botType: BotType) => {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.userId;

      if (!userId) {
        return errorResponse(res, 'UNAUTHORIZED', '인증이 필요합니다.', 401);
      }

      const canCreate = await subscriptionService.canCreateBot(userId, botType);

      if (!canCreate) {
        const plan = await subscriptionService.getUserPlan(userId);
        const limits = PLAN_LIMITS[plan];
        const limit = limits[botType];

        return errorResponse(
          res,
          'PLAN_LIMIT_EXCEEDED',
          `${botTypeKorean[botType]} 생성 제한에 도달했습니다. 현재 플랜(${plan})에서는 최대 ${limit}개까지 생성 가능합니다. 플랜 업그레이드가 필요합니다.`,
          403
        );
      }

      next();
    } catch (error) {
      console.error('플랜 제한 체크 실패:', error);
      return errorResponse(res, 'PLAN_CHECK_ERROR', '플랜 제한 확인 중 오류가 발생했습니다.');
    }
  };
};

/**
 * 무한매수/VR 동적 플랜 제한 체크 미들웨어
 * strategy 파라미터에 따라 infiniteBuy 또는 vr 체크
 */
export const checkInfiniteBuyPlanLimit = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return errorResponse(res, 'UNAUTHORIZED', '인증이 필요합니다.', 401);
    }

    // strategy가 vr이면 VR 봇, 아니면 무한매수 봇
    const strategy = req.body.strategy || 'basic';
    const botType: BotType = strategy === 'vr' ? 'vr' : 'infiniteBuy';

    const canCreate = await subscriptionService.canCreateBot(userId, botType);

    if (!canCreate) {
      const plan = await subscriptionService.getUserPlan(userId);
      const limits = PLAN_LIMITS[plan];
      const limit = limits[botType];

      return errorResponse(
        res,
        'PLAN_LIMIT_EXCEEDED',
        `${botTypeKorean[botType]} 생성 제한에 도달했습니다. 현재 플랜(${plan})에서는 최대 ${limit}개까지 생성 가능합니다. 플랜 업그레이드가 필요합니다.`,
        403
      );
    }

    next();
  } catch (error) {
    console.error('플랜 제한 체크 실패:', error);
    return errorResponse(res, 'PLAN_CHECK_ERROR', '플랜 제한 확인 중 오류가 발생했습니다.');
  }
};
