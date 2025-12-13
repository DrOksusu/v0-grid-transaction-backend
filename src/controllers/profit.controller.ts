import { Response, NextFunction } from 'express';
import { successResponse, errorResponse } from '../utils/response';
import { AuthRequest } from '../types';
import { ProfitService } from '../services/profit.service';
import { Exchange } from '@prisma/client';

/**
 * 수익 요약 조회
 * GET /api/profits/summary
 */
export const getProfitSummary = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const { exchange } = req.query;

    const summary = await ProfitService.getSummary(
      userId,
      exchange as Exchange | undefined
    );

    return successResponse(res, summary);
  } catch (error) {
    next(error);
  }
};

/**
 * 월별 수익 목록 조회
 * GET /api/profits/monthly
 */
export const getMonthlyProfits = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const { exchange, limit } = req.query;

    const profits = await ProfitService.getMonthlyProfits(
      userId,
      exchange as Exchange | undefined,
      limit ? parseInt(limit as string) : 12
    );

    return successResponse(res, { profits });
  } catch (error) {
    next(error);
  }
};

/**
 * 삭제된 봇 성과 목록 조회
 * GET /api/profits/deleted-bots
 */
export const getDeletedBots = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const { exchange, limit } = req.query;

    const deletedBots = await ProfitService.getDeletedBots(
      userId,
      exchange as Exchange | undefined,
      limit ? parseInt(limit as string) : 50
    );

    return successResponse(res, { deletedBots });
  } catch (error) {
    next(error);
  }
};
