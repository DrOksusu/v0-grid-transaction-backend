import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { successResponse, errorResponse } from '../utils/response';
import { generalArbScannerService } from '../services/general-arb-scanner.service';
import { generalArbScannerAgent } from '../agents/general-arb-scanner-agent';

/**
 * GET /api/admin/general-arb/config
 * 일반 아비트리지 스캐너 설정 조회.
 * 설정 row 없으면 id=1로 기본값 생성 후 반환.
 */
export const getConfig = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const config = await generalArbScannerService.getConfig();
    return successResponse(res, config);
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /api/admin/general-arb/config
 * 일반 아비트리지 스캐너 설정 부분 업데이트.
 * Body: { thresholdPct?: number, minIntervalSec?: number, isEnabled?: boolean }
 */
export const patchConfig = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { thresholdPct, minIntervalSec, isEnabled } = req.body;
    const config = await generalArbScannerService.patchConfig({
      thresholdPct,
      minIntervalSec,
      isEnabled,
    });
    return successResponse(res, config);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/general-arb/symbols
 * 감시 종목 목록 조회 (활성/비활성 포함).
 */
export const listSymbols = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const symbols = await generalArbScannerService.listWatchedSymbols();
    return successResponse(res, { symbols });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/admin/general-arb/symbols
 * 감시 종목 추가 (upsert — 비활성화된 종목이면 재활성화).
 * Body: { symbol: string }
 * 추가 후 에이전트 구독 재시작.
 */
export const addSymbol = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { symbol } = req.body;
    if (!symbol || typeof symbol !== 'string') {
      return errorResponse(res, 'INVALID_SYMBOL', '심볼을 입력해주세요', 400);
    }
    const normalized = symbol.toUpperCase().trim();
    await generalArbScannerService.addSymbol(normalized);
    // 에이전트 구독 재시작 (새 종목 가격 스트림 등록)
    await generalArbScannerAgent.restartSubscriptions();
    return successResponse(res, { symbol: normalized });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/admin/general-arb/symbols/:symbol
 * 감시 종목 비활성화 (물리 삭제 아님 — isActive=false).
 * 제거 후 에이전트 구독 재시작.
 */
export const removeSymbol = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { symbol } = req.params;
    await generalArbScannerService.removeSymbol(symbol.toUpperCase());
    // 에이전트 구독 재시작 (제거 종목 가격 스트림 해제)
    await generalArbScannerAgent.restartSubscriptions();
    return successResponse(res, { symbol: symbol.toUpperCase() });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/general-arb/spreads
 * 인메모리 현재 스프레드 스냅샷 전체 반환.
 * DB 조회 없이 에이전트가 유지하는 인메모리 데이터 사용.
 */
export const getSpreads = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const spreads = generalArbScannerService.getSnapshots();
    return successResponse(res, { spreads });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/general-arb/opportunities
 * 아비트리지 기회 이력 조회.
 * Query: limit (기본 50, 최대 200), symbol (선택 — 특정 종목 필터)
 */
export const listOpportunities = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const symbol = req.query.symbol as string | undefined;
    const opportunities = await generalArbScannerService.listOpportunities(
      limit,
      symbol?.toUpperCase(),
    );
    return successResponse(res, { opportunities });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/general-arb/opportunities/stats
 * 아비트리지 기회 통계 (최근 7일, 심볼별 count/avgSpread/maxSpread).
 * 라우트 등록 순서 주의: /opportunities보다 먼저 등록해야 매칭됨.
 */
export const getOpportunityStats = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const stats = await generalArbScannerService.getOpportunityStats();
    return successResponse(res, { stats });
  } catch (error) {
    next(error);
  }
};
