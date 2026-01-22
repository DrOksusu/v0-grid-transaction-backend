import { Router, Request, Response } from 'express';
import { authenticate } from '../middlewares/auth';
import {
  createDonationRequest,
  getDonationStatus,
  checkAndConfirmDeposits,
} from '../services/upbit-donation.service';
import { DonationCurrency } from '@prisma/client';

const router = Router();

/**
 * POST /api/upbit-donation/request
 * 후원 요청 생성
 */
router.post('/request', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { currency } = req.body as { currency?: DonationCurrency };

    if (!currency || !['KRW', 'USDT'].includes(currency)) {
      return res.status(400).json({ error: 'currency는 KRW 또는 USDT여야 합니다' });
    }

    const result = await createDonationRequest(userId, currency);

    // 안내 메시지 생성
    const instructions = currency === 'KRW'
      ? [
          '업비트 앱에서 "입출금" → "원화" → "보내기"를 선택하세요',
          `받는 분: ${result.depositAddress}`,
          `정확히 ${result.expectedAmount.toLocaleString()}원을 보내주세요`,
          '금액이 정확해야 자동으로 인식됩니다',
          `${Math.floor((result.expiresAt.getTime() - Date.now()) / 3600000)}시간 내에 입금해주세요`,
        ]
      : [
          '업비트 앱에서 "입출금" → "USDT" → "보내기"를 선택하세요',
          `네트워크: TRC-20 (트론)`,
          `받는 주소: ${result.depositAddress}`,
          `정확히 ${result.expectedAmount.toFixed(6)} USDT를 보내주세요`,
          '소수점 금액이 사용자 식별에 사용됩니다',
          `${Math.floor((result.expiresAt.getTime() - Date.now()) / 3600000)}시간 내에 입금해주세요`,
        ];

    res.json({
      ...result,
      instructions,
    });
  } catch (error: any) {
    console.error('[UpbitDonation] 요청 생성 실패:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/upbit-donation/status
 * 후원 상태 확인
 */
router.get('/status', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const currency = req.query.currency as DonationCurrency | undefined;

    const result = await getDonationStatus(userId, currency);

    res.json(result);
  } catch (error: any) {
    console.error('[UpbitDonation] 상태 조회 실패:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/upbit-donation/check
 * 입금 확인 (수동 트리거)
 */
router.post('/check', authenticate, async (req: Request, res: Response) => {
  try {
    const result = await checkAndConfirmDeposits();

    res.json({
      message: '입금 확인 완료',
      ...result,
    });
  } catch (error: any) {
    console.error('[UpbitDonation] 입금 확인 실패:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
