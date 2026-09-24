import { Response, NextFunction } from 'express';
import mainPrisma from '../config/database';
import { successResponse, errorResponse } from '../utils/response';
import { AuthRequest } from '../types';
import { inventoryArbService, MANUAL_BOT_SYMBOL } from '../services/inventory-arb.service';
import { scanForeignSpreads } from '../services/inventory-arb/foreign-spread-scanner';

/** 해외 거래소(바이낸스↔MEXC) 재고-무관 스프레드 스캔 (정보용, 관리자 minSpreadBps 지정) */
export async function getForeignSpreads(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const raw = req.query.minSpreadBps != null ? Number(req.query.minSpreadBps) : 30;
    const minSpreadBps = Number.isFinite(raw) && raw >= 0 ? raw : 30;
    const spreads = await scanForeignSpreads(minSpreadBps);
    return successResponse(res, spreads);
  } catch (e) { next(e); }
}

/** 온디맨드 후보 스캔 (내 잔고 + 공통상장 + 라이브 스프레드) */
export async function getCandidates(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.userId!;
    const minSpreadBps = req.query.minSpreadBps != null ? Number(req.query.minSpreadBps) : 30;
    const candidates = await inventoryArbService.scanCandidates(
      userId,
      Number.isFinite(minSpreadBps) && minSpreadBps >= 0 ? minSpreadBps : 30,
    );
    return successResponse(res, candidates);
  } catch (e) { next(e); }
}

/** 수동 1회 실거래 실행 (후보 화면 "즉시 실행"). 클릭 시점 재검증 후 executeArb 1회. */
export async function postExecute(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.userId!;
    const { symbol, maxKrw, minSpreadBps } = req.body;
    if (!symbol || typeof maxKrw !== 'number' || maxKrw <= 0) {
      return errorResponse(res, 'VALIDATION_ERROR', 'symbol, maxKrw(양수) 필수', 400);
    }
    const result = await inventoryArbService.executeManual(
      userId,
      String(symbol).toUpperCase(),
      maxKrw,
      typeof minSpreadBps === 'number' && minSpreadBps >= 0 ? minSpreadBps : 30,
    );
    return successResponse(res, result);
  } catch (e) { next(e); }
}

export async function createBot(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.userId!;
    // USDT 봇과 통일된 파라미터: thresholdPct(순차익%)·orderKrw(고정규모)·dailyMaxLossKrw
    const { symbol, thresholdPct, orderKrw, dailyMaxCount, dailyMaxLossKrw, anomalyMaxBps } = req.body;
    if (!symbol || typeof orderKrw !== 'number') {
      return errorResponse(res, 'VALIDATION_ERROR', 'symbol, orderKrw 필수', 400);
    }
    const bot = await mainPrisma.inventoryArbBot.create({
      data: {
        userId, symbol: String(symbol).toUpperCase(),
        thresholdPct: thresholdPct ?? 2, orderKrw,
        dailyMaxCount: dailyMaxCount ?? null, dailyMaxLossKrw: dailyMaxLossKrw ?? null,
        anomalyMaxBps: anomalyMaxBps ?? 2000, // 내부 안전장치(이상치 가드) 유지
        maxOrderKrw: orderKrw, // 레거시 required 컬럼 — orderKrw와 동일값으로 채움(봇 로직 미사용)
        // enabled/autoExecute/killSwitch는 스키마 기본값(전부 안전측) — 생성 시 켜지 않음
      },
    });
    return successResponse(res, bot, undefined, 201);
  } catch (e) { next(e); }
}

export async function getBots(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.userId!;
    const bots = await mainPrisma.inventoryArbBot.findMany({ where: { userId, symbol: { not: MANUAL_BOT_SYMBOL } }, orderBy: { id: 'desc' } });
    return successResponse(res, bots);
  } catch (e) { next(e); }
}

/** 봇 실시간 상태 (read-only, 주문 없음) — 호가·갭·순차익·재고·대기사유 */
export async function getStatus(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.userId!;
    const botId = Number(req.params.id);
    const bot = await mainPrisma.inventoryArbBot.findFirst({ where: { id: botId, userId } });
    if (!bot) return errorResponse(res, 'NOT_FOUND', 'not found', 404);
    const status = await inventoryArbService.getLiveStatus(bot);
    return successResponse(res, status);
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

    const allowed = ['thresholdPct', 'orderKrw', 'dailyMaxCount', 'dailyMaxLossKrw', 'anomalyMaxBps', 'autoExecute', 'enabled', 'killSwitch'] as const;
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
