import { Response, NextFunction } from 'express';
import { successResponse, errorResponse } from '../utils/response';
import { AuthRequest } from '../types';
import { infiniteBuyService } from '../services/infinite-buy.service';
import { infiniteBuyScheduler } from '../services/infinite-buy-scheduler.service';
import { InfiniteBuyStatus } from '@prisma/client';

// 종목 생성
export const createStock = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const {
      ticker,
      name,
      exchange,
      buyAmount,
      totalRounds,
      targetProfit,
      autoEnabled,
      buyTime,
      buyCondition,
      autoStart,
    } = req.body;

    if (!ticker || !name || !buyAmount) {
      return errorResponse(
        res,
        'VALIDATION_ERROR',
        '티커, 종목명, 1회 매수금액은 필수입니다',
        400
      );
    }

    if (buyAmount < 10) {
      return errorResponse(
        res,
        'VALIDATION_ERROR',
        '1회 매수금액은 최소 $10 이상이어야 합니다',
        400
      );
    }

    const stock = await infiniteBuyService.createStock({
      userId,
      ticker,
      name,
      exchange,
      buyAmount,
      totalRounds,
      targetProfit,
      autoEnabled,
      buyTime,
      buyCondition,
      autoStart,
    });

    return successResponse(
      res,
      {
        id: stock.id.toString(),
        ticker: stock.ticker,
        name: stock.name,
        exchange: stock.exchange,
        status: stock.status,
        buyAmount: stock.buyAmount,
        totalRounds: stock.totalRounds,
        targetProfit: stock.targetProfit,
        currentRound: stock.currentRound,
        totalInvested: stock.totalInvested,
        totalQuantity: stock.totalQuantity,
        avgPrice: stock.avgPrice,
        targetPrice: 0,
        autoEnabled: stock.autoEnabled,
        buyTime: stock.buyTime,
        buyCondition: stock.buyCondition,
        createdAt: stock.createdAt.toISOString(),
      },
      '종목이 추가되었습니다',
      201
    );
  } catch (error: any) {
    if (error.message === '이미 등록된 종목입니다') {
      return errorResponse(res, 'STOCK_ALREADY_EXISTS', error.message, 409);
    }
    next(error);
  }
};

// 전체 종목 조회
export const getStocks = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const { status } = req.query;

    let statusFilter: InfiniteBuyStatus | undefined;
    if (status && ['buying', 'completed', 'stopped'].includes(status as string)) {
      statusFilter = status as InfiniteBuyStatus;
    }

    const data = await infiniteBuyService.getStocks(userId, statusFilter);

    return successResponse(res, data);
  } catch (error) {
    next(error);
  }
};

// 종목 상세 조회
export const getStock = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const stockId = parseInt(req.params.id);

    if (isNaN(stockId)) {
      return errorResponse(res, 'VALIDATION_ERROR', '유효하지 않은 종목 ID입니다', 400);
    }

    const data = await infiniteBuyService.getStock(userId, stockId);

    return successResponse(res, data);
  } catch (error: any) {
    if (error.message === '종목을 찾을 수 없습니다') {
      return errorResponse(res, 'STOCK_NOT_FOUND', error.message, 404);
    }
    next(error);
  }
};

// 종목 설정 수정
export const updateStock = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const stockId = parseInt(req.params.id);
    const { buyAmount, totalRounds, targetProfit, autoEnabled, buyTime, buyCondition } = req.body;

    if (isNaN(stockId)) {
      return errorResponse(res, 'VALIDATION_ERROR', '유효하지 않은 종목 ID입니다', 400);
    }

    const updated = await infiniteBuyService.updateStock(userId, stockId, {
      buyAmount,
      totalRounds,
      targetProfit,
      autoEnabled,
      buyTime,
      buyCondition,
    });

    return successResponse(res, updated, '설정이 업데이트되었습니다');
  } catch (error: any) {
    if (error.message === '종목을 찾을 수 없습니다') {
      return errorResponse(res, 'STOCK_NOT_FOUND', error.message, 404);
    }
    next(error);
  }
};

// 종목 삭제
export const deleteStock = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const stockId = parseInt(req.params.id);

    if (isNaN(stockId)) {
      return errorResponse(res, 'VALIDATION_ERROR', '유효하지 않은 종목 ID입니다', 400);
    }

    await infiniteBuyService.deleteStock(userId, stockId);

    return successResponse(res, null, '종목이 삭제되었습니다');
  } catch (error: any) {
    if (error.message === '종목을 찾을 수 없습니다') {
      return errorResponse(res, 'STOCK_NOT_FOUND', error.message, 404);
    }
    next(error);
  }
};

// 수동 매수 실행
export const executeBuy = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const stockId = parseInt(req.params.id);
    const { amount } = req.body;

    if (isNaN(stockId)) {
      return errorResponse(res, 'VALIDATION_ERROR', '유효하지 않은 종목 ID입니다', 400);
    }

    const result = await infiniteBuyService.executeBuy(userId, stockId, amount);

    return successResponse(
      res,
      result,
      `${result.record.round}회차 매수가 완료되었습니다`
    );
  } catch (error: any) {
    if (error.message === '종목을 찾을 수 없습니다') {
      return errorResponse(res, 'STOCK_NOT_FOUND', error.message, 404);
    }
    if (error.message === '이미 익절 완료된 종목입니다') {
      return errorResponse(res, 'ALREADY_COMPLETED', error.message, 400);
    }
    if (error.message === '최대 분할 횟수에 도달했습니다') {
      return errorResponse(res, 'MAX_ROUNDS_REACHED', error.message, 400);
    }
    if (error.message.includes('한국투자증권 API')) {
      return errorResponse(res, 'KIS_NOT_CONNECTED', error.message, 400);
    }
    next(error);
  }
};

// 익절 (전량 매도)
export const executeSell = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const stockId = parseInt(req.params.id);
    const { quantity } = req.body;

    if (isNaN(stockId)) {
      return errorResponse(res, 'VALIDATION_ERROR', '유효하지 않은 종목 ID입니다', 400);
    }

    const result = await infiniteBuyService.executeSell(userId, stockId, quantity);

    const profitSign = (result.record.profit || 0) >= 0 ? '+' : '';
    const message = `익절이 완료되었습니다. 수익: ${profitSign}$${(result.record.profit || 0).toFixed(2)} (${profitSign}${(result.record.profitPercent || 0).toFixed(2)}%)`;

    return successResponse(res, result, message);
  } catch (error: any) {
    if (error.message === '종목을 찾을 수 없습니다') {
      return errorResponse(res, 'STOCK_NOT_FOUND', error.message, 404);
    }
    if (error.message === '이미 익절 완료된 종목입니다') {
      return errorResponse(res, 'ALREADY_COMPLETED', error.message, 400);
    }
    if (error.message === '매도할 수량이 없습니다') {
      return errorResponse(res, 'NO_QUANTITY', error.message, 400);
    }
    if (error.message.includes('한국투자증권 API')) {
      return errorResponse(res, 'KIS_NOT_CONNECTED', error.message, 400);
    }
    next(error);
  }
};

// 종목 중단
export const stopStock = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const stockId = parseInt(req.params.id);

    if (isNaN(stockId)) {
      return errorResponse(res, 'VALIDATION_ERROR', '유효하지 않은 종목 ID입니다', 400);
    }

    const result = await infiniteBuyService.stopStock(userId, stockId);

    return successResponse(res, result, '종목이 중단되었습니다');
  } catch (error: any) {
    if (error.message === '종목을 찾을 수 없습니다') {
      return errorResponse(res, 'STOCK_NOT_FOUND', error.message, 404);
    }
    if (error.message === '이미 익절 완료된 종목입니다') {
      return errorResponse(res, 'ALREADY_COMPLETED', error.message, 400);
    }
    if (error.message === '이미 중단된 종목입니다') {
      return errorResponse(res, 'ALREADY_STOPPED', error.message, 400);
    }
    next(error);
  }
};

// 종목 재개
export const resumeStock = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const stockId = parseInt(req.params.id);

    if (isNaN(stockId)) {
      return errorResponse(res, 'VALIDATION_ERROR', '유효하지 않은 종목 ID입니다', 400);
    }

    const result = await infiniteBuyService.resumeStock(userId, stockId);

    return successResponse(res, result, '종목이 재개되었습니다');
  } catch (error: any) {
    if (error.message === '종목을 찾을 수 없습니다') {
      return errorResponse(res, 'STOCK_NOT_FOUND', error.message, 404);
    }
    if (error.message === '익절 완료된 종목은 재개할 수 없습니다') {
      return errorResponse(res, 'ALREADY_COMPLETED', error.message, 400);
    }
    if (error.message === '이미 진행중인 종목입니다') {
      return errorResponse(res, 'ALREADY_BUYING', error.message, 400);
    }
    next(error);
  }
};

// 종목별 매수 기록 조회
export const getRecords = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const stockId = parseInt(req.params.id);
    const { type, limit } = req.query;

    if (isNaN(stockId)) {
      return errorResponse(res, 'VALIDATION_ERROR', '유효하지 않은 종목 ID입니다', 400);
    }

    const data = await infiniteBuyService.getRecords(
      userId,
      stockId,
      type as string | undefined,
      limit ? parseInt(limit as string) : undefined
    );

    return successResponse(res, data);
  } catch (error: any) {
    if (error.message === '종목을 찾을 수 없습니다') {
      return errorResponse(res, 'STOCK_NOT_FOUND', error.message, 404);
    }
    next(error);
  }
};

// 전체 히스토리 조회
export const getHistory = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const { ticker, type, startDate, endDate, limit, offset } = req.query;

    const data = await infiniteBuyService.getHistory(userId, {
      ticker: ticker as string | undefined,
      type: type as string | undefined,
      startDate: startDate as string | undefined,
      endDate: endDate as string | undefined,
      limit: limit ? parseInt(limit as string) : undefined,
      offset: offset ? parseInt(offset as string) : undefined,
    });

    return successResponse(res, data);
  } catch (error) {
    next(error);
  }
};

// 오늘의 매수 예정 조회
export const getTodaySchedule = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;

    const data = await infiniteBuyService.getTodaySchedule(userId);

    return successResponse(res, data);
  } catch (error) {
    next(error);
  }
};

// 대시보드 요약 정보
export const getSummary = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;

    const data = await infiniteBuyService.getSummary(userId);

    return successResponse(res, data);
  } catch (error) {
    next(error);
  }
};

// =====================
// 스케줄러 제어 API
// =====================

// 스케줄러 상태 조회
export const getSchedulerStatus = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const status = infiniteBuyScheduler.getStatus();
    return successResponse(res, status);
  } catch (error) {
    next(error);
  }
};

// 수동 매수 트리거
export const triggerManualBuy = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    await infiniteBuyScheduler.runManualBuy();
    return successResponse(res, null, '수동 매수가 트리거되었습니다');
  } catch (error) {
    next(error);
  }
};

// 수동 가격 체크 트리거
export const triggerPriceCheck = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    await infiniteBuyScheduler.runManualPriceCheck();
    return successResponse(res, null, '가격 체크가 트리거되었습니다');
  } catch (error) {
    next(error);
  }
};

// 스케줄러 설정 변경
export const updateSchedulerConfig = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { autoBuyEnabled, autoSellEnabled, priceCheckInterval } = req.body;

    infiniteBuyScheduler.updateConfig({
      autoBuyEnabled,
      autoSellEnabled,
      priceCheckInterval,
    });

    const status = infiniteBuyScheduler.getStatus();
    return successResponse(res, status, '스케줄러 설정이 변경되었습니다');
  } catch (error) {
    next(error);
  }
};
