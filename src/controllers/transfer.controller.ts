// src/controllers/transfer.controller.ts
//
// 거래소 간 코인 이체 컨트롤러.
// 기존 컨트롤러 패턴(AuthRequest, successResponse/errorResponse, next(error)) 그대로 따름.

import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { successResponse, errorResponse } from '../utils/response';
import { TransferService } from '../services/transfer.service';

const transferService = new TransferService();

/**
 * GET /api/transfer/balances
 * 업비트 + 빗썸 스테이블코인 잔고 조회
 */
export const getBalances = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const balances = await transferService.getTransferBalances(userId);
    return successResponse(res, balances);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/transfer/prepare
 * 이체 준비: 도착지 입금 주소 조회 + DB에 prepared 상태 저장
 *
 * body: { fromExchange, toExchange, currency, netType, amount }
 */
export const prepareTransfer = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const { fromExchange, toExchange, currency, netType, amount } = req.body;

    if (!fromExchange || !toExchange || !currency || !netType || !amount) {
      return errorResponse(res, 'VALIDATION_ERROR', '필수 필드가 누락되었습니다 (fromExchange, toExchange, currency, netType, amount)', 400);
    }

    if (!['upbit', 'bithumb'].includes(fromExchange) || !['upbit', 'bithumb'].includes(toExchange)) {
      return errorResponse(res, 'VALIDATION_ERROR', '지원하는 거래소: upbit, bithumb', 400);
    }

    const result = await transferService.prepareTransfer(userId, {
      fromExchange,
      toExchange,
      currency,
      netType,
      amount: String(amount),
    });

    return successResponse(res, result, '이체 준비 완료', 201);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/transfer/:id/execute
 * 이체 실행: prepared → 출금 요청 → requested/failed
 */
export const executeTransfer = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const transferId = parseInt(req.params.id, 10);

    if (isNaN(transferId)) {
      return errorResponse(res, 'VALIDATION_ERROR', '유효하지 않은 이체 ID입니다', 400);
    }

    const result = await transferService.executeTransfer(userId, transferId);
    return successResponse(res, result, '이체 요청이 전송되었습니다');
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/transfer
 * 이체 이력 목록 조회 (최신순 50건)
 */
export const listTransfers = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId!;
    const transfers = await transferService.listTransfers(userId);
    return successResponse(res, transfers);
  } catch (error) {
    next(error);
  }
};
