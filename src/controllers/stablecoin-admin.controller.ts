import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import * as arbService from '../services/stablecoin-arb.service';
import type { OpportunityStats } from '../services/stablecoin-arb.service';
import { getAllStablecoinOrderbooks, type OrderbookTop } from '../services/upbit-price-manager';
import { AppError } from '../middlewares/errorHandler';
import { reconcileBotAssets } from '../services/maker-taker-asset-reconciliation.service';
import { stablecoinPrisma } from '../config/database';
import mainPrisma from '../config/database';
import { reconcileCrossExchangeBot } from '../services/cross-exchange-reconciliation.service';
import { fetchBithumbOrderbooks } from '../services/bithumb-price-manager';
import { getAllBithumbStablecoinOrderbooks, getBithumbStablecoinOrderbook } from '../services/bithumb-stablecoin-ws-manager';
import { BithumbClient } from '../services/exchange/bithumb-client';
import { UpbitService } from '../services/upbit.service';
import { decrypt } from '../utils/encryption';

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
 * PATCH /api/admin/stablecoin/bot
 * Body: Partial<{ entryThresholdBps, tradeSizeKrw, maxDailyTrades, dailyLossLimitKrw }>
 * 봇 설정값(임계값/거래당/일 한도/손실 한도) 부분 업데이트.
 */
export const patchBot = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const body = req.body ?? {};
    const patch: Record<string, number> = {};

    if (body.entryThresholdBps !== undefined) {
      if (!Number.isInteger(body.entryThresholdBps) || body.entryThresholdBps <= 0) {
        throw new AppError('Invalid body: entryThresholdBps must be positive integer', 400);
      }
      patch.entryThresholdBps = body.entryThresholdBps;
    }
    if (body.tradeSizeKrw !== undefined) {
      if (!Number.isInteger(body.tradeSizeKrw) || body.tradeSizeKrw <= 0) {
        throw new AppError('Invalid body: tradeSizeKrw must be positive integer', 400);
      }
      patch.tradeSizeKrw = body.tradeSizeKrw;
    }
    if (body.maxDailyTrades !== undefined) {
      if (!Number.isInteger(body.maxDailyTrades) || body.maxDailyTrades <= 0) {
        throw new AppError('Invalid body: maxDailyTrades must be positive integer', 400);
      }
      patch.maxDailyTrades = body.maxDailyTrades;
    }
    if (body.dailyLossLimitKrw !== undefined) {
      if (!Number.isInteger(body.dailyLossLimitKrw) || body.dailyLossLimitKrw <= 0) {
        throw new AppError('Invalid body: dailyLossLimitKrw must be positive integer', 400);
      }
      patch.dailyLossLimitKrw = body.dailyLossLimitKrw;
    }

    if (Object.keys(patch).length === 0) {
      throw new AppError('No valid fields to update', 400);
    }

    const updated = await arbService.updateBotConfig(userId, patch);
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
    minSpreadBps: bot.minSpreadBps,
    lastResumeAt: bot.lastResumeAt?.toISOString() ?? null,
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
    if (body.minSpreadBps !== undefined && (!Number.isInteger(body.minSpreadBps) || body.minSpreadBps < 0)) {
      throw new AppError('Invalid body: minSpreadBps must be non-negative integer', 400);
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
      minSpreadBps: body.minSpreadBps,
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
    if (body.minSpreadBps !== undefined) {
      if (!Number.isInteger(body.minSpreadBps) || body.minSpreadBps < 0) throw new AppError('Invalid body: minSpreadBps must be non-negative integer', 400);
      patch.minSpreadBps = body.minSpreadBps;
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

/**
 * POST /api/admin/stablecoin/maker-bots/:id/verify-reconciliation
 *
 * 봇 #id 의 lastResumeAt 이후 DB FILLED 합계와 Upbit done order 합계를 비교한다.
 * 응답: ReconciliationReport (서비스 동일 타입)
 */
export const verifyMakerBotReconciliation = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.userId!;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw new AppError('Invalid id', 400);

    const report = await reconcileBotAssets({ botId: id, userId });
    res.json(report);
  } catch (error: any) {
    if (error?.message?.includes('not found')) return next(new AppError('Bot not found', 404));
    if (error?.message?.includes('not owned')) return next(new AppError('Bot not owned by user', 403));
    if (error?.message?.includes('credential not registered'))
      return next(new AppError('Upbit credential not registered', 400));
    next(error);
  }
};

// ===== Cross-Exchange Arbitrage Bot CRUD (Admin 전용) =====

/**
 * CrossExchangeArbBot 직렬화.
 * lastResumeAt 은 nullable → ISO string 또는 null.
 */
function serializeCrossExchangeBot(bot: any) {
  return {
    id: bot.id,
    userId: bot.userId,
    coin: bot.coin,
    buyCoin: bot.buyCoin ?? null,
    sellCoin: bot.sellCoin ?? null,
    targetDirection: bot.targetDirection,
    quantity: bot.quantity,
    minSpreadBps: bot.minSpreadBps,
    enabled: bot.enabled,
    killSwitch: bot.killSwitch,
    depegMinKrw: bot.depegMinKrw,
    depegMaxKrw: bot.depegMaxKrw,
    liquidityMultiplier: bot.liquidityMultiplier,
    dailyCountLimit: bot.dailyCountLimit,
    dailyLossLimitKrw: bot.dailyLossLimitKrw,
    lastResumeAt: bot.lastResumeAt?.toISOString() ?? null,
    lastSkipReason: bot.lastSkipReason ?? null,
    lastSkipAt: bot.lastSkipAt?.toISOString() ?? null,
    createdAt: bot.createdAt.toISOString(),
    updatedAt: bot.updatedAt.toISOString(),
  };
}

/**
 * GET /api/admin/stablecoin/cross-exchange-bots
 * Admin 전용 — 모든 유저의 봇 목록 반환.
 */
export const listCrossExchangeBots = async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const bots = await stablecoinPrisma.crossExchangeArbBot.findMany({ orderBy: { id: 'asc' } });
    res.json({ bots: bots.map(serializeCrossExchangeBot) });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/admin/stablecoin/cross-exchange-bots
 * Body: { coin, targetDirection, quantity, minSpreadBps?, depegMinKrw?, depegMaxKrw?, liquidityMultiplier?, dailyCountLimit?, dailyLossLimitKrw? }
 *
 * 필수 3개(coin/targetDirection/quantity) + optional 안전장치 임계값들 (default 적용).
 */
export const createCrossExchangeBot = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const body = req.body;
    if (!['UB', 'BU'].includes(body.targetDirection)) {
      throw new AppError('targetDirection must be UB or BU', 400);
    }
    if (!Number.isInteger(body.quantity) || body.quantity <= 0) {
      throw new AppError('quantity must be positive integer', 400);
    }
    const bot = await stablecoinPrisma.crossExchangeArbBot.create({
      data: {
        userId,
        coin: body.coin,
        buyCoin: body.buyCoin ?? null,
        sellCoin: body.sellCoin ?? null,
        targetDirection: body.targetDirection,
        quantity: body.quantity,
        minSpreadBps: body.minSpreadBps ?? 50,
        depegMinKrw: body.depegMinKrw ?? 1380,
        depegMaxKrw: body.depegMaxKrw ?? 1420,
        liquidityMultiplier: body.liquidityMultiplier ?? 1.5,
        dailyCountLimit: body.dailyCountLimit ?? 5,
        dailyLossLimitKrw: body.dailyLossLimitKrw ?? 50000,
      },
    });
    res.status(201).json({ bot: serializeCrossExchangeBot(bot) });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/admin/stablecoin/cross-exchange-bots/:id
 * Admin 전용 — 모든 봇 수정 가능. enabled false→true 전환 시 lastResumeAt 자동 갱신.
 */
export const patchCrossExchangeBot = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    const body = req.body;
    const existing = await stablecoinPrisma.crossExchangeArbBot.findFirst({ where: { id } });
    if (!existing) throw new AppError('Bot not found', 404);

    const patch: any = {};
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.killSwitch !== undefined) patch.killSwitch = body.killSwitch;
    if (body.minSpreadBps !== undefined) patch.minSpreadBps = body.minSpreadBps;
    if (body.quantity !== undefined) patch.quantity = body.quantity;
    if (body.buyCoin !== undefined) patch.buyCoin = body.buyCoin;
    if (body.sellCoin !== undefined) patch.sellCoin = body.sellCoin;
    if (body.depegMinKrw !== undefined) patch.depegMinKrw = body.depegMinKrw;
    if (body.depegMaxKrw !== undefined) patch.depegMaxKrw = body.depegMaxKrw;
    if (body.liquidityMultiplier !== undefined) patch.liquidityMultiplier = body.liquidityMultiplier;
    if (body.dailyCountLimit !== undefined) patch.dailyCountLimit = body.dailyCountLimit;
    if (body.dailyLossLimitKrw !== undefined) patch.dailyLossLimitKrw = body.dailyLossLimitKrw;

    // enabled false→true 전환 시 lastResumeAt 자동 갱신
    if (existing.enabled === false && patch.enabled === true) {
      patch.lastResumeAt = new Date();
    }

    const updated = await stablecoinPrisma.crossExchangeArbBot.update({ where: { id }, data: patch });
    res.json({ bot: serializeCrossExchangeBot(updated) });
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/admin/stablecoin/cross-exchange-bots/:id
 * Admin 전용 — 모든 봇 삭제 가능.
 */
export const deleteCrossExchangeBot = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    await stablecoinPrisma.crossExchangeArbBot.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

// ===== ArbAutoConfig (빗썸 단일 차익거래 글로벌 설정) =====

/**
 * GET /api/admin/stablecoin/arb-auto-config
 * 글로벌 설정 조회. row 없으면 기본값으로 생성.
 */
export const getArbAutoConfig = async (
  _req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    let config = await stablecoinPrisma.arbAutoConfig.findFirst();
    if (!config) {
      config = await stablecoinPrisma.arbAutoConfig.create({ data: {} });
    }
    res.json({ config });
  } catch (e) {
    next(e);
  }
};

/**
 * PATCH /api/admin/stablecoin/arb-auto-config
 * 글로벌 설정 부분 업데이트. 알려진 필드만 허용 (화이트리스트).
 */
export const patchArbAutoConfig = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const body = req.body ?? {};
    const patch: Record<string, any> = {};

    // bithumb 설정
    if (body.bithumbEnabled !== undefined) {
      if (typeof body.bithumbEnabled !== 'boolean')
        throw new AppError('bithumbEnabled must be boolean', 400);
      patch.bithumbEnabled = body.bithumbEnabled;
    }
    if (body.bithumbCoins !== undefined) {
      if (
        !Array.isArray(body.bithumbCoins) ||
        !body.bithumbCoins.every((c: any) => typeof c === 'string')
      )
        throw new AppError('bithumbCoins must be string array', 400);
      patch.bithumbCoins = body.bithumbCoins;
    }
    if (body.bithumbQty !== undefined) {
      if (!Number.isInteger(body.bithumbQty) || body.bithumbQty <= 0)
        throw new AppError('bithumbQty must be positive integer', 400);
      patch.bithumbQty = body.bithumbQty;
    }
    if (body.bithumbMinSpreadBps !== undefined) {
      if (!Number.isInteger(body.bithumbMinSpreadBps) || body.bithumbMinSpreadBps < 0)
        throw new AppError('bithumbMinSpreadBps must be non-negative integer', 400);
      patch.bithumbMinSpreadBps = body.bithumbMinSpreadBps;
    }
    if (body.bithumbDailyCountLimit !== undefined) {
      if (!Number.isInteger(body.bithumbDailyCountLimit) || body.bithumbDailyCountLimit <= 0)
        throw new AppError('bithumbDailyCountLimit must be positive integer', 400);
      patch.bithumbDailyCountLimit = body.bithumbDailyCountLimit;
    }
    if (body.bithumbDailyLossLimitKrw !== undefined) {
      if (!Number.isInteger(body.bithumbDailyLossLimitKrw) || body.bithumbDailyLossLimitKrw <= 0)
        throw new AppError('bithumbDailyLossLimitKrw must be positive integer', 400);
      patch.bithumbDailyLossLimitKrw = body.bithumbDailyLossLimitKrw;
    }

    // Cross-Exchange 자동 봇 생성 기본값
    if (body.crossBotMinSpreadBps !== undefined) {
      if (!Number.isInteger(body.crossBotMinSpreadBps) || body.crossBotMinSpreadBps < 0)
        throw new AppError('crossBotMinSpreadBps must be non-negative integer', 400);
      patch.crossBotMinSpreadBps = body.crossBotMinSpreadBps;
    }
    if (body.crossBotDailyCountLimit !== undefined) {
      if (!Number.isInteger(body.crossBotDailyCountLimit) || body.crossBotDailyCountLimit <= 0)
        throw new AppError('crossBotDailyCountLimit must be positive integer', 400);
      patch.crossBotDailyCountLimit = body.crossBotDailyCountLimit;
    }
    if (body.crossBotDailyLossLimitKrw !== undefined) {
      if (!Number.isInteger(body.crossBotDailyLossLimitKrw) || body.crossBotDailyLossLimitKrw <= 0)
        throw new AppError('crossBotDailyLossLimitKrw must be positive integer', 400);
      patch.crossBotDailyLossLimitKrw = body.crossBotDailyLossLimitKrw;
    }

    // 향후 확장 필드
    if (body.upbitEnabled !== undefined) {
      if (typeof body.upbitEnabled !== 'boolean')
        throw new AppError('upbitEnabled must be boolean', 400);
      patch.upbitEnabled = body.upbitEnabled;
    }
    if (body.crossEnabled !== undefined) {
      if (typeof body.crossEnabled !== 'boolean')
        throw new AppError('crossEnabled must be boolean', 400);
      patch.crossEnabled = body.crossEnabled;
    }

    let config = await stablecoinPrisma.arbAutoConfig.findFirst();
    if (!config) {
      config = await stablecoinPrisma.arbAutoConfig.create({ data: {} });
    }

    const updated = await stablecoinPrisma.arbAutoConfig.update({
      where: { id: config.id },
      data: patch,
    });
    res.json({ config: updated });
  } catch (e) {
    next(e);
  }
};

/**
 * GET /api/admin/stablecoin/bithumb-arb-trades?limit=50
 * 빗썸 단일 차익거래 내역 조회.
 * BigInt id + Decimal 필드를 string 직렬화.
 */
export const listBithumbArbTrades = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 200);
    const trades = await stablecoinPrisma.bithumbSingleArbTrade.findMany({
      orderBy: { createdAt: 'desc' },
      take: Number.isFinite(limit) ? limit : 50,
    });

    // BigInt + Decimal → string 직렬화 (JSON stringify 호환)
    const serialized = trades.map((t) => ({
      ...t,
      id: t.id.toString(),
      qty: t.qty.toString(),
      legAFilledQty: t.legAFilledQty?.toString() ?? null,
      legAAvgPriceKrw: t.legAAvgPriceKrw?.toString() ?? null,
      legAFeeKrw: t.legAFeeKrw?.toString() ?? null,
      legAReceivedKrw: t.legAReceivedKrw?.toString() ?? null,
      legBFilledQty: t.legBFilledQty?.toString() ?? null,
      legBAvgPriceKrw: t.legBAvgPriceKrw?.toString() ?? null,
      legBFeeKrw: t.legBFeeKrw?.toString() ?? null,
      legBSpentKrw: t.legBSpentKrw?.toString() ?? null,
      profitKrw: t.profitKrw?.toString() ?? null,
    }));

    res.json({ trades: serialized });
  } catch (e) {
    next(e);
  }
};

/**
 * GET /api/admin/stablecoin/cross-exchange-bots/:id/verify-reconciliation
 *
 * Stage 1 캐너리: 거래소 done-order endpoint 미구현 → mockOrders 로 빈 배열 (upbit/bithumb done count = 0).
 * dbFilledCount > 0 이면 isReconciled=false 가 정상 (operator 가 직접 거래소 UI 로 검증).
 * Stage 2 에서 ExchangeClient 에 fetchDoneOrders 추가 시 mockOrders 제거.
 */
export const verifyCrossExchangeReconciliation = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const id = parseInt(req.params.id, 10);
    const bot = await stablecoinPrisma.crossExchangeArbBot.findFirst({ where: { id } });
    if (!bot) throw new AppError('Bot not found', 404);

    const report = await reconcileCrossExchangeBot(
      id,
      stablecoinPrisma,
      null as any,
      null as any,
      undefined,
    );
    res.json(report);
  } catch (err) {
    next(err);
  }
};

// ===== 빗썸 호가 + 크로스거래소 스프레드 (대시보드용) =====

/**
 * GET /api/admin/stablecoin/bithumb-orderbooks
 * 빗썸 5종 스테이블코인 실시간 호가.
 * WS 캐시 우선 → 없는 심볼만 REST fallback
 */
export const getBithumbOrderbooks = async (
  _req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const coins = ['USDT', 'USDC', 'USDS', 'USD1', 'USDE'];
    const result: Record<string, { bid: number | null; ask: number | null; timestamp: number }> = {};

    // WS 캐시 우선 조회
    const wsBooks = getAllBithumbStablecoinOrderbooks();
    const missingCoins: string[] = [];
    for (const coin of coins) {
      const ws = wsBooks.get(coin);
      if (ws) {
        result[coin] = { bid: ws.bid, ask: ws.ask, timestamp: ws.timestamp };
      } else {
        missingCoins.push(coin);
      }
    }

    // WS에 없는 심볼만 REST fallback
    if (missingCoins.length > 0) {
      const restBooks = await fetchBithumbOrderbooks(missingCoins);
      restBooks.forEach((v, k) => {
        result[k] = { bid: v.bid, ask: v.ask, timestamp: v.timestamp };
      });
    }

    res.json({ books: result, fetchedAt: Date.now() });
  } catch (e) {
    next(e);
  }
};

/**
 * GET /api/admin/stablecoin/cross-exchange-trades
 * CrossExchangeArbTrade 내역 최신순. limit(max 500), botId 필터 지원.
 */
export const listCrossExchangeTrades = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const limit = Math.min(parseInt((req.query.limit as string) || '100', 10), 500);
    const botId = req.query.botId ? parseInt(req.query.botId as string, 10) : undefined;

    const trades = await stablecoinPrisma.crossExchangeArbTrade.findMany({
      where: botId ? { botId } : undefined,
      orderBy: { createdAt: 'desc' },
      take: Number.isFinite(limit) ? limit : 100,
      include: { bot: { select: { coin: true, buyCoin: true, sellCoin: true } } },
    });

    const serialized = trades.map((t) => ({
      id: t.id.toString(),
      botId: t.botId,
      coin: t.bot.coin,
      buyCoin: t.bot.buyCoin ?? t.bot.coin,
      sellCoin: t.bot.sellCoin ?? t.bot.coin,
      direction: t.direction,
      spreadBpsAtPlacement: t.spreadBpsAtPlacement,
      legAExchange: t.legAExchange,
      legACoin: t.legACoin ?? t.bot.coin,
      legAFilledQty: t.legAFilledQty != null ? Number(t.legAFilledQty) : null,
      legAAvgPrice: t.legAAvgPrice != null ? Number(t.legAAvgPrice) : null,
      legAFeeKrw: t.legAFeeKrw != null ? Number(t.legAFeeKrw) : null,
      legBExchange: t.legBExchange,
      legBCoin: t.legBCoin ?? t.bot.coin,
      legBFilledQty: t.legBFilledQty != null ? Number(t.legBFilledQty) : null,
      legBAvgPrice: t.legBAvgPrice != null ? Number(t.legBAvgPrice) : null,
      legBFeeKrw: t.legBFeeKrw != null ? Number(t.legBFeeKrw) : null,
      profitKrw: t.profitKrw != null ? Number(t.profitKrw) : null,
      status: t.status,
      failureReason: t.failureReason ?? null,
      createdAt: t.createdAt.toISOString(),
      completedAt: t.completedAt?.toISOString() ?? null,
    }));

    res.json({ trades: serialized });
  } catch (e) {
    next(e);
  }
};

// ── 잔고 캐시 (rate limit 방지) ────────────────────────────────────────────────
const _balanceCache = new Map<
  string,
  {
    data: {
      bithumbBalances: Record<string, { available: number; locked: number }>;
      upbitBalances: Record<string, { available: number; locked: number }>;
    };
    at: number;
  }
>();
const BALANCE_CACHE_TTL = 12_000; // 12초

/**
 * GET /api/admin/stablecoin/balance-requirements
 * 라이브 봇들의 필요 잔고 vs 현재 잔고를 반환.
 * 관리자가 insufficient_funds 에러 원인을 한눈에 파악하기 위한 API.
 */
export const getBalanceRequirements = async (
  _req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    // 1. 라이브 봇 조회 (enabled 여부 무관 — 잠시 비활성화된 봇도 잔고 현황 확인)
    const liveBots = await stablecoinPrisma.makerTakerSimBot.findMany({
      where: { live: true },
      select: {
        id: true,
        userId: true,
        makerCoin: true,
        takerCoin: true,
        makerExchange: true,
        takerExchange: true,
        quantity: true,
        enabled: true,
        killSwitch: true,
      },
    });

    // 2. 잔고 조회 (캐시 적용)
    const userIds = [...new Set(liveBots.map((b) => b.userId))];
    const cacheKey = [...userIds].sort().join(',');
    const now = Date.now();

    let bithumbBalances: Record<string, { available: number; locked: number }> = {};
    let upbitBalances: Record<string, { available: number; locked: number }> = {};

    const cached = _balanceCache.get(cacheKey);
    if (cached && now - cached.at < BALANCE_CACHE_TTL) {
      bithumbBalances = cached.data.bithumbBalances;
      upbitBalances = cached.data.upbitBalances;
    } else {
      // 각 userId별 크레덴셜로 잔고 조회 후 합산
      for (const userId of userIds) {
        // Bithumb 잔고 조회
        try {
          const bithumbCred = await mainPrisma.credential.findFirst({
            where: { userId, exchange: 'bithumb' },
          });
          if (bithumbCred) {
            const accessKey = decrypt(bithumbCred.apiKey);
            const secretKey = decrypt(bithumbCred.secretKey);
            const client = new BithumbClient({ accessKey, secretKey });
            const balances = await client.getBalances();
            for (const [coin, entry] of Object.entries(balances)) {
              if (!bithumbBalances[coin]) {
                bithumbBalances[coin] = { available: 0, locked: 0 };
              }
              bithumbBalances[coin].available += entry.available;
              bithumbBalances[coin].locked += entry.locked;
            }
          }
        } catch {
          // 크레덴셜 없거나 조회 실패 시 빈 객체 유지
        }

        // Upbit 잔고 조회
        try {
          const upbitCred = await mainPrisma.credential.findFirst({
            where: { userId, exchange: 'upbit' },
          });
          if (upbitCred) {
            const accessKey = decrypt(upbitCred.apiKey);
            const secretKey = decrypt(upbitCred.secretKey);
            const upbit = new UpbitService({ accessKey, secretKey });
            const accounts: Array<{ currency: string; balance: string; locked: string }> =
              await upbit.getAccounts();
            for (const acc of accounts) {
              const coin = acc.currency.toUpperCase();
              if (!upbitBalances[coin]) {
                upbitBalances[coin] = { available: 0, locked: 0 };
              }
              upbitBalances[coin].available += parseFloat(acc.balance ?? '0');
              upbitBalances[coin].locked += parseFloat(acc.locked ?? '0');
            }
          }
        } catch {
          // 크레덴셜 없거나 조회 실패 시 빈 객체 유지
        }
      }

      _balanceCache.set(cacheKey, {
        data: { bithumbBalances, upbitBalances },
        at: now,
      });
    }

    // 3. 거래소별 perCoinRequired / krwRequired 집계
    const bithumbPerCoin: Record<string, { qty: number; botIds: number[] }> = {};
    const upbitPerCoin: Record<string, { qty: number; botIds: number[] }> = {};
    const bithumbKrwBotIds: number[] = [];
    const upbitKrwBotIds: number[] = [];
    let bithumbKrwTotal = 0;
    let upbitKrwTotal = 0;

    // 4. 봇별 status 계산 결과 수집
    const botStatuses: Array<{
      id: number;
      makerCoin: string;
      takerCoin: string;
      makerExchange: string;
      takerExchange: string;
      quantity: number;
      makerCoinAvail: number;
      krwAvail: number;
      status: 'ok' | 'insufficient_coin' | 'insufficient_krw' | 'insufficient_both';
      enabled: boolean;
      killSwitch: boolean;
    }> = [];

    for (const bot of liveBots) {
      const qty = Number(bot.quantity);
      const makerExchange = bot.makerExchange ?? 'upbit';

      // KRW 요건 계산 (현재 WS 가격 사용)
      let askPrice: number;
      if (makerExchange === 'bithumb') {
        const ob = getBithumbStablecoinOrderbook(bot.makerCoin);
        askPrice = ob?.ask ?? 1500;
      } else {
        const upbitBooks = getAllStablecoinOrderbooks();
        const upbitOb = upbitBooks.get(`KRW-${bot.makerCoin}`);
        askPrice = upbitOb?.ask?.price ?? 1500;
      }
      const krwRequired = Math.ceil(qty * askPrice * 1.01);

      // perCoinRequired 집계 (enabled=true & killSwitch=false 봇만 — 충전 필요 판단 기준)
      if (bot.enabled && !bot.killSwitch) {
        if (makerExchange === 'bithumb') {
          if (!bithumbPerCoin[bot.makerCoin]) {
            bithumbPerCoin[bot.makerCoin] = { qty: 0, botIds: [] };
          }
          bithumbPerCoin[bot.makerCoin].qty += qty;
          bithumbPerCoin[bot.makerCoin].botIds.push(bot.id);

          bithumbKrwTotal += krwRequired;
          bithumbKrwBotIds.push(bot.id);
        } else {
          if (!upbitPerCoin[bot.makerCoin]) {
            upbitPerCoin[bot.makerCoin] = { qty: 0, botIds: [] };
          }
          upbitPerCoin[bot.makerCoin].qty += qty;
          upbitPerCoin[bot.makerCoin].botIds.push(bot.id);

          upbitKrwTotal += krwRequired;
          upbitKrwBotIds.push(bot.id);
        }
      }

      // 봇별 status 계산
      const makerCoinAvail =
        makerExchange === 'bithumb'
          ? (bithumbBalances[bot.makerCoin]?.available ?? 0)
          : (upbitBalances[bot.makerCoin]?.available ?? 0);
      const krwAvail =
        makerExchange === 'bithumb'
          ? (bithumbBalances['KRW']?.available ?? 0)
          : (upbitBalances['KRW']?.available ?? 0);

      const insufficientCoin = makerCoinAvail < qty;
      const insufficientKrw = krwAvail < krwRequired;

      let status: 'ok' | 'insufficient_coin' | 'insufficient_krw' | 'insufficient_both';
      if (insufficientCoin && insufficientKrw) {
        status = 'insufficient_both';
      } else if (insufficientCoin) {
        status = 'insufficient_coin';
      } else if (insufficientKrw) {
        status = 'insufficient_krw';
      } else {
        status = 'ok';
      }

      botStatuses.push({
        id: bot.id,
        makerCoin: bot.makerCoin,
        takerCoin: bot.takerCoin,
        makerExchange,
        takerExchange: bot.takerExchange ?? 'upbit',
        quantity: qty,
        makerCoinAvail,
        krwAvail,
        status,
        enabled: bot.enabled,
        killSwitch: bot.killSwitch,
      });
    }

    // 5. 응답 구성
    res.json({
      exchanges: {
        bithumb: {
          balances: bithumbBalances,
          perCoinRequired: bithumbPerCoin,
          krwRequired: {
            total: bithumbKrwTotal,
            botIds: [...new Set(bithumbKrwBotIds)],
          },
        },
        upbit: {
          balances: upbitBalances,
          perCoinRequired: upbitPerCoin,
          krwRequired: {
            total: upbitKrwTotal,
            botIds: [...new Set(upbitKrwBotIds)],
          },
        },
      },
      bots: botStatuses,
      updatedAt: Date.now(),
    });
  } catch (e) {
    next(e);
  }
};

/**
 * GET /api/admin/stablecoin/cross-exchange-latest
 * 업비트↔빗썸 크로스 스프레드 최신 스냅샷 (5코인).
 */
export const getCrossExchangeLatest = async (
  _req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const coins = ['USDT', 'USDC', 'USDS', 'USD1', 'USDE'];
    const snaps = await Promise.all(
      coins.map((market) =>
        mainPrisma.crossExchangeSnapshot.findFirst({
          where: { market },
          orderBy: { timestamp: 'desc' },
        }),
      ),
    );
    const serialized = snaps
      .filter(Boolean)
      .map((s) => ({
        id: s!.id.toString(),
        market: s!.market,
        upbitBid: s!.upbitBid.toString(),
        upbitAsk: s!.upbitAsk.toString(),
        bithumbBid: s!.bithumbBid.toString(),
        bithumbAsk: s!.bithumbAsk.toString(),
        ubSpreadBps: s!.ubSpreadBps.toString(),
        buSpreadBps: s!.buSpreadBps.toString(),
        maxSpreadBps: s!.maxSpreadBps.toString(),
        timestamp: s!.timestamp.toISOString(),
      }));
    res.json({ snapshots: serialized, fetchedAt: Date.now() });
  } catch (e) {
    next(e);
  }
};

/**
 * GET /api/admin/stablecoin/maker-taker-trades
 * MakerTakerSim 거래 내역 조회.
 * Query: limit (default 100, max 500), status (all | FILLED | PENDING | PARTIAL_HOLD | EXPIRED | CANCELLED | TAKER_PENDING | TAKER_EXPIRED | MAKER_EXPIRED), coin
 */
export const listMakerTakerTrades = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const limit = Math.min(parseInt((req.query.limit as string) || '100', 10), 500);
    const statusFilter = (req.query.status as string) || 'all';
    const coinFilter = (req.query.coin as string) || '';

    const where: Record<string, unknown> = { live: true };
    if (statusFilter !== 'all') where.status = statusFilter;
    if (coinFilter) where.OR = [{ makerCoin: coinFilter }, { takerCoin: coinFilter }];

    const trades = await stablecoinPrisma.makerTakerSimTrade.findMany({
      where,
      orderBy: { id: 'desc' },
      take: Number.isFinite(limit) ? limit : 100,
      include: {
        bot: {
          select: { makerExchange: true, takerExchange: true },
        },
      },
    });

    const serialized = trades.map((t) => {
      // legOrder 무관하게 항상 동일한 매핑:
      // makerFilledPrice = makerCoin 매수 단가 (maker BID 체결가 or TAKER_SELL_FIRST 후속 IOC BID 체결가)
      // takerMarketBid  = takerCoin 매도 단가 (taker 시장가 ASK 체결가 or TAKER_SELL_FIRST 선행 ASK 체결가)
      const buyPriceKrw = t.makerFilledPrice ?? null;
      const sellPriceKrw = t.takerMarketBid ?? null;

      return {
        id: t.id.toString(),
        botId: t.botId,
        makerExchange: t.bot.makerExchange,
        takerExchange: t.bot.takerExchange,
        makerCoin: t.makerCoin,
        takerCoin: t.takerCoin,
        quantity: t.quantity.toString(),
        legOrder: t.legOrder,
        status: t.status,
        makerOrderPrice: t.makerOrderPrice,
        makerFilledPrice: t.makerFilledPrice ?? null,
        takerMarketBid: t.takerMarketBid ?? null,
        buyPriceKrw,
        sellPriceKrw,
        makerFilledAt: t.makerFilledAt?.toISOString() ?? null,
        takerExecutedAt: t.takerExecutedAt?.toISOString() ?? null,
        netProfitKrw: t.netProfitKrw ? Number(t.netProfitKrw) : null,
        feeKrw: t.feeKrw ? Number(t.feeKrw) : null,
        realizedSpreadBps: t.realizedSpreadBps ?? null,
        notes: t.notes,
        createdAt: t.createdAt.toISOString(),
      };
    });

    res.json({ trades: serialized });
  } catch (e) {
    next(e);
  }
};
