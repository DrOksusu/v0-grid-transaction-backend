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
 * 특정 월의 봇별 상세 수익 조회
 * GET /api/profits/monthly/:month
 */
export const getMonthlyDetails = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const { month } = req.params;
    const { exchange } = req.query;

    // 월 형식 검증 (YYYY-MM)
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({
        status: 'error',
        message: '올바른 월 형식이 아닙니다 (YYYY-MM)',
      });
    }

    const details = await ProfitService.getMonthlyDetails(
      userId,
      month,
      exchange as Exchange | undefined
    );

    return successResponse(res, details);
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
