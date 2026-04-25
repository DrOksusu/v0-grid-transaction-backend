import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import * as arbService from '../services/stablecoin-arb.service';
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
    res.json(bot ?? {});
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
