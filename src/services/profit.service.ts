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

    // 월별 수익 합계
    const monthlyProfits = await prisma.monthlyProfit.findMany({
      where,
      orderBy: { month: 'desc' },
    });

    // 삭제된 봇 스냅샷
    const snapshots = await prisma.profitSnapshot.findMany({
      where,
      orderBy: { deletedAt: 'desc' },
    });

    // 현재 실행 중인 봇들의 수익
    const activeBots = await prisma.bot.findMany({
      where: { userId, ...(exchange && { exchange }) },
      select: {
        currentProfit: true,
        totalTrades: true,
      },
    });

    const currentMonth = getCurrentMonth();

    const totalProfit = monthlyProfits.reduce((sum, mp) => sum + mp.totalProfit, 0);
    const totalTrades = monthlyProfits.reduce((sum, mp) => sum + mp.tradeCount, 0);
    const thisMonthData = monthlyProfits.find(mp => mp.month === currentMonth);
    const thisMonthProfit = thisMonthData?.totalProfit || 0;
    const thisMonthTrades = thisMonthData?.tradeCount || 0;

    // 활성 봇 수익 합계
    const activeProfit = activeBots.reduce((sum, bot) => sum + bot.currentProfit, 0);
    const activeTrades = activeBots.reduce((sum, bot) => sum + bot.totalTrades, 0);

    return {
      totalProfit: totalProfit + activeProfit,
      totalTrades: totalTrades + activeTrades,
      thisMonthProfit,
      thisMonthTrades,
      monthlyProfits: monthlyProfits.map(mp => ({
        month: mp.month,
        profit: mp.totalProfit,
        trades: mp.tradeCount,
      })),
      deletedBots: snapshots.map(s => ({
        ticker: s.ticker,
        botType: s.botType,
        exchange: s.exchange,
        profit: s.finalProfit,
        profitPercent: s.profitPercent,
        trades: s.totalTrades,
        runningDays: s.runningDays,
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
