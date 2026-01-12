import { Request, Response, NextFunction } from 'express';
import { successResponse } from '../utils/response';
import { whaleAlertService } from '../services/whale-alert.service';

/**
 * 고래 활동 데이터 조회
 * GET /api/whale
 */
export const getWhaleActivity = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { symbol } = req.query;

    const data = whaleAlertService.getData(symbol as string | undefined);
    const summaries = whaleAlertService.getAllSummaries();
    const status = whaleAlertService.getStatus();

    return successResponse(res, {
      transactions: data.transactions,
      summaries,
      status,
      timestamp: Date.now(),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * 고래 서비스 상태 조회
 * GET /api/whale/status
 */
export const getWhaleStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const status = whaleAlertService.getStatus();
    return successResponse(res, status);
  } catch (error) {
    next(error);
  }
};
