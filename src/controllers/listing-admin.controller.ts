import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { successResponse } from '../utils/response';
import { upbitListingMonitorService } from '../services/upbit-listing-monitor.service';
import { bithumbListingMonitorService } from '../services/bithumb-listing-monitor.service';
import {
  listingAutoTraderService,
  ListingSourceType,
} from '../services/listing-auto-trader.service';

/**
 * 요청에서 source 추출 (UPBIT 기본값).
 * query/body 모두 string으로 들어오므로 대문자 정규화 후 'BITHUMB'만 BITHUMB로 매핑.
 * 알 수 없는 값은 UPBIT fallback — 기존 클라이언트(source 미전송)와 호환 보장.
 */
function extractSource(value: unknown): ListingSourceType {
  return typeof value === 'string' && value.toUpperCase() === 'BITHUMB'
    ? 'BITHUMB'
    : 'UPBIT';
}

/**
 * UPBIT 전용 핸들러용 가드 — BITHUMB 요청 시 400 응답.
 * createManual / triggerSnapshot / fetchCurrentPrices 등 빗썸 서비스에 해당 메서드가
 * 없는 핸들러에서 silent 라우팅 사고 방지.
 */
function rejectIfBithumb(
  source: ListingSourceType,
  res: Response,
  operation: string,
): boolean {
  if (source === 'BITHUMB') {
    res.status(400).json({
      success: false,
      message: `${operation}은(는) 현재 UPBIT에서만 지원됩니다. (BITHUMB 미지원)`,
    });
    return true;
  }
  return false;
}

/**
 * POST /api/admin/listings/manual
 * 공지를 수동으로 등록하고 즉시 가격 스냅샷 수집 (현재 UPBIT 전용)
 * Body: { ticker: string, title?: string, source?: string }
 */
export const createManual = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const source = extractSource(req.body?.source);
    if (rejectIfBithumb(source, res, '수동 공지 등록')) return;

    const { ticker, title } = req.body as { ticker: string; title?: string };
    if (!ticker) {
      res.status(400).json({ success: false, message: 'ticker 필드가 필요합니다.' });
      return;
    }
    const upperTicker = ticker.toUpperCase();
    const noticeTitle = title || `[수동 등록] 업비트 원화(KRW) 마켓 ${upperTicker} 추가 안내`;

    // noticeId: 수동 등록은 음수 ID 사용 (자동 감지와 충돌 방지)
    // timestamp 기반으로 유니크하게 생성
    const manualNoticeId = -(Date.now() % 1_000_000);

    const announcement = await upbitListingMonitorService.createManualEntry(
      manualNoticeId, noticeTitle, upperTicker
    );
    return successResponse(res, announcement);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/listings
 * 상장 공지 목록 조회 (최신순, source별 분기)
 * Query: ?source=UPBIT|BITHUMB&limit=50
 */
export const listAnnouncements = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const source = extractSource(req.query.source);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const data = source === 'BITHUMB'
      ? await bithumbListingMonitorService.listAnnouncements(limit)
      : await upbitListingMonitorService.listAnnouncements(limit);
    return successResponse(res, data);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/listings/:id
 * 개별 공지 + 전체 스냅샷 조회 (source별 필터 적용)
 */
export const getAnnouncement = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const source = extractSource(req.query.source);
    const id = Number(req.params.id);
    const data = source === 'BITHUMB'
      ? await bithumbListingMonitorService.getAnnouncement(id)
      : await upbitListingMonitorService.getAnnouncement(id);
    if (!data) {
      res.status(404).json({ success: false, message: '공지를 찾을 수 없습니다.' });
      return;
    }
    return successResponse(res, data);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/admin/listings/:id/snapshot
 * 특정 공지에 대해 지금 즉시 가격 스냅샷 수동 실행 (현재 UPBIT 전용)
 * Body: { snapshotType: string, source?: string }
 */
export const triggerSnapshot = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const source = extractSource(req.body?.source ?? req.query.source);
    if (rejectIfBithumb(source, res, '수동 스냅샷 실행')) return;

    const id = Number(req.params.id);
    const { snapshotType = 'manual' } = req.body;

    const announcement = await upbitListingMonitorService.getAnnouncement(id);
    if (!announcement) {
      res.status(404).json({ success: false, message: '공지를 찾을 수 없습니다.' });
      return;
    }
    if (!announcement.ticker) {
      res.status(400).json({ success: false, message: '티커가 파싱되지 않은 공지입니다.' });
      return;
    }

    await upbitListingMonitorService.captureSnapshots(id, announcement.ticker, snapshotType);
    const updated = await upbitListingMonitorService.getAnnouncement(id);
    return successResponse(res, updated);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/listings/:id/prices
 * 특정 티커의 현재 멀티거래소 가격 즉시 조회 (DB 저장 없음, 현재 UPBIT 전용)
 */
export const fetchCurrentPrices = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const source = extractSource(req.query.source);
    if (rejectIfBithumb(source, res, '실시간 가격 조회')) return;

    const id = Number(req.params.id);
    const announcement = await upbitListingMonitorService.getAnnouncement(id);
    if (!announcement?.ticker) {
      res.status(400).json({ success: false, message: '티커가 없는 공지입니다.' });
      return;
    }

    const prices = await upbitListingMonitorService.fetchAllPrices(announcement.ticker);
    return successResponse(res, { ticker: announcement.ticker, prices });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/listings/auto-trade/config?source=UPBIT|BITHUMB
 * 자동매수 설정 조회 (source별)
 */
export const getAutoTradeConfig = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const source = extractSource(req.query.source);
    const config = await listingAutoTraderService.getConfig(source);
    return successResponse(res, config);
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/admin/listings/auto-trade/config
 * 자동매수/매도 설정 변경 (source별)
 * Body: { source?, enabled?, amountKrw?, useBinance?, useBithumb?, useMexc?, autoSellEnabled?, takeProfitPct?, stopLossPct?, maxHoldMinutes? }
 */
export const updateAutoTradeConfig = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const source = extractSource(req.body?.source);
    const {
      enabled, amountKrw, useBinance, useBithumb, useMexc, useGateio,
      autoSellEnabled, takeProfitPct, stopLossPct, maxHoldMinutes,
    } = req.body;
    const config = await listingAutoTraderService.updateConfig(source, {
      enabled, amountKrw, useBinance, useBithumb, useMexc, useGateio,
      autoSellEnabled, takeProfitPct, stopLossPct, maxHoldMinutes,
    });
    return successResponse(res, config);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/listings/auto-trade/orders?source=UPBIT|BITHUMB&limit=50
 * 최근 자동매수 주문 이력 조회 (source 필터)
 */
export const listAutoOrders = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const source = extractSource(req.query.source);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const orders = await listingAutoTraderService.listRecentOrders(limit, source);
    return successResponse(res, orders);
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /api/admin/listings/auto-trade/orders/:id
 * 매수 체결 수량/평균가 수동 보정 (잘못 기록된 주문 정정).
 * 주문 id가 PK이므로 source 분기 없음 — listingAutoOrder는 source 정보를 자체적으로 보유.
 * Body: { filledQty?: number, filledPrice?: number }
 */
export const correctAutoOrder = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ success: false, message: '유효한 주문 id가 필요합니다.' });
      return;
    }

    const { filledQty, filledPrice } = req.body as { filledQty?: number; filledPrice?: number };
    const patch: { filledQty?: number; filledPrice?: number } = {};
    if (filledQty !== undefined) {
      if (typeof filledQty !== 'number' || !Number.isFinite(filledQty) || filledQty < 0) {
        res.status(400).json({ success: false, message: 'filledQty는 0 이상의 숫자여야 합니다.' });
        return;
      }
      patch.filledQty = filledQty;
    }
    if (filledPrice !== undefined) {
      if (typeof filledPrice !== 'number' || !Number.isFinite(filledPrice) || filledPrice < 0) {
        res.status(400).json({ success: false, message: 'filledPrice는 0 이상의 숫자여야 합니다.' });
        return;
      }
      patch.filledPrice = filledPrice;
    }
    if (patch.filledQty === undefined && patch.filledPrice === undefined) {
      res.status(400).json({ success: false, message: 'filledQty 또는 filledPrice 중 하나는 필요합니다.' });
      return;
    }

    const updated = await listingAutoTraderService.correctOrderFill(id, patch);
    return successResponse(res, updated);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/listings/auto-trade/check-permissions
 * Binance API 키 스팟 거래 권한 확인 (source 무관 — Binance 계정 단일)
 */
export const checkBinancePermissions = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await listingAutoTraderService.checkBinancePermissions();
    return successResponse(res, result);
  } catch (error) {
    next(error);
  }
};
