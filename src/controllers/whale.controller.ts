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
    const status = whaleAlertService.getStatus();
    console.log(`[WhaleController] GET /api/whale called - isRunning: ${status.isRunning}, hasApiKey: ${status.hasApiKey}, lastFetchSuccess: ${status.lastFetchSuccess}, lastError: ${status.lastError}, totalTx: ${status.totalTransactions}`);

    // 특정 심볼 요청 시
    if (symbol) {
      const data = whaleAlertService.getData(symbol as string);
      const summaries = whaleAlertService.getAllSummaries();

      return successResponse(res, {
        transactions: data.transactions,
        summaries,
        status,
        timestamp: Date.now(),
      });
    }

    // 전체 요청 시 - WebSocket과 동일한 구조로 반환
    const allSummaries = whaleAlertService.getAllSummaries();

    // 심볼별로 거래 조회
    const transactionsBySymbol: Record<string, any[]> = {};
    const summariesBySymbol: Record<string, any> = {};

    for (const sym of ['btc', 'eth', 'xrp']) {
      const data = whaleAlertService.getData(sym);
      transactionsBySymbol[sym] = data.transactions;
      if (data.summary) {
        summariesBySymbol[sym] = data.summary;
      }
    }

    // summaries 배열에서도 심볼별로 매핑
    for (const summary of allSummaries) {
      summariesBySymbol[summary.symbol.toLowerCase()] = summary;
    }

    return successResponse(res, {
      transactions: transactionsBySymbol,
      summaries: summariesBySymbol,
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
