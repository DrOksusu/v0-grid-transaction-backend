import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import * as arbService from '../services/stablecoin-arb.service';
import { getAllStablecoinOrderbooks } from '../services/upbit-price-manager';
import { AppError } from '../middlewares/errorHandler';
import { reconcileBotAssets } from '../services/maker-taker-asset-reconciliation.service';
import { stablecoinPrisma } from '../config/database';
import mainPrisma from '../config/database';
import { getBithumbStablecoinOrderbook, getAllBithumbStablecoinOrderbooks } from '../services/bithumb-stablecoin-ws-manager';
import { getAllCoinoneStablecoinOrderbooks, subscribeCoinoneStablecoinOrderbooks } from '../services/coinone-stablecoin-price-manager';

// 코인원 폴링은 컨트롤러 import 시점에 자동 시작 (모니터링 전용)
subscribeCoinoneStablecoinOrderbooks();
import { BithumbClient } from '../services/exchange/bithumb-client';
import { UpbitService } from '../services/upbit.service';
import { CoinoneClient } from '../services/exchange/coinone-client';
import { getCoinoneStablecoinOrderbook } from '../services/coinone-stablecoin-price-manager';
import { decrypt } from '../utils/encryption';

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
    if ('takerUpgradeBps' in body) {
      if (body.takerUpgradeBps !== null && (!Number.isInteger(body.takerUpgradeBps) || body.takerUpgradeBps < 0)) {
        throw new AppError('Invalid body: takerUpgradeBps must be null or non-negative integer', 400);
      }
      patch.takerUpgradeBps = body.takerUpgradeBps;
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

// ── 잔고 캐시 (rate limit 방지) ────────────────────────────────────────────────
const _balanceCache = new Map<
  string,
  {
    data: {
      bithumbBalances: Record<string, { available: number; locked: number }>;
      upbitBalances: Record<string, { available: number; locked: number }>;
      coinoneBalances: Record<string, { available: number; locked: number }>;
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
    let coinoneBalances: Record<string, { available: number; locked: number }> = {};

    const cached = _balanceCache.get(cacheKey);
    if (cached && now - cached.at < BALANCE_CACHE_TTL) {
      bithumbBalances = cached.data.bithumbBalances;
      upbitBalances = cached.data.upbitBalances;
      coinoneBalances = cached.data.coinoneBalances;
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

        // Coinone 잔고 조회
        try {
          const coinoneCred = await mainPrisma.credential.findFirst({
            where: { userId, exchange: 'coinone' },
          });
          if (coinoneCred) {
            const accessKey = decrypt(coinoneCred.apiKey);
            const secretKey = decrypt(coinoneCred.secretKey);
            const client = new CoinoneClient({ accessKey, secretKey });
            const balances = await client.getBalances();
            for (const [coin, entry] of Object.entries(balances)) {
              if (!coinoneBalances[coin]) {
                coinoneBalances[coin] = { available: 0, locked: 0 };
              }
              coinoneBalances[coin].available += entry.available;
              coinoneBalances[coin].locked += entry.locked;
            }
          }
        } catch {
          // 크레덴셜 없거나 조회 실패 시 빈 객체 유지
        }
      }

      _balanceCache.set(cacheKey, {
        data: { bithumbBalances, upbitBalances, coinoneBalances },
        at: now,
      });
    }

    // 3. 거래소별 perCoinRequired / krwRequired 집계
    const bithumbPerCoin: Record<string, { qty: number; botIds: number[] }> = {};
    const upbitPerCoin: Record<string, { qty: number; botIds: number[] }> = {};
    const coinonePerCoin: Record<string, { qty: number; botIds: number[] }> = {};
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

      // KRW 요건 계산 (현재 WS 가격 사용) — coinone은 코인→코인 스왑이라 KRW 불필요
      let askPrice: number;
      let krwRequired: number;
      if (makerExchange === 'bithumb') {
        const ob = getBithumbStablecoinOrderbook(bot.makerCoin);
        askPrice = ob?.ask ?? 1500;
        krwRequired = Math.ceil(qty * askPrice * 1.01);
      } else if (makerExchange === 'coinone') {
        const ob = getCoinoneStablecoinOrderbook(bot.makerCoin);
        askPrice = ob?.ask ?? 1500;
        krwRequired = 0; // coinone 코인→코인 스왑은 KRW 불필요
      } else {
        const upbitBooks = getAllStablecoinOrderbooks();
        const upbitOb = upbitBooks.get(`KRW-${bot.makerCoin}`);
        askPrice = upbitOb?.ask?.price ?? 1500;
        krwRequired = Math.ceil(qty * askPrice * 1.01);
      }

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
        } else if (makerExchange === 'coinone') {
          if (!coinonePerCoin[bot.makerCoin]) {
            coinonePerCoin[bot.makerCoin] = { qty: 0, botIds: [] };
          }
          coinonePerCoin[bot.makerCoin].qty += qty;
          coinonePerCoin[bot.makerCoin].botIds.push(bot.id);
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
          : makerExchange === 'coinone'
            ? (coinoneBalances[bot.makerCoin]?.available ?? 0)
            : (upbitBalances[bot.makerCoin]?.available ?? 0);
      const krwAvail =
        makerExchange === 'bithumb'
          ? (bithumbBalances['KRW']?.available ?? 0)
          : makerExchange === 'coinone'
            ? 0 // coinone은 KRW 불필요
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
        coinone: {
          balances: coinoneBalances,
          perCoinRequired: coinonePerCoin,
          krwRequired: { total: 0, botIds: [] },
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
      // legOrder 무관하게 동일한 의미:
      // makerFilledPrice = "매수가" (TAKER_SELL_FIRST: takerCoin BID 체결가, 그 외: makerCoin BID 체결가)
      // takerMarketBid   = "매도가" (TAKER_SELL_FIRST: makerCoin IOC 매도가, 그 외: takerCoin ASK 체결가)
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
        grossProfitKrw: t.grossProfitKrw ? Number(t.grossProfitKrw) : null,
        feeKrw: t.feeKrw ? Number(t.feeKrw) : null,
        takerFirstCostKrw: t.takerFirstCostKrw ? Number(t.takerFirstCostKrw) : null,
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

// ===== 모니터링 탭 — 실시간 호가 =====

/** GET /api/admin/stablecoin/orderbooks — 업비트 스테이블코인 5종 실시간 호가 */
export const getOrderbooks = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const all = getAllStablecoinOrderbooks();
    const coins = ['USDT', 'USDC', 'USD1', 'USDS', 'USDE'] as const;
    const books: Record<string, any> = {};
    for (const coin of coins) {
      const top = all.get(`KRW-${coin}`);
      if (top) {
        books[coin] = { bid: top.bid.price, ask: top.ask.price, bidSize: top.bid.size, askSize: top.ask.size };
      }
    }
    res.json({ updatedAt: new Date().toISOString(), books });
  } catch (e) {
    next(e);
  }
};

/** GET /api/admin/stablecoin/bithumb-orderbooks — 빗썸 스테이블코인 5종 실시간 호가 */
export const getBithumbOrderbooks = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const all = getAllBithumbStablecoinOrderbooks();
    const coins = ['USDT', 'USDC', 'USD1', 'USDS', 'USDE'] as const;
    const books: Record<string, any> = {};
    for (const coin of coins) {
      const top = all.get(coin);
      if (top) {
        books[coin] = { bid: top.bid, ask: top.ask, timestamp: top.timestamp };
      }
    }
    res.json({ books, fetchedAt: Date.now() });
  } catch (e) {
    next(e);
  }
};

/** GET /api/admin/stablecoin/coinone-orderbooks — 코인원 스테이블코인 5종 실시간 호가 */
export const getCoinoneOrderbooks = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const all = getAllCoinoneStablecoinOrderbooks();
    const coins = ['USDT', 'USDC', 'USD1', 'USDS', 'USDE'] as const;
    const books: Record<string, any> = {};
    for (const coin of coins) {
      const top = all.get(coin);
      if (top) {
        books[coin] = { bid: top.bid, ask: top.ask, timestamp: top.timestamp };
      }
    }
    res.json({ books, fetchedAt: Date.now() });
  } catch (e) {
    next(e);
  }
};

/** GET /api/admin/stablecoin/cross-exchange-latest — 업비트/빗썸/코인원 실시간 크로스 스프레드 */
export const getCrossExchangeLatest = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const upbitAll = getAllStablecoinOrderbooks();
    const bithumbAll = getAllBithumbStablecoinOrderbooks();
    const coinoneAll = getAllCoinoneStablecoinOrderbooks();
    const coins = ['USDT', 'USDC', 'USD1', 'USDS', 'USDE', 'RLUSD'];
    const snapshots = [];
    for (const coin of coins) {
      const ub = upbitAll.get(`KRW-${coin}`);
      const bh = bithumbAll.get(coin);
      const co = coinoneAll.get(coin);
      if (!ub && !bh && !co) continue;
      const upbitBid = ub?.bid.price ?? 0;
      const upbitAsk = ub?.ask.price ?? 0;
      const bithumbBid = bh?.bid ?? 0;
      const bithumbAsk = bh?.ask ?? 0;
      const coinoneBid = co?.bid ?? 0;
      const coinoneAsk = co?.ask ?? 0;
      const ubSpreadBps = (upbitBid > 0 && bithumbAsk > 0) ? Math.round(((upbitBid - bithumbAsk) / bithumbAsk) * 10000) : 0;
      const buSpreadBps = (bithumbBid > 0 && upbitAsk > 0) ? Math.round(((bithumbBid - upbitAsk) / upbitAsk) * 10000) : 0;
      const ucSpreadBps = (upbitBid > 0 && coinoneAsk > 0) ? Math.round(((upbitBid - coinoneAsk) / coinoneAsk) * 10000) : 0;
      const cuSpreadBps = (coinoneBid > 0 && upbitAsk > 0) ? Math.round(((coinoneBid - upbitAsk) / upbitAsk) * 10000) : 0;
      const bcSpreadBps = (bithumbBid > 0 && coinoneAsk > 0) ? Math.round(((bithumbBid - coinoneAsk) / coinoneAsk) * 10000) : 0;
      const cbSpreadBps = (coinoneBid > 0 && bithumbAsk > 0) ? Math.round(((coinoneBid - bithumbAsk) / bithumbAsk) * 10000) : 0;
      const maxSpreadBps = Math.max(ubSpreadBps, buSpreadBps, ucSpreadBps, cuSpreadBps, bcSpreadBps, cbSpreadBps);
      snapshots.push({
        id: coin,
        market: coin,
        upbitBid: String(upbitBid),
        upbitAsk: String(upbitAsk),
        bithumbBid: String(bithumbBid),
        bithumbAsk: String(bithumbAsk),
        coinoneBid: String(coinoneBid),
        coinoneAsk: String(coinoneAsk),
        ubSpreadBps: String(ubSpreadBps),
        buSpreadBps: String(buSpreadBps),
        maxSpreadBps: String(maxSpreadBps),
        timestamp: new Date().toISOString(),
      });
    }
    res.json({ snapshots, fetchedAt: Date.now() });
  } catch (e) {
    next(e);
  }
};
