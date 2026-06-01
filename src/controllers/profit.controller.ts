import { Response, NextFunction } from 'express';
import { successResponse, errorResponse } from '../utils/response';
import { AuthRequest } from '../types';
import { ProfitService } from '../services/profit.service';
import { Exchange } from '@prisma/client';
import prisma from '../config/database';

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
 * 수익 불일치 진단 (랭킹 vs 일별수익 차이 원인 분석)
 * GET /api/profits/debug/gap?month=2026-06
 */
export const getProfitGapDiagnosis = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const month = (req.query.month as string) || (() => {
      const now = new Date();
      const kst = new Date(now.getTime() + 9 * 3600000);
      return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}`;
    })();

    const [year, monthNum] = month.split('-').map(Number);
    const startDate = new Date(Date.UTC(year, monthNum - 1, 1, -9, 0, 0, 0));
    const lastDay = new Date(year, monthNum, 0).getDate();
    const endDate = new Date(Date.UTC(year, monthNum - 1, lastDay, 14, 59, 59, 999));

    // MonthlyProfit 합계
    const monthlyProfits = await prisma.monthlyProfit.findMany({
      where: { userId, month },
    });
    const rankingTotal = monthlyProfits.reduce((s, mp) => s + mp.totalProfit, 0);
    const rankingTradeCount = monthlyProfits.reduce((s, mp) => s + mp.tradeCount, 0);

    // Trade 테이블 집계
    const bots = await prisma.bot.findMany({ where: { userId }, select: { id: true, exchange: true } });
    const botIds = bots.map(b => b.id);

    const trades = await prisma.trade.findMany({
      where: {
        botId: { in: botIds },
        type: 'sell',
        status: 'filled',
        filledAt: { gte: startDate, lte: endDate },
      },
      select: {
        id: true,
        botId: true,
        profit: true,
        price: true,
        amount: true,
        filledAt: true,
        gridLevel: { select: { buyPrice: true } },
        bot: { select: { exchange: true } },
      },
    });

    const UPBIT_FEE_RATE = 0.0005;
    const BITHUMB_FEE_RATE = 0.0004;

    let tradeTotal = 0;
    let nullProfitWithGridLevel = 0;
    let nullProfitWithoutGridLevel = 0;
    let nullProfitRecoveredSum = 0;

    for (const trade of trades) {
      let profit = trade.profit;
      if (profit === null && trade.gridLevel?.buyPrice) {
        const feeRate = trade.bot.exchange === 'bithumb' ? BITHUMB_FEE_RATE : UPBIT_FEE_RATE;
        const buyAmount = trade.amount * trade.gridLevel.buyPrice;
        const sellAmount = trade.amount * trade.price;
        profit = sellAmount - buyAmount - buyAmount * feeRate - sellAmount * feeRate;
        nullProfitWithGridLevel++;
        nullProfitRecoveredSum += profit;
      } else if (profit === null) {
        nullProfitWithoutGridLevel++;
        continue;
      }
      tradeTotal += profit;
    }

    const gap = rankingTotal - tradeTotal;

    return successResponse(res, {
      month,
      ranking: {
        total: Math.round(rankingTotal),
        tradeCount: rankingTradeCount,
        source: 'MonthlyProfit 테이블',
      },
      daily: {
        total: Math.round(tradeTotal),
        tradeCount: trades.length,
        source: 'Trade 테이블',
      },
      gap: Math.round(gap),
      nullProfitTrades: {
        recoverable: nullProfitWithGridLevel,
        recoverableSum: Math.round(nullProfitRecoveredSum),
        lost: nullProfitWithoutGridLevel,
        note: 'lost 건수는 Trade.profit=null이고 gridLevel.buyPrice도 없어 재계산 불가 → 일별수익에서 누락됨',
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * MonthlyProfit을 Trade 테이블 기준으로 재계산하여 보정
 * POST /api/profits/debug/fix?month=2026-06
 */
export const fixProfitGap = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const month = (req.query.month as string) || (() => {
      const now = new Date();
      const kst = new Date(now.getTime() + 9 * 3600000);
      return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}`;
    })();

    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ status: 'error', message: '월 형식 오류 (YYYY-MM)' });
    }

    const [year, monthNum] = month.split('-').map(Number);
    const startDate = new Date(Date.UTC(year, monthNum - 1, 1, -9, 0, 0, 0));
    const lastDay = new Date(year, monthNum, 0).getDate();
    const endDate = new Date(Date.UTC(year, monthNum - 1, lastDay, 14, 59, 59, 999));

    const UPBIT_FEE_RATE = 0.0005;
    const BITHUMB_FEE_RATE = 0.0004;

    // 모든 봇(soft delete 포함) 조회
    const bots = await prisma.bot.findMany({ where: { userId }, select: { id: true, exchange: true } });
    const botIds = bots.map(b => b.id);

    const trades = await prisma.trade.findMany({
      where: {
        botId: { in: botIds },
        type: 'sell',
        status: 'filled',
        filledAt: { gte: startDate, lte: endDate },
      },
      select: {
        profit: true,
        price: true,
        amount: true,
        bot: { select: { exchange: true } },
        gridLevel: { select: { buyPrice: true } },
      },
    });

    // 거래소별 수익 합산 (MonthlyProfit은 exchange별로 분리)
    const exchangeProfitMap = new Map<string, { profit: number; count: number }>();
    for (const trade of trades) {
      let profit = trade.profit;
      if (profit === null && trade.gridLevel?.buyPrice) {
        const feeRate = trade.bot.exchange === 'bithumb' ? BITHUMB_FEE_RATE : UPBIT_FEE_RATE;
        const buyAmount = trade.amount * trade.gridLevel.buyPrice;
        const sellAmount = trade.amount * trade.price;
        profit = sellAmount - buyAmount - buyAmount * feeRate - sellAmount * feeRate;
      }
      if (profit == null) continue;

      const ex = trade.bot.exchange;
      const cur = exchangeProfitMap.get(ex) ?? { profit: 0, count: 0 };
      exchangeProfitMap.set(ex, { profit: cur.profit + profit, count: cur.count + 1 });
    }

    // MonthlyProfit 보정 (거래소별)
    const before: any[] = [];
    const after: any[] = [];

    for (const [exchange, { profit, count }] of exchangeProfitMap) {
      const existing = await prisma.monthlyProfit.findUnique({
        where: { userId_exchange_month: { userId, exchange: exchange as any, month } },
      });
      before.push({ exchange, total: existing ? Math.round(existing.totalProfit) : 0, count: existing?.tradeCount ?? 0 });

      await prisma.monthlyProfit.upsert({
        where: { userId_exchange_month: { userId, exchange: exchange as any, month } },
        update: { totalProfit: profit, tradeCount: count },
        create: { userId, exchange: exchange as any, month, totalProfit: profit, tradeCount: count },
      });
      after.push({ exchange, total: Math.round(profit), count });
    }

    // Trade에 없는 거래소의 MonthlyProfit 레코드 제거 (불필요한 초과 데이터 정리)
    const monthlyAll = await prisma.monthlyProfit.findMany({ where: { userId, month } });
    for (const mp of monthlyAll) {
      if (!exchangeProfitMap.has(mp.exchange)) {
        await prisma.monthlyProfit.delete({
          where: { userId_exchange_month: { userId, exchange: mp.exchange, month } },
        });
        before.push({ exchange: mp.exchange, total: Math.round(mp.totalProfit), count: mp.tradeCount });
        after.push({ exchange: mp.exchange, total: 0, count: 0, deleted: true });
      }
    }

    return successResponse(res, { month, before, after, message: 'MonthlyProfit이 Trade 테이블 기준으로 보정되었습니다.' });
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
