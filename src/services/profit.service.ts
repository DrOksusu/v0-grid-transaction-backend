/**
 * Profit Service
 *
 * 수익 히스토리 관리:
 * - 월별 수익 집계 (MonthlyProfit)
 * - 봇 삭제 시 스냅샷 저장 (ProfitSnapshot)
 */

import prisma from '../config/database';
import { Exchange } from '@prisma/client';

/**
 * 현재 월 문자열 반환 (YYYY-MM)
 */
function getCurrentMonth(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * 운영 일수 계산
 */
function calculateRunningDays(startDate: Date, endDate: Date = new Date()): number {
  const diffTime = Math.abs(endDate.getTime() - startDate.getTime());
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

export class ProfitService {
  /**
   * 거래 체결 시 월별 수익 업데이트
   * @param userId 유저 ID
   * @param exchange 거래소
   * @param profit 수익금
   */
  static async recordProfit(
    userId: number,
    exchange: Exchange,
    profit: number
  ): Promise<void> {
    const month = getCurrentMonth();

    try {
      await prisma.monthlyProfit.upsert({
        where: {
          userId_exchange_month: {
            userId,
            exchange,
            month,
          },
        },
        update: {
          totalProfit: { increment: profit },
          tradeCount: { increment: 1 },
        },
        create: {
          userId,
          exchange,
          month,
          totalProfit: profit,
          tradeCount: 1,
        },
      });

      console.log(`[ProfitService] Recorded profit: ${profit} for user ${userId} (${month})`);
    } catch (error: any) {
      console.error(`[ProfitService] Failed to record profit:`, error.message);
    }
  }

  /**
   * 봇 삭제 시 스냅샷 저장
   * @param bot 삭제할 봇 정보
   */
  static async createBotSnapshot(bot: {
    id: number;
    userId: number;
    exchange: Exchange;
    ticker: string;
    currentProfit: number;
    totalTrades: number;
    investmentAmount: number;
    createdAt: Date;
  }): Promise<void> {
    try {
      const runningDays = calculateRunningDays(bot.createdAt);
      const profitPercent = bot.investmentAmount > 0
        ? (bot.currentProfit / bot.investmentAmount) * 100
        : 0;

      await prisma.profitSnapshot.create({
        data: {
          userId: bot.userId,
          exchange: bot.exchange,
          ticker: bot.ticker,
          botType: 'grid',
          finalProfit: bot.currentProfit,
          totalTrades: bot.totalTrades,
          investmentAmount: bot.investmentAmount,
          profitPercent,
          startedAt: bot.createdAt,
          runningDays,
        },
      });

      console.log(`[ProfitService] Created snapshot for bot ${bot.id} (${bot.ticker})`);
    } catch (error: any) {
      console.error(`[ProfitService] Failed to create snapshot:`, error.message);
    }
  }

  /**
   * 무한매수 종목 삭제 시 스냅샷 저장
   */
  static async createInfiniteBuySnapshot(stock: {
    id: number;
    userId: number;
    ticker: string;
    totalInvested: number;
    createdAt: Date;
    profit?: number;
    totalTrades?: number;
  }): Promise<void> {
    try {
      const runningDays = calculateRunningDays(stock.createdAt);
      const profit = stock.profit || 0;
      const profitPercent = stock.totalInvested > 0
        ? (profit / stock.totalInvested) * 100
        : 0;

      await prisma.profitSnapshot.create({
        data: {
          userId: stock.userId,
          exchange: 'kis',
          ticker: stock.ticker,
          botType: 'infinite_buy',
          finalProfit: profit,
          totalTrades: stock.totalTrades || 0,
          investmentAmount: stock.totalInvested,
          profitPercent,
          startedAt: stock.createdAt,
          runningDays,
        },
      });

      console.log(`[ProfitService] Created snapshot for infinite buy ${stock.id} (${stock.ticker})`);
    } catch (error: any) {
      console.error(`[ProfitService] Failed to create infinite buy snapshot:`, error.message);
    }
  }

  /**
   * 수익 요약 조회
   */
  static async getSummary(userId: number, exchange?: Exchange) {
    const where: any = { userId };
    if (exchange) where.exchange = exchange;

    // 삭제된 봇 스냅샷
    const snapshots = await prisma.profitSnapshot.findMany({
      where,
      orderBy: { deletedAt: 'desc' },
    });

    // 현재 실행 중인 봇들의 수익 및 ID
    const activeBots = await prisma.bot.findMany({
      where: { userId, ...(exchange && { exchange }) },
      select: {
        id: true,
        currentProfit: true,
        totalTrades: true,
      },
    });

    const activeBotIds = activeBots.map(b => b.id);

    // Trade 테이블에서 직접 월별 수익 계산 (매도 거래만, profit이 있는 것만)
    const trades = await prisma.trade.findMany({
      where: {
        botId: { in: activeBotIds },
        type: 'sell',
        status: 'filled',
        profit: { not: null },
      },
      select: {
        profit: true,
        filledAt: true,
      },
    });

    // 월별로 그룹핑
    const monthlyMap = new Map<string, { profit: number; trades: number }>();
    for (const trade of trades) {
      if (!trade.filledAt || trade.profit === null) continue;
      const month = `${trade.filledAt.getFullYear()}-${String(trade.filledAt.getMonth() + 1).padStart(2, '0')}`;
      const existing = monthlyMap.get(month) || { profit: 0, trades: 0 };
      monthlyMap.set(month, {
        profit: existing.profit + trade.profit,
        trades: existing.trades + 1,
      });
    }

    // 정렬된 월별 수익 배열
    const monthlyProfits = Array.from(monthlyMap.entries())
      .map(([month, data]) => ({ month, profit: data.profit, trades: data.trades }))
      .sort((a, b) => b.month.localeCompare(a.month));

    const currentMonth = getCurrentMonth();
    const thisMonthData = monthlyProfits.find(mp => mp.month === currentMonth);
    const thisMonthProfit = thisMonthData?.profit || 0;
    const thisMonthTrades = thisMonthData?.trades || 0;

    // 활성 봇 수익 합계
    const activeProfit = activeBots.reduce((sum, bot) => sum + bot.currentProfit, 0);
    const activeTrades = activeBots.reduce((sum, bot) => sum + bot.totalTrades, 0);

    // 삭제된 봇 수익 합계
    const deletedProfit = snapshots.reduce((sum, s) => sum + s.finalProfit, 0);
    const deletedTrades = snapshots.reduce((sum, s) => sum + s.totalTrades, 0);

    return {
      // 총 수익 = 활성 봇 수익 + 삭제된 봇 수익 (봇 기준 집계)
      totalProfit: activeProfit + deletedProfit,
      totalTrades: activeTrades + deletedTrades,
      thisMonthProfit,
      thisMonthTrades,
      monthlyProfits,
      deletedBots: snapshots.map(s => ({
        id: s.id,
        ticker: s.ticker,
        botType: s.botType,
        exchange: s.exchange,
        profit: s.finalProfit,
        profitPercent: s.profitPercent,
        trades: s.totalTrades,
        investmentAmount: s.investmentAmount,
        runningDays: s.runningDays,
        startedAt: s.startedAt,
        deletedAt: s.deletedAt,
      })),
      activeBots: {
        profit: activeProfit,
        trades: activeTrades,
        count: activeBots.length,
      },
    };
  }

  /**
   * 월별 수익 목록 조회
   */
  static async getMonthlyProfits(
    userId: number,
    exchange?: Exchange,
    limit: number = 12
  ) {
    const where: any = { userId };
    if (exchange) where.exchange = exchange;

    const profits = await prisma.monthlyProfit.findMany({
      where,
      orderBy: { month: 'desc' },
      take: limit,
    });

    return profits.map(p => ({
      month: p.month,
      exchange: p.exchange,
      profit: p.totalProfit,
      trades: p.tradeCount,
    }));
  }

  /**
   * 삭제된 봇 목록 조회
   */
  static async getDeletedBots(
    userId: number,
    exchange?: Exchange,
    limit: number = 50
  ) {
    const where: any = { userId };
    if (exchange) where.exchange = exchange;

    const snapshots = await prisma.profitSnapshot.findMany({
      where,
      orderBy: { deletedAt: 'desc' },
      take: limit,
    });

    return snapshots.map(s => ({
      id: s.id,
      ticker: s.ticker,
      botType: s.botType,
      exchange: s.exchange,
      profit: s.finalProfit,
      profitPercent: s.profitPercent,
      trades: s.totalTrades,
      investmentAmount: s.investmentAmount,
      runningDays: s.runningDays,
      startedAt: s.startedAt,
      deletedAt: s.deletedAt,
    }));
  }
}
