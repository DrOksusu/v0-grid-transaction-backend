/**
 * USDT 구독 API 라우트
 */

import { Router, Request, Response } from 'express';
import { authenticate } from '../middlewares/auth';
import { AuthRequest } from '../types';
import { usdtSubscriptionService } from '../services/usdt-subscription.service';
import { trc20MonitorService } from '../services/trc20-monitor.service';
import { config } from '../config/env';

const router = Router();

/**
 * 입금 요청 생성
 * POST /api/usdt/deposit
 */
router.post('/deposit', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;

    // 입금 주소 설정 확인
    if (!config.tron.depositAddress) {
      return res.status(503).json({
        success: false,
        error: 'USDT 결제가 현재 비활성화되어 있습니다.',
      });
    }

    const deposit = await usdtSubscriptionService.createDepositRequest(userId);

    res.json({
      success: true,
      data: {
        address: deposit.address,
        amount: deposit.amount,           // 정확한 금액 (10.XXXXXX)
        uniqueCode: deposit.uniqueCode,   // 6자리 코드
        baseAmount: config.usdt.subscriptionAmount,
        expiresAt: deposit.expiresAt,
        status: deposit.status,
        network: 'TRC-20',
        currency: 'USDT',
        instructions: [
          `정확히 ${deposit.amount.toFixed(6)} USDT를 전송해주세요`,
          '금액의 소수점이 사용자 식별에 사용됩니다',
          '다른 금액 전송 시 자동 인식이 불가능합니다',
          `만료: ${deposit.expiresAt.toLocaleString('ko-KR')}`,
        ],
      },
    });
  } catch (error: any) {
    console.error('[USDT] 입금 요청 생성 실패:', error);
    res.status(500).json({
      success: false,
      error: error.message || '입금 요청 생성에 실패했습니다.',
    });
  }
});

/**
 * 입금 상태 조회
 * GET /api/usdt/deposit/status
 */
router.get('/deposit/status', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const status = await usdtSubscriptionService.getDepositStatus(userId);

    if (!status) {
      return res.json({
        success: true,
        data: { status: 'none' },
      });
    }

    res.json({
      success: true,
      data: status,
    });
  } catch (error: any) {
    console.error('[USDT] 입금 상태 조회 실패:', error);
    res.status(500).json({
      success: false,
      error: error.message || '상태 조회에 실패했습니다.',
    });
  }
});

/**
 * 결제 내역 조회
 * GET /api/usdt/payments
 */
router.get('/payments', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const payments = await usdtSubscriptionService.getPaymentHistory(userId);

    res.json({
      success: true,
      data: payments,
    });
  } catch (error: any) {
    console.error('[USDT] 결제 내역 조회 실패:', error);
    res.status(500).json({
      success: false,
      error: error.message || '결제 내역 조회에 실패했습니다.',
    });
  }
});

/**
 * 구독 정보 조회
 * GET /api/usdt/subscription
 */
router.get('/subscription', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const subscription = await usdtSubscriptionService.getSubscription(userId);

    res.json({
      success: true,
      data: subscription,
    });
  } catch (error: any) {
    console.error('[USDT] 구독 정보 조회 실패:', error);
    res.status(500).json({
      success: false,
      error: error.message || '구독 정보 조회에 실패했습니다.',
    });
  }
});

/**
 * 사용량 조회
 * GET /api/usdt/usage
 */
router.get('/usage', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const usage = await usdtSubscriptionService.getUsage(userId);

    res.json({
      success: true,
      data: usage,
    });
  } catch (error: any) {
    console.error('[USDT] 사용량 조회 실패:', error);
    res.status(500).json({
      success: false,
      error: error.message || '사용량 조회에 실패했습니다.',
    });
  }
});

/**
 * 모니터링 상태 조회 (디버그용)
 * GET /api/usdt/monitor/status
 */
router.get('/monitor/status', async (req: Request, res: Response) => {
  try {
    const status = trc20MonitorService.getStatus();

    res.json({
      success: true,
      data: {
        ...status,
        config: {
          subscriptionAmount: config.usdt.subscriptionAmount,
          subscriptionDays: config.usdt.subscriptionDays,
          depositExpireHours: config.usdt.depositExpireHours,
        },
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
