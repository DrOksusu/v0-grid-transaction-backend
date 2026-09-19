import { Response, NextFunction } from 'express';
import mainPrisma from '../config/database';
import { successResponse, errorResponse } from '../utils/response';
import { AuthRequest } from '../types';

export async function createBot(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.userId!;
    const { symbol, minSpreadBps, anomalyMaxBps, maxOrderKrw, dailyMaxKrw, dailyMaxCount, fallbackMode, buyFeeBps } = req.body;
    if (!symbol || typeof maxOrderKrw !== 'number') {
      return errorResponse(res, 'VALIDATION_ERROR', 'symbol, maxOrderKrw 필수', 400);
    }
    const bot = await mainPrisma.inventoryArbBot.create({
      data: {
        userId, symbol: String(symbol).toUpperCase(),
        minSpreadBps: minSpreadBps ?? 30, anomalyMaxBps: anomalyMaxBps ?? 2000,
        maxOrderKrw, dailyMaxKrw: dailyMaxKrw ?? null, dailyMaxCount: dailyMaxCount ?? null,
        fallbackMode: fallbackMode === 'hold' ? 'hold' : 'market_flatten',
        buyFeeBps: buyFeeBps ?? 5,
        // enabled/autoExecute/killSwitch는 스키마 기본값(전부 안전측) 사용 — 생성 시 켜지 않음
      },
    });
    return successResponse(res, bot, undefined, 201);
  } catch (e) { next(e); }
}

export async function getBots(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.userId!;
    const bots = await mainPrisma.inventoryArbBot.findMany({ where: { userId }, orderBy: { id: 'desc' } });
    return successResponse(res, bots);
  } catch (e) { next(e); }
}

export async function getTrades(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.userId!;
    const botId = Number(req.params.id);
    const bot = await mainPrisma.inventoryArbBot.findFirst({ where: { id: botId, userId } });
    if (!bot) return errorResponse(res, 'NOT_FOUND', 'not found', 404);
    const trades = await mainPrisma.inventoryArbTrade.findMany({ where: { botId }, orderBy: { id: 'desc' }, take: 100 });
    return successResponse(res, trades);
  } catch (e) { next(e); }
}

export async function updateBot(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.userId!;
    const botId = Number(req.params.id);
    const bot = await mainPrisma.inventoryArbBot.findFirst({ where: { id: botId, userId } });
    if (!bot) return errorResponse(res, 'NOT_FOUND', 'not found', 404);

    const allowed = ['minSpreadBps', 'anomalyMaxBps', 'maxOrderKrw', 'dailyMaxKrw', 'dailyMaxCount', 'fallbackMode', 'buyFeeBps', 'autoExecute', 'enabled', 'killSwitch'] as const;
    const data: Record<string, any> = {};
    for (const k of allowed) if (k in req.body) data[k] = req.body[k];

    // enabled false→true 전환 시 lastResumeAt 기록 (canary 관찰 기준)
    if (data.enabled === true && !bot.enabled) data.lastResumeAt = new Date();

    const updated = await mainPrisma.inventoryArbBot.update({ where: { id: botId }, data });
    return successResponse(res, updated);
  } catch (e) { next(e); }
}

export async function deleteBot(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.userId!;
    const botId = Number(req.params.id);
    const bot = await mainPrisma.inventoryArbBot.findFirst({ where: { id: botId, userId } });
    if (!bot) return errorResponse(res, 'NOT_FOUND', 'not found', 404);
    await mainPrisma.inventoryArbTrade.deleteMany({ where: { botId } });
    await mainPrisma.inventoryArbBot.delete({ where: { id: botId } });
    return res.status(204).end();
  } catch (e) { next(e); }
}
