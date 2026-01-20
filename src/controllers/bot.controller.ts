import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { successResponse, errorResponse } from '../utils/response';
import { AuthRequest } from '../types';
import { GridService, roundToTickSize } from '../services/grid.service';
import { UpbitService } from '../services/upbit.service';
import { priceManager } from '../services/upbit-price-manager';
import { decrypt } from '../utils/encryption';
import { botEngine } from '../services/bot-engine.service';
import { ProfitService } from '../services/profit.service';

export const createBot = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const {
      exchange,
      ticker,
      lowerPrice,
      upperPrice,
      priceChangePercent,
      orderAmount,
      stopAtMax = false,
      autoStart = false,
    } = req.body;

    if (!exchange || !ticker || !lowerPrice || !upperPrice || !priceChangePercent || !orderAmount) {
      return errorResponse(
        res,
        'VALIDATION_ERROR',
        '필수 필드가 누락되었습니다',
        400
      );
    }

    if (lowerPrice >= upperPrice) {
      return errorResponse(
        res,
        'INVALID_PRICE_RANGE',
        '가격 범위가 올바르지 않습니다',
        400
      );
    }

    // 실제 매수 레벨 수 계산 (등비수열로 upperPrice 이하까지)
    const changeRatio = 1 + priceChangePercent / 100;
    let gridCount = 0;
    let tempPrice = lowerPrice;
    while (tempPrice <= upperPrice) {
      gridCount++;
      tempPrice = tempPrice * changeRatio;
    }

    const investmentAmount = gridCount * orderAmount;

    const bot = await prisma.bot.create({
      data: {
        userId,
        exchange,
        ticker,
        lowerPrice,
        upperPrice,
        priceChangePercent,
        gridCount,
        orderAmount,
        stopAtMax,
        status: autoStart ? 'running' : 'stopped',
        investmentAmount,
      },
    });

    // autoStart가 true면 그리드 레벨도 생성
    if (autoStart) {
      await GridService.createGridLevels(
        bot.id,
        lowerPrice,
        upperPrice,
        gridCount,
        priceChangePercent
      );
      // WebSocket 티커 구독 및 OrderManager 알림
      await botEngine.onBotStarted(bot.id, userId, ticker);
      console.log(`Bot ${bot.id} created with ${gridCount} grid levels (autoStart)`);
    }

    return successResponse(
      res,
      {
        botId: bot.id,
        exchange: bot.exchange,
        ticker: bot.ticker,
        gridCount: bot.gridCount,
        investmentAmount: bot.investmentAmount,
        status: bot.status,
        createdAt: bot.createdAt,
      },
      '봇이 생성되었습니다',
      201
    );
  } catch (error) {
    next(error);
  }
};

export const getAllBots = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  const startTime = Date.now();
  try {
    const userId = req.userId!;
    const { status, exchange } = req.query;

    const where: any = { userId };
    if (status) where.status = status;
    if (exchange) where.exchange = exchange;

    const bots = await prisma.bot.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    console.log(`[API] getAllBots DB 조회: ${Date.now() - startTime}ms, ${bots.length}개 봇`);

    // 업비트 봇들의 현재가 조회 (WebSocket 캐시만 사용 - 빠른 응답)
    // 가격이 없으면 0으로 반환, 프론트엔드에서 WebSocket으로 실시간 업데이트
    const priceMap = new Map<string, number>();

    for (const bot of bots) {
      if (bot.exchange === 'upbit') {
        const market = `KRW-${bot.ticker.replace('KRW-', '')}`;
        const cachedPrice = priceManager.getPrice(market);
        priceMap.set(market, cachedPrice || 0);
      }
    }

    const summary = {
      totalBots: bots.length,
      activeBots: bots.filter(b => b.status === 'running').length,
      totalProfit: bots.reduce((sum, b) => sum + b.currentProfit, 0),
      totalInvestment: bots.reduce((sum, b) => sum + b.investmentAmount, 0),
    };

    const botsData = bots.map(bot => {
      // 매수 가격 배열 계산 (등비수열: lowerPrice * (1 + percent)^n)
      const buyPrices: number[] = [];
      const multiplier = 1 + bot.priceChangePercent / 100;
      let price = bot.lowerPrice;

      for (let i = 0; i < bot.gridCount; i++) {
        buyPrices.push(roundToTickSize(price)); // 호가 단위에 맞게 반올림
        price *= multiplier;
      }

      // 현재가 조회 (업비트의 경우 일괄 조회 결과에서 가져옴)
      let currentPrice = 0;
      if (bot.exchange === 'upbit') {
        const market = `KRW-${bot.ticker.replace('KRW-', '')}`;
        currentPrice = priceMap.get(market) || 0;
      }

      return {
        _id: bot.id.toString(),
        exchange: bot.exchange,
        ticker: bot.ticker,
        lowerPrice: bot.lowerPrice,
        upperPrice: bot.upperPrice,
        gridCount: bot.gridCount,
        priceChangePercent: bot.priceChangePercent,
        orderAmount: bot.orderAmount,
        stopAtMax: bot.stopAtMax,
        status: bot.status,
        currentProfit: bot.currentProfit,
        profitPercent: bot.investmentAmount > 0
          ? (bot.currentProfit / bot.investmentAmount) * 100
          : 0,
        totalTrades: bot.totalTrades,
        investmentAmount: bot.investmentAmount,
        buyPrices, // 매수 가격 배열 추가
        currentPrice, // 현재가 추가
        createdAt: bot.createdAt,
      };
    });

    console.log(`[API] getAllBots 전체 응답: ${Date.now() - startTime}ms`);
    return successResponse(res, {
      bots: botsData,
      summary,
    });
  } catch (error) {
    console.error(`[API] getAllBots 에러: ${Date.now() - startTime}ms`, error);
    next(error);
  }
};

export const getBotById = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const botId = parseInt(req.params.id);

    const bot = await prisma.bot.findFirst({
      where: { id: botId, userId },
    });

    if (!bot) {
      return errorResponse(res, 'BOT_NOT_FOUND', '봇을 찾을 수 없습니다', 404);
    }

    // 매수 가격 배열 계산 (호가 단위에 맞게)
    const buyPrices: number[] = [];
    const multiplier = 1 + bot.priceChangePercent / 100;
    let price = bot.lowerPrice;

    for (let i = 0; i < bot.gridCount; i++) {
      buyPrices.push(roundToTickSize(price));
      price *= multiplier;
    }

    return successResponse(res, {
      _id: bot.id.toString(),
      exchange: bot.exchange,
      ticker: bot.ticker,
      lowerPrice: bot.lowerPrice,
      upperPrice: bot.upperPrice,
      priceChangePercent: bot.priceChangePercent,
      gridCount: bot.gridCount,
      orderAmount: bot.orderAmount,
      stopAtMax: bot.stopAtMax,
      status: bot.status,
      investmentAmount: bot.investmentAmount,
      currentProfit: bot.currentProfit,
      profitPercent: bot.investmentAmount > 0
        ? (bot.currentProfit / bot.investmentAmount) * 100
        : 0,
      totalTrades: bot.totalTrades,
      buyPrices,
      errorMessage: bot.errorMessage,
      createdAt: bot.createdAt,
      lastExecutedAt: bot.lastExecutedAt,
    });
  } catch (error) {
    next(error);
  }
};

export const updateBot = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const botId = parseInt(req.params.id);
    const { orderAmount, stopAtMax } = req.body;

    const bot = await prisma.bot.findFirst({
      where: { id: botId, userId },
    });

    if (!bot) {
      return errorResponse(res, 'BOT_NOT_FOUND', '봇을 찾을 수 없습니다', 404);
    }

    const updatedBot = await prisma.bot.update({
      where: { id: botId },
      data: {
        ...(orderAmount !== undefined && { orderAmount }),
        ...(stopAtMax !== undefined && { stopAtMax }),
      },
    });

    return successResponse(
      res,
      {
        _id: updatedBot.id.toString(),
        orderAmount: updatedBot.orderAmount,
        stopAtMax: updatedBot.stopAtMax,
        updatedAt: updatedBot.updatedAt,
      },
      '봇 설정이 업데이트되었습니다'
    );
  } catch (error) {
    next(error);
  }
};

export const startBot = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const botId = parseInt(req.params.id);

    const bot = await prisma.bot.findFirst({
      where: { id: botId, userId },
    });

    if (!bot) {
      return errorResponse(res, 'BOT_NOT_FOUND', '봇을 찾을 수 없습니다', 404);
    }

    // 그리드 레벨 생성 (등비수열)
    await GridService.createGridLevels(
      botId,
      bot.lowerPrice,
      bot.upperPrice,
      bot.gridCount,
      bot.priceChangePercent
    );

    // 봇 상태 업데이트
    await prisma.bot.update({
      where: { id: botId },
      data: {
        status: 'running',
        lastExecutedAt: new Date(),
      },
    });

    // WebSocket 티커 구독 및 OrderManager 알림
    await botEngine.onBotStarted(botId, userId, bot.ticker);

    return successResponse(
      res,
      {
        botId: bot.id.toString(),
        status: 'running',
        message: `${bot.gridCount}개의 그리드 레벨이 생성되었습니다`,
      },
      '봇이 시작되었습니다'
    );
  } catch (error) {
    next(error);
  }
};

export const stopBot = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const botId = parseInt(req.params.id);

    const bot = await prisma.bot.findFirst({
      where: { id: botId, userId },
      include: {
        user: {
          include: {
            credentials: {
              where: { exchange: 'upbit' },
            },
          },
        },
        gridLevels: {
          where: { status: 'pending' },
        },
      },
    });

    if (!bot) {
      return errorResponse(res, 'BOT_NOT_FOUND', '봇을 찾을 수 없습니다', 404);
    }

    // 대기 중인 주문 취소
    let cancelledOrders = 0;

    if (bot.gridLevels.length > 0 && bot.user.credentials[0]) {
      const credential = bot.user.credentials[0];
      const apiKey = decrypt(credential.apiKey);
      const secretKey = decrypt(credential.secretKey);

      const upbit = new UpbitService({
        accessKey: apiKey,
        secretKey: secretKey,
      });

      console.log(`[StopBot] Cancelling ${bot.gridLevels.length} pending orders for bot ${botId}...`);

      for (const grid of bot.gridLevels) {
        if (grid.orderId) {
          try {
            await upbit.cancelOrder(grid.orderId);
            cancelledOrders++;

            // 그리드 상태를 available로 변경
            await prisma.gridLevel.update({
              where: { id: grid.id },
              data: { status: 'available', orderId: null },
            });
          } catch (error: any) {
            console.error(`[StopBot] Failed to cancel order ${grid.orderId}:`, error.message);
          }
        }
      }
    }

    await prisma.bot.update({
      where: { id: botId },
      data: { status: 'stopped' },
    });

    // WebSocket 티커 구독 해제 및 OrderManager 알림
    await botEngine.onBotStopped(botId, userId, bot.ticker);

    return successResponse(
      res,
      {
        botId: bot.id.toString(),
        status: 'stopped',
        cancelledOrders,
      },
      `봇이 중지되었습니다. ${cancelledOrders}개의 주문이 취소되었습니다.`
    );
  } catch (error) {
    next(error);
  }
};

export const deleteBot = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const botId = parseInt(req.params.id);
    // cancelType: 'all' = 매수+매도 모두 취소, 'buy' = 매수만 취소, 'none' = 취소 안함
    const cancelType = (req.query.cancelType as string) || 'all';

    // cancelType에 따라 다른 필터 적용
    let gridLevelFilter: any = { status: 'pending' };
    if (cancelType === 'buy') {
      gridLevelFilter = { status: 'pending', type: 'buy' };
    } else if (cancelType === 'none') {
      gridLevelFilter = { id: -1 }; // 아무것도 선택 안함
    }

    const bot = await prisma.bot.findFirst({
      where: { id: botId, userId },
      include: {
        user: {
          include: {
            credentials: {
              where: { exchange: 'upbit' },
            },
          },
        },
        gridLevels: {
          where: gridLevelFilter,
        },
      },
    });

    if (!bot) {
      return errorResponse(res, 'BOT_NOT_FOUND', '봇을 찾을 수 없습니다', 404);
    }

    // 대기 중인 주문 취소
    let cancelledBuyOrders = 0;
    let cancelledSellOrders = 0;
    let failedBuyOrders = 0;
    let failedSellOrders = 0;

    if (cancelType !== 'none' && bot.gridLevels.length > 0 && bot.user.credentials[0]) {
      const credential = bot.user.credentials[0];
      const apiKey = decrypt(credential.apiKey);
      const secretKey = decrypt(credential.secretKey);

      const upbit = new UpbitService({
        accessKey: apiKey,
        secretKey: secretKey,
      });

      const cancelTypeLabel = cancelType === 'buy' ? '매수' : '모든';
      console.log(`[DeleteBot] Cancelling ${bot.gridLevels.length} ${cancelTypeLabel} pending orders for bot ${botId}...`);

      for (let i = 0; i < bot.gridLevels.length; i++) {
        const grid = bot.gridLevels[i];
        if (grid.orderId) {
          try {
            await upbit.cancelOrder(grid.orderId);
            if (grid.type === 'buy') {
              cancelledBuyOrders++;
            } else {
              cancelledSellOrders++;
            }
            console.log(`[DeleteBot] Cancelled ${grid.type} order ${grid.orderId}`);
          } catch (error: any) {
            if (grid.type === 'buy') {
              failedBuyOrders++;
            } else {
              failedSellOrders++;
            }
            console.error(`[DeleteBot] Failed to cancel order ${grid.orderId}:`, error.message);
          }
          // 업비트 API Rate Limit 방지를 위한 딜레이 (100ms)
          if (i < bot.gridLevels.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      }
    }

    // WebSocket 티커 구독 해제 및 OrderManager 알림 (봇이 running 상태였던 경우)
    if (bot.status === 'running') {
      await botEngine.onBotStopped(botId, userId, bot.ticker);
    }

    // 수익 스냅샷 저장 (삭제 전)
    await ProfitService.createBotSnapshot({
      id: bot.id,
      userId: bot.userId,
      exchange: bot.exchange,
      ticker: bot.ticker,
      currentProfit: bot.currentProfit,
      totalTrades: bot.totalTrades,
      investmentAmount: bot.investmentAmount,
      createdAt: bot.createdAt,
    });

    // 봇 삭제 (관련 gridLevels와 trades도 cascade로 삭제됨)
    await prisma.bot.delete({
      where: { id: botId },
    });

    return successResponse(
      res,
      {
        cancelledOrders: {
          buy: cancelledBuyOrders,
          sell: cancelledSellOrders,
          total: cancelledBuyOrders + cancelledSellOrders,
        },
        failedOrders: {
          buy: failedBuyOrders,
          sell: failedSellOrders,
          total: failedBuyOrders + failedSellOrders,
        },
        snapshot: {
          profit: bot.currentProfit,
          trades: bot.totalTrades,
        },
      },
      `봇이 삭제되었습니다. 수익 기록이 저장되었습니다.`
    );
  } catch (error) {
    next(error);
  }
};

export const getGridLevels = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const botId = parseInt(req.params.id);
    const { status } = req.query;

    const bot = await prisma.bot.findFirst({
      where: { id: botId, userId },
    });

    if (!bot) {
      return errorResponse(res, 'BOT_NOT_FOUND', '봇을 찾을 수 없습니다', 404);
    }

    const where: any = { botId };
    if (status) where.status = status;

    const gridLevels = await prisma.gridLevel.findMany({
      where,
      orderBy: { price: 'asc' },
    });

    return successResponse(res, {
      gridLevels: gridLevels.map(gl => ({
        _id: gl.id.toString(),
        price: gl.price,
        type: gl.type,
        status: gl.status,
        orderId: gl.orderId,
        filledAt: gl.filledAt,
      })),
      currentPrice: null,
    });
  } catch (error) {
    next(error);
  }
};

export const getTrades = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const botId = parseInt(req.params.id);
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;
    const status = req.query.status as string; // 'pending' | 'filled' 필터

    const bot = await prisma.bot.findFirst({
      where: { id: botId, userId },
    });

    if (!bot) {
      return errorResponse(res, 'BOT_NOT_FOUND', '봇을 찾을 수 없습니다', 404);
    }

    // 미체결 주문은 GridLevel에서 조회 (실제 업비트에 걸린 주문)
    if (status === 'pending') {
      const pendingGridLevels = await prisma.gridLevel.findMany({
        where: {
          botId,
          status: 'pending',
          orderId: { not: null },
        },
        orderBy: { updatedAt: 'desc' }, // 주문 접수 시간순 정렬
      });

      // 디버그: 전체 pending 상태 그리드도 확인
      const allPendingGrids = await prisma.gridLevel.findMany({
        where: { botId, status: 'pending' },
        select: { id: true, price: true, type: true, orderId: true, status: true },
      });
      console.log(`[getTrades] Bot ${botId}: pending grids with orderId: ${pendingGridLevels.length}, all pending grids: ${allPendingGrids.length}`);
      if (allPendingGrids.length !== pendingGridLevels.length) {
        console.log(`[getTrades] WARNING: ${allPendingGrids.length - pendingGridLevels.length} pending grids without orderId:`,
          allPendingGrids.filter(g => !g.orderId).map(g => ({ id: g.id, price: g.price, type: g.type }))
        );
      }

      return successResponse(res, {
        trades: pendingGridLevels.map(gl => ({
          _id: `grid-${gl.id}`,
          type: gl.type,
          price: gl.price,
          amount: bot.orderAmount / gl.price, // 예상 수량
          total: bot.orderAmount,
          profit: null,
          orderId: gl.orderId,
          status: 'pending',
          executedAt: gl.updatedAt, // 주문 접수 시간 (orderId 설정 시점)
          filledAt: null,
        })),
        pagination: {
          total: pendingGridLevels.length,
          limit: pendingGridLevels.length,
          offset: 0,
          hasMore: false,
        },
      });
    }

    // 체결 주문은 Trade에서 조회
    const whereClause: any = { botId };
    if (status === 'filled') {
      whereClause.status = 'filled';
    }

    const [trades, total] = await Promise.all([
      prisma.trade.findMany({
        where: whereClause,
        orderBy: { filledAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      prisma.trade.count({ where: whereClause }),
    ]);

    return successResponse(res, {
      trades: trades.map(t => ({
        _id: t.id.toString(),
        type: t.type,
        price: t.price,
        amount: t.amount,
        total: t.total,
        profit: t.profit,
        orderId: t.orderId,
        status: t.status,
        executedAt: t.executedAt,
        filledAt: t.filledAt,
      })),
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getPerformance = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const botId = parseInt(req.params.id);

    const bot = await prisma.bot.findFirst({
      where: { id: botId, userId },
      include: {
        trades: true,
      },
    });

    if (!bot) {
      return errorResponse(res, 'BOT_NOT_FOUND', '봇을 찾을 수 없습니다', 404);
    }

    const buyTrades = bot.trades.filter(t => t.type === 'buy').length;
    const sellTrades = bot.trades.filter(t => t.type === 'sell').length;
    const avgProfitPerTrade = bot.totalTrades > 0
      ? bot.currentProfit / bot.totalTrades
      : 0;

    const runningDays = Math.ceil(
      (new Date().getTime() - bot.createdAt.getTime()) / (1000 * 60 * 60 * 24)
    );
    const dailyAvgProfit = runningDays > 0 ? bot.currentProfit / runningDays : 0;

    return successResponse(res, {
      totalProfit: bot.currentProfit,
      profitPercent: bot.investmentAmount > 0
        ? (bot.currentProfit / bot.investmentAmount) * 100
        : 0,
      totalTrades: bot.totalTrades,
      buyTrades,
      sellTrades,
      avgProfitPerTrade,
      investmentAmount: bot.investmentAmount,
      currentValue: bot.investmentAmount + bot.currentProfit,
      runningDays,
      dailyAvgProfit,
    });
  } catch (error) {
    next(error);
  }
};

// WebSocket PriceManager 상태 조회
export const getPriceManagerStatus = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const status = botEngine.getPriceManagerStatus();
    const engineStatus = botEngine.getStatus();

    return successResponse(res, {
      engine: engineStatus,
      priceManager: status,
    });
  } catch (error) {
    next(error);
  }
};

// 전체 거래내역 조회 (모든 봇)
export const getAllTrades = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;
    const type = req.query.type as string; // 'buy' | 'sell'
    const ticker = req.query.ticker as string;
    const startDate = req.query.startDate as string;
    const endDate = req.query.endDate as string;

    // 사용자의 모든 봇 ID 조회
    const userBots = await prisma.bot.findMany({
      where: { userId },
      select: { id: true, ticker: true },
    });

    const botIds = userBots.map(b => b.id);
    const botMap = new Map(userBots.map(b => [b.id, b.ticker]));

    if (botIds.length === 0) {
      return successResponse(res, {
        trades: [],
        summary: {
          totalTrades: 0,
          buyTrades: 0,
          sellTrades: 0,
          totalProfit: 0,
          totalVolume: 0,
        },
        pagination: {
          total: 0,
          limit,
          offset,
          hasMore: false,
        },
      });
    }

    // 필터 조건 구성
    const whereClause: any = {
      botId: { in: botIds },
      status: 'filled', // 체결된 것만
    };

    if (type) {
      whereClause.type = type;
    }

    if (ticker) {
      const tickerBotIds = userBots.filter(b => b.ticker === ticker).map(b => b.id);
      whereClause.botId = { in: tickerBotIds };
    }

    if (startDate || endDate) {
      whereClause.filledAt = {};
      if (startDate) {
        whereClause.filledAt.gte = new Date(startDate);
      }
      if (endDate) {
        whereClause.filledAt.lte = new Date(endDate + 'T23:59:59.999Z');
      }
    }

    // 거래 내역 조회
    const [trades, total] = await Promise.all([
      prisma.trade.findMany({
        where: whereClause,
        orderBy: { filledAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      prisma.trade.count({ where: whereClause }),
    ]);

    // 요약 통계 조회
    const allTrades = await prisma.trade.findMany({
      where: { botId: { in: botIds }, status: 'filled' },
      select: { type: true, profit: true, total: true },
    });

    const summary = {
      totalTrades: allTrades.length,
      buyTrades: allTrades.filter(t => t.type === 'buy').length,
      sellTrades: allTrades.filter(t => t.type === 'sell').length,
      totalProfit: allTrades.reduce((sum, t) => sum + (t.profit || 0), 0),
      totalVolume: allTrades.reduce((sum, t) => sum + t.total, 0),
    };

    return successResponse(res, {
      trades: trades.map(t => ({
        _id: t.id.toString(),
        botId: t.botId.toString(),
        ticker: botMap.get(t.botId) || 'Unknown',
        type: t.type,
        price: t.price,
        amount: t.amount,
        total: t.total,
        profit: t.profit,
        orderId: t.orderId,
        status: t.status,
        executedAt: t.executedAt,
        filledAt: t.filledAt,
      })),
      summary,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
    });
  } catch (error) {
    next(error);
  }
};
