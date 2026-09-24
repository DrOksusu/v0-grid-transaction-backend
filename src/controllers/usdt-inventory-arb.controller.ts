import { Response, NextFunction } from 'express';
import mainPrisma from '../config/database';
import { successResponse, errorResponse } from '../utils/response';
import { AuthRequest } from '../types';
import { usdtInventoryService } from '../services/inventory-arb/usdt-inventory.service';

/** USDT권 재고형 아비(Gate↔MEXC) 봇 목록 */
export async function getBots(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.userId!;
    const bots = await mainPrisma.usdtInventoryArbBot.findMany({ where: { userId }, orderBy: { id: 'desc' } });
    // 각 봇 거래 요약(건수·순이익 총/오늘) 첨부 — 프론트에서 수익을 한눈에
    const KST = 9 * 60 * 60 * 1000;
    const kst = new Date(Date.now() + KST); kst.setUTCHours(0, 0, 0, 0);
    const dayStart = new Date(kst.getTime() - KST);
    const withSummary = await Promise.all(bots.map(async (b) => {
      const rows = await mainPrisma.usdtInventoryArbTrade.findMany({
        where: { botId: b.id, status: { in: ['filled', 'partial_flattened'] } },
        select: { netUsdt: true, createdAt: true },
      });
      const today = rows.filter((r) => r.createdAt >= dayStart);
      return {
        ...b,
        summary: {
          tradeCount: rows.length,
          netUsdtTotal: rows.reduce((s, r) => s + r.netUsdt, 0),
          todayCount: today.length,
          todayNetUsdt: today.reduce((s, r) => s + r.netUsdt, 0),
        },
      };
    }));
    return successResponse(res, withSummary);
  } catch (e) { next(e); }
}

/** 봇 생성 — 기본 enabled=false/autoExecute=false(스키마 기본값) 유지, 생성 시 켜지 않음 */
export async function createBot(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.userId!;
    const { symbol, buyExchange, sellExchange, thresholdPct, orderUsdt, dailyMaxCount, dailyMaxLossUsdt } = req.body;
    const bot = await mainPrisma.usdtInventoryArbBot.create({
      data: {
        userId,
        symbol: symbol ? String(symbol).toUpperCase() : undefined,
        buyExchange: buyExchange ?? undefined,
        sellExchange: sellExchange ?? undefined,
        thresholdPct: thresholdPct ?? undefined,
        orderUsdt: orderUsdt ?? undefined,
        dailyMaxCount: dailyMaxCount ?? undefined,
        dailyMaxLossUsdt: dailyMaxLossUsdt ?? undefined,
        // enabled/autoExecute/killSwitch는 스키마 기본값(전부 안전측) 사용
      },
    });
    return successResponse(res, bot, undefined, 201);
  } catch (e) { next(e); }
}

/** 봇 수정 — thresholdPct/orderUsdt/enabled/autoExecute/killSwitch 등 */
export async function updateBot(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.userId!;
    const botId = Number(req.params.id);
    const bot = await mainPrisma.usdtInventoryArbBot.findFirst({ where: { id: botId, userId } });
    if (!bot) return errorResponse(res, 'NOT_FOUND', 'not found', 404);

    const allowed = ['thresholdPct', 'orderUsdt', 'dailyMaxCount', 'dailyMaxLossUsdt', 'buyExchange', 'sellExchange', 'autoExecute', 'enabled', 'killSwitch'] as const;
    const data: Record<string, any> = {};
    for (const k of allowed) if (k in req.body) data[k] = req.body[k];

    const updated = await mainPrisma.usdtInventoryArbBot.update({ where: { id: botId }, data });
    return successResponse(res, updated);
  } catch (e) { next(e); }
}

/** 봇 삭제 (거래 이력 포함 정리) */
export async function deleteBot(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.userId!;
    const botId = Number(req.params.id);
    const bot = await mainPrisma.usdtInventoryArbBot.findFirst({ where: { id: botId, userId } });
    if (!bot) return errorResponse(res, 'NOT_FOUND', 'not found', 404);
    await mainPrisma.usdtInventoryArbTrade.deleteMany({ where: { botId } });
    await mainPrisma.usdtInventoryArbBot.delete({ where: { id: botId } });
    return res.status(204).end();
  } catch (e) { next(e); }
}

/** 봇 실시간 상태 (read-only, 주문 없음) — 호가·갭·순차익·재고·대기사유 */
export async function getStatus(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.userId!;
    const botId = Number(req.params.id);
    const bot = await mainPrisma.usdtInventoryArbBot.findFirst({ where: { id: botId, userId } });
    if (!bot) return errorResponse(res, 'NOT_FOUND', 'not found', 404);
    const status = await usdtInventoryService.getLiveStatus(bot);
    return successResponse(res, status);
  } catch (e) { next(e); }
}

/** 봇 거래 이력 (최근 100건) */
export async function getTrades(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.userId!;
    const botId = Number(req.params.id);
    const bot = await mainPrisma.usdtInventoryArbBot.findFirst({ where: { id: botId, userId } });
    if (!bot) return errorResponse(res, 'NOT_FOUND', 'not found', 404);
    const trades = await mainPrisma.usdtInventoryArbTrade.findMany({ where: { botId }, orderBy: { id: 'desc' }, take: 100 });
    return successResponse(res, trades);
  } catch (e) { next(e); }
}
