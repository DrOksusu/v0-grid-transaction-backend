import { Request, Response } from 'express';
import { maIndicatorService } from '../services/ma-indicator.service';

export class MAController {
  // GET /api/ma - 현재 MA 지표 조회
  async getIndicator(req: Request, res: Response) {
    try {
      let indicator = maIndicatorService.getCurrentIndicator();

      // 캐시된 데이터가 없으면 새로 계산
      if (!indicator) {
        indicator = await maIndicatorService.calculateIndicator();
      }

      if (!indicator) {
        return res.status(503).json({
          success: false,
          error: 'MA indicator data not available',
        });
      }

      res.json({
        success: true,
        data: indicator,
      });
    } catch (error) {
      console.error('[MAController] Failed to get indicator:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get MA indicator',
      });
    }
  }

  // GET /api/ma/status - 서비스 상태 조회
  async getStatus(req: Request, res: Response) {
    try {
      const status = maIndicatorService.getStatus();

      res.json({
        success: true,
        data: status,
      });
    } catch (error) {
      console.error('[MAController] Failed to get status:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get service status',
      });
    }
  }

  // POST /api/ma/refresh - 수동 갱신 (개발/테스트용)
  async refresh(req: Request, res: Response) {
    try {
      const indicator = await maIndicatorService.calculateIndicator();

      if (!indicator) {
        return res.status(503).json({
          success: false,
          error: 'Failed to refresh MA indicator',
        });
      }

      res.json({
        success: true,
        data: indicator,
        message: 'MA indicator refreshed',
      });
    } catch (error) {
      console.error('[MAController] Failed to refresh:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to refresh MA indicator',
      });
    }
  }
}

export const maController = new MAController();
