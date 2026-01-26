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
 * 일별 수익 조회
 * GET /api/profits/daily/:month
 * @param month - 조회할 월 (YYYY-MM 형식)
 * @query exchange - 거래소 필터 (optional)
 */
export const getDailyProfits = async (
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

    const dailyProfits = await ProfitService.getDailyProfits(
      userId,
      month,
      exchange as Exchange | undefined
    );

    return successResponse(res, dailyProfits);
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

/**
 * 수익 랭킹 조회
 * GET /api/profits/ranking
 * @query month - 조회할 월 (YYYY-MM 형식, 미지정 시 현재 월)
 * @query limit - 조회 개수 (기본 5)
 */
export const getMonthlyRanking = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { limit, month } = req.query;

    // 월 형식 검증 (YYYY-MM)
    if (month && !/^\d{4}-\d{2}$/.test(month as string)) {
      return res.status(400).json({
        status: 'error',
        message: '올바른 월 형식이 아닙니다 (YYYY-MM)',
      });
    }

    const ranking = await ProfitService.getMonthlyRanking(
      limit ? parseInt(limit as string) : 5,
      month as string | undefined
    );

    return successResponse(res, ranking);
  } catch (error) {
    next(error);
  }
};

/**
 * 랭킹 사용자 상세 조회 (종목별 수익)
 * GET /api/profits/ranking/user
 * @query name - 사용자 표시 이름 (닉네임 또는 마스킹된 이름)
 * @query month - 조회할 월 (YYYY-MM 형식)
 */
export const getRankingUserDetail = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { name, month } = req.query;

    if (!name || !month) {
      return res.status(400).json({
        status: 'error',
        message: 'name과 month 파라미터가 필요합니다',
      });
    }

    // 월 형식 검증 (YYYY-MM)
    if (!/^\d{4}-\d{2}$/.test(month as string)) {
      return res.status(400).json({
        status: 'error',
        message: '올바른 월 형식이 아닙니다 (YYYY-MM)',
      });
    }

    const detail = await ProfitService.getRankingUserDetail(
      name as string,
      month as string
    );

    if (!detail) {
      return res.status(404).json({
        status: 'error',
        message: '사용자를 찾을 수 없습니다',
      });
    }

    return successResponse(res, detail);
  } catch (error) {
    next(error);
  }
};

/**
 * 무한매수 수익 랭킹 조회
 * GET /api/profits/ranking/infinite-buy
 * @query month - 조회할 월 (YYYY-MM 형식, 미지정 시 현재 월)
 * @query limit - 조회 개수 (기본 5)
 */
export const getInfiniteBuyRanking = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { limit, month } = req.query;

    // 월 형식 검증 (YYYY-MM)
    if (month && !/^\d{4}-\d{2}$/.test(month as string)) {
      return res.status(400).json({
        status: 'error',
        message: '올바른 월 형식이 아닙니다 (YYYY-MM)',
      });
    }

    const ranking = await ProfitService.getInfiniteBuyRanking(
      limit ? parseInt(limit as string) : 5,
      month as string | undefined
    );

    return successResponse(res, ranking);
  } catch (error) {
    next(error);
  }
};

/**
 * 무한매수 랭킹 사용자 상세 조회 (종목별 수익)
 * GET /api/profits/ranking/infinite-buy/user
 * @query name - 사용자 표시 이름 (닉네임 또는 마스킹된 이름)
 * @query month - 조회할 월 (YYYY-MM 형식)
 */
export const getInfiniteBuyRankingUserDetail = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { name, month } = req.query;

    if (!name || !month) {
      return res.status(400).json({
        status: 'error',
        message: 'name과 month 파라미터가 필요합니다',
      });
    }

    // 월 형식 검증 (YYYY-MM)
    if (!/^\d{4}-\d{2}$/.test(month as string)) {
      return res.status(400).json({
        status: 'error',
        message: '올바른 월 형식이 아닙니다 (YYYY-MM)',
      });
    }

    const detail = await ProfitService.getInfiniteBuyRankingUserDetail(
      name as string,
      month as string
    );

    if (!detail) {
      return res.status(404).json({
        status: 'error',
        message: '사용자를 찾을 수 없습니다',
      });
    }

    return successResponse(res, detail);
  } catch (error) {
    next(error);
  }
};
