import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { successResponse, errorResponse } from '../utils/response';
import { costBasisService } from '../services/cost-basis.service';

const STABLECOIN_TICKERS = ['KRW-USDS', 'KRW-USDE', 'KRW-USD1', 'KRW-USDC', 'KRW-USDT'];

// GET /api/cost-basis — 전체 스테이블코인 요약
export const getSummary = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const summary = await costBasisService.getAllStablecoinSummary(userId);
    return successResponse(res, summary);
  } catch (error) {
    next(error);
  }
};

// GET /api/cost-basis/:ticker — 특정 티커 상세
export const getTickerBasis = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const ticker = req.params.ticker.toUpperCase();
    // 'USDS' 형식으로 들어오면 'KRW-USDS'로 변환
    const fullTicker = ticker.startsWith('KRW-') ? ticker : `KRW-${ticker}`;
    if (!STABLECOIN_TICKERS.includes(fullTicker)) {
      return errorResponse(res, 'VALIDATION_ERROR', '지원하지 않는 티커입니다', 400);
    }
    const result = await costBasisService.getTickerCostBasis(userId, fullTicker);
    return successResponse(res, result);
  } catch (error) {
    next(error);
  }
};

// POST /api/cost-basis/manual-trades — 수동 거래 입력
export const createManualTrade = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const { ticker, type, price, quantity, note, tradedAt } = req.body;

    if (!ticker || !type || price == null || quantity == null) {
      return errorResponse(res, 'VALIDATION_ERROR', '필수 필드 누락 (ticker, type, price, quantity)', 400);
    }
    const fullTicker = String(ticker).toUpperCase().startsWith('KRW-')
      ? String(ticker).toUpperCase()
      : `KRW-${String(ticker).toUpperCase()}`;
    if (!STABLECOIN_TICKERS.includes(fullTicker)) {
      return errorResponse(res, 'VALIDATION_ERROR', '지원하지 않는 티커입니다', 400);
    }
    if (!['buy', 'sell'].includes(type)) {
      return errorResponse(res, 'VALIDATION_ERROR', 'type은 buy 또는 sell이어야 합니다', 400);
    }
    const priceNum = Number(price);
    const qtyNum = Number(quantity);
    if (isNaN(priceNum) || priceNum <= 0 || isNaN(qtyNum) || qtyNum <= 0) {
      return errorResponse(res, 'VALIDATION_ERROR', '가격과 수량은 양수여야 합니다', 400);
    }

    const trade = await costBasisService.createManualTrade(userId, {
      ticker: fullTicker,
      type,
      price: priceNum,
      quantity: qtyNum,
      note: note ?? undefined,
      tradedAt: tradedAt ?? undefined,
    });
    return successResponse(res, trade, '수동 거래가 기록되었습니다', 201);
  } catch (error) {
    next(error);
  }
};

// DELETE /api/cost-basis/manual-trades/:id — 수동 거래 삭제
export const deleteManualTrade = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return errorResponse(res, 'VALIDATION_ERROR', '유효하지 않은 ID입니다', 400);
    }
    await costBasisService.deleteManualTrade(userId, id);
    return successResponse(res, null, '거래 기록이 삭제되었습니다');
  } catch (error) {
    next(error);
  }
};
