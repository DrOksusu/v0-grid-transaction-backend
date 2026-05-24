// 내부 전용 웹훅 — 외부 자동화(CCR 등)에서 카카오 알림 발송
import { Router, Request, Response } from 'express';
import { kakaoNotifyService } from '../services/kakao-notify.service';

const router = Router();

router.post('/kakao/send', async (req: Request, res: Response) => {
  const token = req.headers['x-internal-token'];
  if (!token || token !== process.env.INTERNAL_API_TOKEN) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { message, link } = req.body as { message?: string; link?: string };
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    res.status(400).json({ error: 'message 필드가 필요합니다' });
    return;
  }

  await kakaoNotifyService.sendToMe(message.trim(), link);
  res.json({ ok: true });
});

export default router;
