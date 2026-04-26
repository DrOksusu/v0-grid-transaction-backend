import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import * as arbService from '../services/stablecoin-arb.service';
import type { OpportunityStats } from '../services/stablecoin-arb.service';
import { getAllStablecoinOrderbooks } from '../services/upbit-price-manager';
import { AppError } from '../middlewares/errorHandler';

/**
 * GET /api/admin/stablecoin/bot
 * 관리자 봇 1건 조회. 없으면 빈 객체.
 */
export const getBot = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const bot = await arbService.getBot(userId);
    if (!bot) {
      res.json({});
      return;
    }
    // Prisma Decimal은 JSON.stringify 시 빈 객체가 되므로 string 변환
    res.json({
      ...bot,
      totalProfitUsd: bot.totalProfitUsd.toString(),
      perCoinMinUsd: bot.perCoinMinUsd.toString(),
      perCoinMaxUsd: bot.perCoinMaxUsd.toString(),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/stablecoin/orderbooks
 * Upbit 5종 호가 캐시 스냅샷.
 */
export const getOrderbooks = async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const books = getAllStablecoinOrderbooks();
    res.json({
      updatedAt: new Date().toISOString(),
      books,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/stablecoin/opportunities/stats
 */
export const getOpportunityStats = async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const stats: OpportunityStats = await arbService.getOpportunityStats();
    res.json(stats);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/stablecoin/opportunities/recent?limit=20
 */
export const getRecentOpportunities = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const limit = parseInt((req.query.limit as string) || '20', 10);
    const rows = await arbService.listRecentOpportunities(Number.isFinite(limit) ? limit : 20);

    // BigInt id → string + Decimal 필드 → string (JSON 직렬화 호환)
    const serialized = rows.map((r: any) => ({
      ...r,
      id: r.id.toString(),
      bidSoldKrw: r.bidSoldKrw?.toString() ?? null,
      askBoughtKrw: r.askBoughtKrw?.toString() ?? null,
    }));

    res.json(serialized);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/stablecoin/sim/overview
 */
export const getSimOverview = async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const overview = await arbService.getSimOverview();

    const serialized = {
      bots: overview.bots.map((b: any) => ({
        ...b,
        quantity: b.quantity?.toString() ?? null,
      })),
      stats: overview.stats,
      recentTrades: overview.recentTrades.map((t: any) => ({
        ...t,
        id: t.id.toString(),
        netProfitKrw: t.netProfitKrw?.toString() ?? null,
        grossProfitKrw: t.grossProfitKrw?.toString() ?? null,
        feeKrw: t.feeKrw?.toString() ?? null,
        quantity: t.quantity?.toString() ?? null,
      })),
    };

    res.json(serialized);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/admin/stablecoin/bot/killswitch
 * Body: { enable: boolean }
 */
export const postKillswitch = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const enable = req.body?.enable;

    if (typeof enable !== 'boolean') {
      throw new AppError('Invalid body: enable must be boolean', 400);
    }

    const updated = await arbService.setKillSwitch(userId, enable);
    // Prisma Decimal은 JSON.stringify 시 빈 객체가 되므로 string 변환
    res.json({
      ...updated,
      totalProfitUsd: updated.totalProfitUsd.toString(),
      perCoinMinUsd: updated.perCoinMinUsd.toString(),
      perCoinMaxUsd: updated.perCoinMaxUsd.toString(),
    });
  } catch (error: any) {
    if (error.code === 'P2025') {
      return next(new AppError('Bot not found', 404));
    }
    next(error);
  }
};
