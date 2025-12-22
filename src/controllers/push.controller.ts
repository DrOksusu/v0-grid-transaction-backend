import { Response } from 'express';
import { PushService } from '../services/push.service';
import { successResponse, errorResponse } from '../utils/response';
import { AuthRequest } from '../types';

export class PushController {
  // VAPID 공개키 반환
  static async getVapidPublicKey(req: AuthRequest, res: Response) {
    try {
      const publicKey = await PushService.getVapidPublicKey();
      const isConfigured = await PushService.isConfigured();
      if (!publicKey || !isConfigured) {
        return errorResponse(res, 'VAPID_NOT_SET', 'VAPID 키가 설정되지 않았습니다', 500);
      }
      return successResponse(res, { publicKey });
    } catch (err: any) {
      console.error('[PushController] getVapidPublicKey 에러:', err);
      return errorResponse(res, 'SERVER_ERROR', err.message, 500);
    }
  }

  // 푸시 구독
  static async subscribe(req: AuthRequest, res: Response) {
    try {
      const userId = req.userId;
      if (!userId) {
        return errorResponse(res, 'UNAUTHORIZED', '인증이 필요합니다', 401);
      }

      const { subscription } = req.body;
      if (!subscription || !subscription.endpoint || !subscription.keys) {
        return errorResponse(res, 'INVALID_SUBSCRIPTION', '잘못된 구독 정보입니다', 400);
      }

      const userAgent = req.headers['user-agent'];
      const result = await PushService.subscribe(userId, subscription, userAgent);

      return successResponse(res, { message: '푸시 알림이 활성화되었습니다', id: result.id });
    } catch (err: any) {
      return errorResponse(res, 'SERVER_ERROR', err.message, 500);
    }
  }

  // 푸시 구독 해제
  static async unsubscribe(req: AuthRequest, res: Response) {
    try {
      const userId = req.userId;
      if (!userId) {
        return errorResponse(res, 'UNAUTHORIZED', '인증이 필요합니다', 401);
      }

      const { endpoint } = req.body;
      if (!endpoint) {
        return errorResponse(res, 'MISSING_ENDPOINT', 'endpoint가 필요합니다', 400);
      }

      await PushService.unsubscribe(userId, endpoint);
      return successResponse(res, { message: '푸시 알림이 비활성화되었습니다' });
    } catch (err: any) {
      return errorResponse(res, 'SERVER_ERROR', err.message, 500);
    }
  }

  // 테스트 푸시 전송
  static async sendTest(req: AuthRequest, res: Response) {
    try {
      const userId = req.userId;
      if (!userId) {
        return errorResponse(res, 'UNAUTHORIZED', '인증이 필요합니다', 401);
      }

      const results = await PushService.sendToUser(userId, {
        title: '테스트 알림',
        body: '푸시 알림이 정상적으로 작동합니다!',
        icon: '/icon-192x192.svg',
        tag: 'test',
      });

      return successResponse(res, { message: '테스트 푸시가 전송되었습니다', results });
    } catch (err: any) {
      return errorResponse(res, 'SERVER_ERROR', err.message, 500);
    }
  }
}
