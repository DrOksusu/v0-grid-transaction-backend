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

    // 디버그: 각 심볼별 최신 거래 timestamp 확인
    const debugInfo: string[] = [];
    for (const sym of ['btc', 'eth', 'xrp']) {
      const data = whaleAlertService.getData(sym);
      if (data.transactions.length > 0) {
        const latestTx = data.transactions[0];
        const txDate = new Date(latestTx.timestamp * 1000);
        const daysAgo = Math.floor((Date.now() - txDate.getTime()) / (1000 * 60 * 60 * 24));
        debugInfo.push(`${sym.toUpperCase()}: ${data.transactions.length}건, 최신=${daysAgo}일전`);
      } else {
        debugInfo.push(`${sym.toUpperCase()}: 0건`);
      }
    }
    console.log(`[WhaleController] GET /api/whale - status: isRunning=${status.isRunning}, hasApiKey=${status.hasApiKey}, lastFetchSuccess=${status.lastFetchSuccess}, lastError=${status.lastError}`);
    console.log(`[WhaleController] 거래현황: ${debugInfo.join(', ')}`);

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
