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
   * 특정 월의 봇별 상세 수익 조회
   */
  static async getMonthlyDetails(userId: number, month: string, exchange?: Exchange) {
    // 해당 월의 시작/끝 날짜 계산
    const [year, monthNum] = month.split('-').map(Number);
    const startDate = new Date(year, monthNum - 1, 1);
    const endDate = new Date(year, monthNum, 0, 23, 59, 59, 999);

    // 사용자의 활성 봇 조회
    const bots = await prisma.bot.findMany({
      where: { userId, ...(exchange && { exchange }) },
      select: {
        id: true,
        ticker: true,
        orderAmount: true,
        priceChangePercent: true,
        exchange: true,
      },
    });

    const botIds = bots.map(b => b.id);

    // 해당 월의 매도 거래 조회 (수익이 있는 것만)
    const trades = await prisma.trade.findMany({
      where: {
        botId: { in: botIds },
        type: 'sell',
        status: 'filled',
        profit: { not: null },
        filledAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      select: {
        botId: true,
        profit: true,
        price: true,
        amount: true,
        filledAt: true,
      },
    });

    // 봇별로 그룹핑
    const botProfitMap = new Map<number, {
      trades: number;
      profit: number;
      tradeDetails: Array<{
        price: number;
        amount: number;
        profit: number;
        filledAt: Date;
      }>;
    }>();

    for (const trade of trades) {
      if (trade.profit === null) continue;
      const existing = botProfitMap.get(trade.botId) || { trades: 0, profit: 0, tradeDetails: [] };
      botProfitMap.set(trade.botId, {
        trades: existing.trades + 1,
        profit: existing.profit + trade.profit,
        tradeDetails: [...existing.tradeDetails, {
          price: trade.price,
          amount: trade.amount,
          profit: trade.profit,
          filledAt: trade.filledAt!,
        }],
      });
    }

    // 봇 정보와 수익 데이터 결합
    const details = bots
      .filter(bot => botProfitMap.has(bot.id))
      .map(bot => {
        const data = botProfitMap.get(bot.id)!;
        return {
          botId: bot.id,
          ticker: bot.ticker,
          exchange: bot.exchange,
          orderAmount: bot.orderAmount,
          priceChangePercent: bot.priceChangePercent,
          trades: data.trades,
          profit: data.profit,
          tradeDetails: data.tradeDetails.sort((a, b) =>
            b.filledAt.getTime() - a.filledAt.getTime()
          ),
        };
      })
      .sort((a, b) => b.profit - a.profit); // 수익 높은 순

    const totalProfit = details.reduce((sum, d) => sum + d.profit, 0);
    const totalTrades = details.reduce((sum, d) => sum + d.trades, 0);

    return {
      month,
      totalProfit,
      totalTrades,
      details,
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

  /**
   * 수익 랭킹 조회 (전체 사용자 Top N)
   * @param month 조회할 월 (YYYY-MM 형식, 미지정 시 현재 월)
   * @param limit 조회 개수 (기본 5)
   */
  static async getMonthlyRanking(limit: number = 5, month?: string) {
    const targetMonth = month || getCurrentMonth();

    // 해당 월의 시작/끝 날짜 계산
    const [year, monthNum] = targetMonth.split('-').map(Number);
    const startDate = new Date(year, monthNum - 1, 1);
    const endDate = new Date(year, monthNum, 0, 23, 59, 59, 999);

    // 모든 사용자의 활성 봇에서 당월 수익 계산
    const trades = await prisma.trade.findMany({
      where: {
        type: 'sell',
        status: 'filled',
        profit: { not: null },
        filledAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      select: {
        profit: true,
        bot: {
          select: {
            userId: true,
          },
        },
      },
    });

    // 사용자별로 수익 집계
    const userProfitMap = new Map<number, number>();
    for (const trade of trades) {
      if (trade.profit === null || !trade.bot) continue;
      const userId = trade.bot.userId;
      const existing = userProfitMap.get(userId) || 0;
      userProfitMap.set(userId, existing + trade.profit);
    }

    // 사용자 정보 조회
    const userIds = Array.from(userProfitMap.keys());
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, nickname: true, email: true },
    });

    const userMap = new Map(users.map(u => [u.id, u]));

    // 수익 기준 정렬 후 Top N
    const ranking = Array.from(userProfitMap.entries())
      .map(([userId, profit]) => {
        const user = userMap.get(userId);
        // 닉네임이 있으면 닉네임 사용, 없으면 이름 마스킹
        let displayName: string;
        if (user?.nickname) {
          displayName = user.nickname;
        } else {
          const name = user?.name || '익명';
          displayName = name.length > 1
            ? name[0] + '*'.repeat(name.length - 1)
            : name;
        }
        return {
          rank: 0,
          name: displayName,
          profit: Math.round(profit),
        };
      })
      .sort((a, b) => b.profit - a.profit)
      .slice(0, limit)
      .map((item, index) => ({
        ...item,
        rank: index + 1,
      }));

    return {
      month: targetMonth,
      ranking,
    };
  }

  /**
   * 특정 사용자의 월별 수익 상세 조회 (랭킹에서 클릭 시)
   * @param userId 사용자 ID (닉네임/이름으로 조회)
   * @param month 조회할 월 (YYYY-MM 형식)
   * @param displayName 표시 이름 (닉네임 또는 마스킹된 이름)
   */
  static async getRankingUserDetail(displayName: string, month: string) {
    // 해당 월의 시작/끝 날짜 계산
    const [year, monthNum] = month.split('-').map(Number);
    const startDate = new Date(year, monthNum - 1, 1);
    const endDate = new Date(year, monthNum, 0, 23, 59, 59, 999);

    // displayName으로 사용자 찾기
    // 1. 닉네임이 일치하는 사용자
    // 2. 마스킹된 이름이 일치하는 사용자
    const users = await prisma.user.findMany({
      select: { id: true, name: true, nickname: true },
    });

    let targetUserId: number | null = null;
    for (const user of users) {
      // 닉네임이 일치하면
      if (user.nickname === displayName) {
        targetUserId = user.id;
        break;
      }
      // 마스킹된 이름이 일치하면
      const maskedName = user.name && user.name.length > 1
        ? user.name[0] + '*'.repeat(user.name.length - 1)
        : user.name || '익명';
      if (maskedName === displayName) {
        targetUserId = user.id;
        break;
      }
    }

    if (!targetUserId) {
      return null;
    }

    // 해당 사용자의 봇 조회
    const bots = await prisma.bot.findMany({
      where: { userId: targetUserId },
      select: {
        id: true,
        ticker: true,
        exchange: true,
      },
    });

    const botIds = bots.map(b => b.id);

    // 해당 월의 매도 거래 조회
    const trades = await prisma.trade.findMany({
      where: {
        botId: { in: botIds },
        type: 'sell',
        status: 'filled',
        profit: { not: null },
        filledAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      select: {
        botId: true,
        profit: true,
        filledAt: true,
      },
    });

    // 봇(종목)별로 수익 집계
    const tickerProfitMap = new Map<string, { profit: number; trades: number }>();
    for (const trade of trades) {
      if (trade.profit === null) continue;
      const bot = bots.find(b => b.id === trade.botId);
      if (!bot) continue;

      const key = bot.ticker;
      const existing = tickerProfitMap.get(key) || { profit: 0, trades: 0 };
      tickerProfitMap.set(key, {
        profit: existing.profit + trade.profit,
        trades: existing.trades + 1,
      });
    }

    // 결과 정렬 (수익 높은 순)
    const details = Array.from(tickerProfitMap.entries())
      .map(([ticker, data]) => ({
        ticker,
        profit: Math.round(data.profit),
        trades: data.trades,
      }))
      .sort((a, b) => b.profit - a.profit);

    const totalProfit = details.reduce((sum, d) => sum + d.profit, 0);
    const totalTrades = details.reduce((sum, d) => sum + d.trades, 0);

    return {
      name: displayName,
      month,
      totalProfit,
      totalTrades,
      tickerCount: details.length,
      details,
    };
  }

  /**
   * 무한매수 수익 랭킹 조회 (전체 사용자 Top N)
   * @param month 조회할 월 (YYYY-MM 형식, 미지정 시 현재 월)
   * @param limit 조회 개수 (기본 5)
   */
  static async getInfiniteBuyRanking(limit: number = 5, month?: string) {
    const targetMonth = month || getCurrentMonth();

    // 해당 월의 시작/끝 날짜 계산
    const [year, monthNum] = targetMonth.split('-').map(Number);
    const startDate = new Date(year, monthNum - 1, 1);
    const endDate = new Date(year, monthNum, 0, 23, 59, 59, 999);

    // 무한매수 종목을 보유한 모든 사용자 조회
    const stockUsers = await prisma.infiniteBuyStock.findMany({
      select: {
        userId: true,
      },
      distinct: ['userId'],
    });

    const allUserIds = stockUsers.map(s => s.userId);

    // 해당 월의 매도 수익 기록 조회
    const records = await prisma.infiniteBuyRecord.findMany({
      where: {
        type: 'sell',
        orderStatus: 'filled',
        profit: { not: null },
        filledAt: {
          gte: startDate,
          lte: endDate,
        },
        stock: {
          userId: { in: allUserIds },
        },
      },
      select: {
        profit: true,
        stock: {
          select: {
            userId: true,
          },
        },
      },
    });

    // 사용자별로 수익 집계 (기본값 0)
    const userProfitMap = new Map<number, number>();
    for (const userId of allUserIds) {
      userProfitMap.set(userId, 0);
    }
    for (const record of records) {
      if (record.profit === null || !record.stock) continue;
      const userId = record.stock.userId;
      const existing = userProfitMap.get(userId) || 0;
      userProfitMap.set(userId, existing + record.profit);
    }

    // 사용자 정보 조회
    const users = await prisma.user.findMany({
      where: { id: { in: allUserIds } },
      select: { id: true, name: true, nickname: true, email: true },
    });

    const userMap = new Map(users.map(u => [u.id, u]));

    // 수익 기준 정렬 후 Top N
    const ranking = Array.from(userProfitMap.entries())
      .map(([userId, profit]) => {
        const user = userMap.get(userId);
        // 닉네임이 있으면 닉네임 사용, 없으면 이름 마스킹
        let displayName: string;
        if (user?.nickname) {
          displayName = user.nickname;
        } else {
          const name = user?.name || '익명';
          displayName = name.length > 1
            ? name[0] + '*'.repeat(name.length - 1)
            : name;
        }
        return {
          rank: 0,
          name: displayName,
          profit: Math.round(profit),
        };
      })
      .sort((a, b) => b.profit - a.profit)
      .slice(0, limit)
      .map((item, index) => ({
        ...item,
        rank: index + 1,
      }));

    return {
      month: targetMonth,
      ranking,
    };
  }
}
