import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { successResponse } from '../utils/response';
import { upbitListingMonitorService } from '../services/upbit-listing-monitor.service';
import { listingAutoTraderService } from '../services/listing-auto-trader.service';

/**
 * POST /api/admin/upbit-listings/manual
 * 공지를 수동으로 등록하고 즉시 가격 스냅샷 수집
 * Body: { ticker: string, title?: string }
 */
export const createManual = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
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
 * GET /api/admin/upbit-listings
 * 상장 공지 목록 조회 (최신순)
 */
export const listAnnouncements = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const data = await upbitListingMonitorService.listAnnouncements(limit);
    return successResponse(res, data);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/upbit-listings/:id
 * 개별 공지 + 전체 스냅샷 조회
 */
export const getAnnouncement = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const data = await upbitListingMonitorService.getAnnouncement(id);
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
 * POST /api/admin/upbit-listings/:id/snapshot
 * 특정 공지에 대해 지금 즉시 가격 스냅샷 수동 실행
 * Body: { snapshotType: string }
 */
export const triggerSnapshot = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
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
 * GET /api/admin/upbit-listings/:id/prices
 * 특정 티커의 현재 멀티거래소 가격 즉시 조회 (DB 저장 없음)
 */
export const fetchCurrentPrices = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
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
 * GET /api/admin/upbit-listings/auto-trade/config
 * 자동매수 설정 조회
 */
export const getAutoTradeConfig = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const config = await listingAutoTraderService.getConfig();
    return successResponse(res, config);
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/admin/upbit-listings/auto-trade/config
 * 자동매수/매도 설정 변경
 * Body: { enabled?, amountKrw?, useBinance?, useBithumb?, useMexc?, autoSellEnabled?, takeProfitPct?, stopLossPct?, maxHoldMinutes? }
 */
export const updateAutoTradeConfig = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const {
      enabled, amountKrw, useBinance, useBithumb, useMexc,
      autoSellEnabled, takeProfitPct, stopLossPct, maxHoldMinutes,
    } = req.body;
    const config = await listingAutoTraderService.updateConfig({
      enabled, amountKrw, useBinance, useBithumb, useMexc,
      autoSellEnabled, takeProfitPct, stopLossPct, maxHoldMinutes,
    });
    return successResponse(res, config);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/upbit-listings/auto-trade/orders
 * 최근 자동매수 주문 이력 조회
 */
export const listAutoOrders = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const orders = await listingAutoTraderService.listRecentOrders(limit);
    return successResponse(res, orders);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/upbit-listings/auto-trade/check-permissions
 * Binance API 키 스팟 거래 권한 확인
 */
export const checkBinancePermissions = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await listingAutoTraderService.checkBinancePermissions();
    return successResponse(res, result);
  } catch (error) {
    next(error);
  }
};
