/**
 * CME 갭 매매 봇 컨트롤러
 *
 * 관리자 전용 API (authenticate + requireAdmin 미들웨어 적용).
 * 라우트 정의는 src/routes/cme-gap.ts 참고.
 */

import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { cmeGapService } from '../services/cme-gap.service';
import { UpbitService } from '../services/upbit.service';

// ─────────────────────────────────────────────────────────────────────────────
// 봇 CRUD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /admin/cme-gap/bots
 * 전체 봇 목록 조회
 */
export const getBots = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const bots = await cmeGapService.getBots();
    res.json({ bots });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /admin/cme-gap/bots
 * 봇 생성
 * body: { name?, quantity, minGapPct, enabled?, live? }
 */
export const createBot = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { name, quantity, minGapPct, enabled, live } = req.body;

    if (quantity === undefined || quantity === null) {
      res.status(400).json({ error: 'quantity 필드가 필요합니다 (BTC 수량, 예: 0.01)' });
      return;
    }
    if (minGapPct === undefined || minGapPct === null) {
      res.status(400).json({ error: 'minGapPct 필드가 필요합니다 (최소 갭 크기 %, 예: 0.3)' });
      return;
    }

    const bot = await cmeGapService.createBot({
      name,
      quantity: Number(quantity),
      minGapPct: Number(minGapPct),
      enabled,
      live,
    });
    res.status(201).json({ bot });
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /admin/cme-gap/bots/:id
 * 봇 수정
 * body: { name?, quantity?, minGapPct?, enabled?, live? }
 */
export const updateBot = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: '유효하지 않은 봇 ID' });
      return;
    }

    const { name, quantity, minGapPct, enabled, live } = req.body;
    const bot = await cmeGapService.updateBot(id, {
      name,
      ...(quantity !== undefined && { quantity: Number(quantity) }),
      ...(minGapPct !== undefined && { minGapPct: Number(minGapPct) }),
      enabled,
      live,
    });
    res.json({ bot });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /admin/cme-gap/bots/:id
 * 봇 삭제 (연결된 갭 레코드 포함 삭제)
 */
export const deleteBot = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: '유효하지 않은 봇 ID' });
      return;
    }

    await cmeGapService.deleteBot(id);
    res.json({ message: `봇 #${id} 삭제 완료` });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 갭 조회 및 통계
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /admin/cme-gap/gaps
 * 갭 목록 조회
 * query: { status?, botId? }
 */
export const getGaps = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const status = req.query.status as string | undefined;
    const botId = req.query.botId ? parseInt(req.query.botId as string, 10) : undefined;

    const gaps = await cmeGapService.getGaps({
      ...(status && { status }),
      ...(botId !== undefined && !isNaN(botId) && { botId }),
    });
    res.json({ gaps });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /admin/cme-gap/stats
 * 통계 요약 조회
 */
export const getStats = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const stats = await cmeGapService.getStats();
    res.json({ stats });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 수동 트리거 (테스트용)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /admin/cme-gap/trigger/friday
 * 수동으로 fridayClose 기록 트리거
 * 토요일 07:00이 아닌 시간에도 테스트할 때 사용
 */
export const triggerFriday = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // 강제로 기록 플래그 초기화 후 실행
    cmeGapService.resetRecordedFlags();
    await cmeGapService.recordFridayClose();

    const ticker = await UpbitService.getCurrentPrice('KRW-BTC');
    res.json({
      message: '금요일 종가 기록 완료',
      price: ticker?.trade_price,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /admin/cme-gap/trigger/monday
 * 수동으로 mondayOpen + 갭 감지 트리거
 * body: { fridayCloseKrw? } — fridayCloseKrw를 수동으로 지정할 경우 사용
 */
export const triggerMonday = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // fridayCloseKrw를 body에서 지정하면 인메모리 값 오버라이드
    if (req.body.fridayCloseKrw) {
      const now = new Date();
      // 임시 weekKey (현재 주차 기반)
      const weekKey = `${now.getUTCFullYear()}-W00-TEST`;
      cmeGapService.setFridayCloseKrw(Number(req.body.fridayCloseKrw), weekKey);
    }

    cmeGapService.resetRecordedFlags();
    await cmeGapService.recordMondayOpenAndDetectGaps();
    res.json({ message: '월요일 시가 + 갭 감지 트리거 완료' });
  } catch (error) {
    next(error);
  }
};
