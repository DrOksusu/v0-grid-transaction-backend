import { Router } from 'express';
import { PushController } from '../controllers/push.controller';
import { authenticate } from '../middlewares/auth';

const router = Router();

// VAPID 공개키 조회 (인증 불필요)
router.get('/vapid-public-key', PushController.getVapidPublicKey);

// 푸시 구독 (인증 필요)
router.post('/subscribe', authenticate, PushController.subscribe);

// 푸시 구독 해제 (인증 필요)
router.post('/unsubscribe', authenticate, PushController.unsubscribe);

// 테스트 푸시 전송 (인증 필요)
router.post('/test', authenticate, PushController.sendTest);

export default router;
