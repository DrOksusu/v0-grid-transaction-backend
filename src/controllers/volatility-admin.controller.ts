import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { AppError } from '../middlewares/errorHandler';
import * as vbService from '../services/volatility-breakout.service';
import { runBacktest } from '../services/volatility-backtest.service';

const MARKET_RE = /^KRW-[A-Z0-9]+$/;

// buyAmountKrw / k / stopLossPct 필드 검증
function validateBotFields(body: Record<string, unknown>, partial: boolean) {
  if (!partial || body.buyAmountKrw !== undefined) {
    if (typeof body.buyAmountKrw !== 'number' || body.buyAmountKrw < 5000) {
      throw new AppError('buyAmountKrw는 5000 이상 숫자여야 합니다', 400);
    }
  }
  if (body.k !== undefined && (typeof body.k !== 'number' || body.k < 0.1 || body.k > 2)) {
    throw new AppError('k는 0.1~2 사이 숫자여야 합니다', 400);
  }
  if (
    body.stopLossPct !== undefined &&
    (typeof body.stopLossPct !== 'number' || body.stopLossPct < 0.5 || body.stopLossPct > 50)
  ) {
    throw new AppError('stopLossPct는 0.5~50 사이 숫자여야 합니다', 400);
  }
}

// GET /admin/volatility/bots
export const listBots = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await vbService.listBots(req.userId!));
  } catch (e) {
    next(e);
  }
};

// POST /admin/volatility/bots
export const createBot = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.market !== 'string' || !MARKET_RE.test(body.market)) {
      throw new AppError('market은 KRW-XXX 형식이어야 합니다', 400);
    }
    validateBotFields(body, false);
    const bot = await vbService.createBot({
      userId: req.userId!,
      market: body.market,
      buyAmountKrw: body.buyAmountKrw as number,
      k: body.k as number | undefined,
      stopLossPct: body.stopLossPct as number | undefined,
    });
    res.json(bot);
  } catch (e) {
    next(e);
  }
};

// PUT /admin/volatility/bots/:id
export const updateBot = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw new AppError('Invalid id', 400);

    const body = (req.body ?? {}) as Record<string, unknown>;
    validateBotFields(body, true);

    const patch: Record<string, unknown> = {};
    for (const f of ['buyAmountKrw', 'k', 'stopLossPct'] as const) {
      if (body[f] !== undefined) patch[f] = body[f];
    }
    for (const f of ['live', 'enabled'] as const) {
      if (body[f] !== undefined) {
        if (typeof body[f] !== 'boolean') throw new AppError(`${f}는 boolean이어야 합니다`, 400);
        patch[f] = body[f];
      }
    }
    if (Object.keys(patch).length === 0) throw new AppError('수정할 필드가 없습니다', 400);

    res.json(await vbService.updateBot(req.userId!, id, patch as Parameters<typeof vbService.updateBot>[2]));
  } catch (e) {
    next(e);
  }
};

// DELETE /admin/volatility/bots/:id
export const deleteBot = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw new AppError('Invalid id', 400);
    await vbService.deleteBot(req.userId!, id);
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
};

// GET /admin/volatility/bots/:id/trades
export const listTrades = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw new AppError('Invalid id', 400);
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(String(req.query.pageSize ?? '20'), 10) || 20),
    );
    res.json(await vbService.listTrades(req.userId!, id, page, pageSize));
  } catch (e) {
    next(e);
  }
};

// POST /admin/volatility/backtest
export const backtest = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.market !== 'string' || !MARKET_RE.test(body.market)) {
      throw new AppError('market은 KRW-XXX 형식이어야 합니다', 400);
    }
    if (typeof body.k !== 'number' || body.k < 0.1 || body.k > 2) {
      throw new AppError('k는 0.1~2 사이 숫자여야 합니다', 400);
    }
    if (
      typeof body.stopLossPct !== 'number' ||
      body.stopLossPct < 0.5 ||
      body.stopLossPct > 50
    ) {
      throw new AppError('stopLossPct는 0.5~50 사이 숫자여야 합니다', 400);
    }
    if (![1, 2, 4, 8].includes(body.years as number)) {
      throw new AppError('years는 1|2|4|8 중 하나여야 합니다', 400);
    }
    res.json(
      await runBacktest({
        market: body.market,
        k: body.k,
        stopLossPct: body.stopLossPct,
        years: body.years as number,
      }),
    );
  } catch (e) {
    next(e);
  }
};
