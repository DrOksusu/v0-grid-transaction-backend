import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import * as arbService from '../services/stablecoin-arb.service';
import type { OpportunityStats } from '../services/stablecoin-arb.service';
import { getAllStablecoinOrderbooks, type OrderbookTop } from '../services/upbit-price-manager';
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
 *
 * 프론트 위젯이 기대하는 응답 형식:
 *   { updatedAt: ISO, books: { USDT: { bid, ask, bidSize, askSize }, ... } }
 *
 * upbit-price-manager 내부 형식과 두 가지 차이가 있어 변환 필요:
 *   1. Map key: "KRW-USDT" → "USDT" (KRW- prefix 제거)
 *   2. Value: OrderbookTop({ bid: {price,size}, ask: {price,size} }) → 평탄화
 */
export const getOrderbooks = async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const booksMap: ReadonlyMap<string, OrderbookTop> = getAllStablecoinOrderbooks();
    const books: Record<string, { bid: number; ask: number; bidSize: number; askSize: number }> = {};
    for (const [market, top] of booksMap) {
      const coin = market.replace(/^KRW-/, '');
      books[coin] = {
        bid: top.bid.price,
        ask: top.ask.price,
        bidSize: top.bid.size,
        askSize: top.ask.size,
      };
    }
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
 * POST /api/admin/stablecoin/bot/live
 * Body: { live: boolean, confirm?: 'I_UNDERSTAND_LIVE_TRADING' }
 *
 * live=true 전환은 실거래 시작 → confirm 문자열 필수 (오발 방지).
 * live=false 전환은 confirm 불필요.
 */
export const postLive = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const live = req.body?.live;
    const confirm = req.body?.confirm;

    if (typeof live !== 'boolean') {
      throw new AppError('Invalid body: live must be boolean', 400);
    }
    if (live && confirm !== 'I_UNDERSTAND_LIVE_TRADING') {
      throw new AppError('live=true requires confirm: "I_UNDERSTAND_LIVE_TRADING"', 400);
    }

    const updated = await arbService.setLive(userId, live);
    res.json({
      ...updated,
      totalProfitUsd: updated.totalProfitUsd.toString(),
      perCoinMinUsd: updated.perCoinMinUsd.toString(),
      perCoinMaxUsd: updated.perCoinMaxUsd.toString(),
    });
  } catch (error: any) {
    if (error.code === 'P2025') return next(new AppError('Bot not found', 404));
    next(error);
  }
};

/**
 * POST /api/admin/stablecoin/bot/stage
 * Body: { stage: 1 | 2 | 3 }
 *
 * Canary 단계 일괄 적용:
 *  Stage 1: 1만원/일3건/손실 1만원
 *  Stage 2: 2만원/일10건/손실 3만원
 *  Stage 3: 5만원/일30건/손실 5만원
 */
export const postStage = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const stage = req.body?.stage;
    if (![1, 2, 3].includes(stage)) {
      throw new AppError('Invalid body: stage must be 1, 2, or 3', 400);
    }

    const updated = await arbService.setStage(userId, stage as 1 | 2 | 3);
    res.json({
      ...updated,
      totalProfitUsd: updated.totalProfitUsd.toString(),
      perCoinMinUsd: updated.perCoinMinUsd.toString(),
      perCoinMaxUsd: updated.perCoinMaxUsd.toString(),
    });
  } catch (error: any) {
    if (error.code === 'P2025') return next(new AppError('Bot not found', 404));
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

// ===== Maker bot CRUD (Admin 전용) =====

/**
 * MakerTakerSimBot의 quantity 필드(Decimal)를 string으로 직렬화.
 * Prisma Decimal은 JSON.stringify 시 빈 객체가 되므로 변환 필수.
 */
function serializeMakerBot(bot: any) {
  return {
    ...bot,
    quantity: bot.quantity?.toString() ?? null,
  };
}

/**
 * GET /api/admin/stablecoin/maker-bots
 * 사용자의 Maker-Taker 봇 목록.
 */
export const listMakerBots = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const bots = await arbService.listMakerBots(userId);
    res.json(bots.map(serializeMakerBot));
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/admin/stablecoin/maker-bots
 * Body: { makerCoin, takerCoin, bidOffsetKrw, quantity, maxPendingMs?, minTakerBidKrw?, makerFeeBps?, takerFeeBps? }
 *
 * 필수 4개(makerCoin/takerCoin/bidOffsetKrw/quantity) + optional 4개.
 * zod 미사용 — 수동 검증으로 PR B 패턴 따름.
 */
export const createMakerBot = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const body = req.body ?? {};

    if (typeof body.makerCoin !== 'string' || body.makerCoin.length === 0) {
      throw new AppError('Invalid body: makerCoin must be non-empty string', 400);
    }
    if (typeof body.takerCoin !== 'string' || body.takerCoin.length === 0) {
      throw new AppError('Invalid body: takerCoin must be non-empty string', 400);
    }
    if (!Number.isInteger(body.bidOffsetKrw)) {
      throw new AppError('Invalid body: bidOffsetKrw must be integer', 400);
    }
    if (typeof body.quantity !== 'number' || body.quantity <= 0) {
      throw new AppError('Invalid body: quantity must be positive number', 400);
    }
    // optional 필드 — 존재할 때만 검증
    if (body.maxPendingMs !== undefined && (!Number.isInteger(body.maxPendingMs) || body.maxPendingMs <= 0)) {
      throw new AppError('Invalid body: maxPendingMs must be positive integer', 400);
    }
    if (body.minTakerBidKrw !== undefined && body.minTakerBidKrw !== null && !Number.isInteger(body.minTakerBidKrw)) {
      throw new AppError('Invalid body: minTakerBidKrw must be integer or null', 400);
    }
    if (body.minTakerBalance !== undefined && body.minTakerBalance !== null && (!Number.isInteger(body.minTakerBalance) || body.minTakerBalance < 0)) {
      throw new AppError('Invalid body: minTakerBalance must be non-negative integer or null', 400);
    }
    if (body.makerFeeBps !== undefined && (!Number.isInteger(body.makerFeeBps) || body.makerFeeBps < 0)) {
      throw new AppError('Invalid body: makerFeeBps must be non-negative integer', 400);
    }
    if (body.takerFeeBps !== undefined && (!Number.isInteger(body.takerFeeBps) || body.takerFeeBps < 0)) {
      throw new AppError('Invalid body: takerFeeBps must be non-negative integer', 400);
    }

    const bot = await arbService.createMakerBot({
      userId,
      makerCoin: body.makerCoin,
      takerCoin: body.takerCoin,
      bidOffsetKrw: body.bidOffsetKrw,
      quantity: body.quantity,
      maxPendingMs: body.maxPendingMs,
      minTakerBidKrw: body.minTakerBidKrw,
      minTakerBalance: body.minTakerBalance,
      makerFeeBps: body.makerFeeBps,
      takerFeeBps: body.takerFeeBps,
    });
    res.json(serializeMakerBot(bot));
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /api/admin/stablecoin/maker-bots/:id
 * Body: Partial<{ enabled, killSwitch, live, bidOffsetKrw, quantity, maxPendingMs, minTakerBidKrw, makerFeeBps, takerFeeBps }>
 *
 * 부분 업데이트 — 제공된 필드만 patch 객체에 추가. ownership 보호는 service에서.
 */
export const patchMakerBot = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw new AppError('Invalid id', 400);

    const body = req.body ?? {};
    const patch: Record<string, any> = {};

    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw new AppError('Invalid body: enabled must be boolean', 400);
      patch.enabled = body.enabled;
    }
    if (body.killSwitch !== undefined) {
      if (typeof body.killSwitch !== 'boolean') throw new AppError('Invalid body: killSwitch must be boolean', 400);
      patch.killSwitch = body.killSwitch;
    }
    if (body.live !== undefined) {
      if (typeof body.live !== 'boolean') throw new AppError('Invalid body: live must be boolean', 400);
      patch.live = body.live;
    }
    if (body.bidOffsetKrw !== undefined) {
      if (!Number.isInteger(body.bidOffsetKrw)) throw new AppError('Invalid body: bidOffsetKrw must be integer', 400);
      patch.bidOffsetKrw = body.bidOffsetKrw;
    }
    if (body.quantity !== undefined) {
      if (typeof body.quantity !== 'number' || body.quantity <= 0) throw new AppError('Invalid body: quantity must be positive number', 400);
      patch.quantity = body.quantity;
    }
    if (body.maxPendingMs !== undefined) {
      if (!Number.isInteger(body.maxPendingMs) || body.maxPendingMs <= 0) throw new AppError('Invalid body: maxPendingMs must be positive integer', 400);
      patch.maxPendingMs = body.maxPendingMs;
    }
    if (body.minTakerBidKrw !== undefined) {
      if (body.minTakerBidKrw !== null && !Number.isInteger(body.minTakerBidKrw)) throw new AppError('Invalid body: minTakerBidKrw must be integer or null', 400);
      patch.minTakerBidKrw = body.minTakerBidKrw;
    }
    if (body.minTakerBalance !== undefined) {
      if (body.minTakerBalance !== null && (!Number.isInteger(body.minTakerBalance) || body.minTakerBalance < 0)) throw new AppError('Invalid body: minTakerBalance must be non-negative integer or null', 400);
      patch.minTakerBalance = body.minTakerBalance;
    }
    if (body.makerFeeBps !== undefined) {
      if (!Number.isInteger(body.makerFeeBps) || body.makerFeeBps < 0) throw new AppError('Invalid body: makerFeeBps must be non-negative integer', 400);
      patch.makerFeeBps = body.makerFeeBps;
    }
    if (body.takerFeeBps !== undefined) {
      if (!Number.isInteger(body.takerFeeBps) || body.takerFeeBps < 0) throw new AppError('Invalid body: takerFeeBps must be non-negative integer', 400);
      patch.takerFeeBps = body.takerFeeBps;
    }

    const bot = await arbService.patchMakerBot(id, userId, patch);
    res.json(serializeMakerBot(bot));
  } catch (error: any) {
    if (error instanceof AppError) return next(error);
    if (error?.message?.includes('not found')) return next(new AppError('Bot not found', 404));
    next(error);
  }
};

/**
 * DELETE /api/admin/stablecoin/maker-bots/:id
 * - PENDING live trade 있으면 422
 * - 봇 없거나 ownership 미일치면 404
 * - 성공 시 204 (No Content)
 */
export const deleteMakerBot = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw new AppError('Invalid id', 400);

    await arbService.deleteMakerBot(id, userId);
    res.status(204).end();
  } catch (error: any) {
    if (error instanceof AppError) return next(error);
    const msg = error?.message || '';
    if (msg.includes('PENDING')) return next(new AppError(msg, 422));
    if (msg.includes('not found')) return next(new AppError(msg, 404));
    next(error);
  }
};
