import { Router, Request, Response } from 'express';
import { authenticate } from '../middlewares/auth';
import prisma from '../config/database';
import { DonationCurrency, DonationStatus } from '@prisma/client';

const router = Router();

// 관리자 이메일
const ADMIN_EMAIL = 'ok4192@hanmail.net';

/**
 * 관리자 권한 확인 미들웨어
 */
async function requireAdmin(req: Request, res: Response, next: Function) {
  const userId = (req as any).userId;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });

  if (!user || user.email !== ADMIN_EMAIL) {
    return res.status(403).json({ error: '관리자 권한이 필요합니다' });
  }

  next();
}

/**
 * GET /api/admin/donations
 * 후원 목록 조회
 */
router.get('/donations', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { status, currency, page = '1', limit = '20' } = req.query;

    const where: any = {};
    if (status) where.status = status as DonationStatus;
    if (currency) where.currency = currency as DonationCurrency;

    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const skip = (pageNum - 1) * limitNum;

    const [donations, total] = await Promise.all([
      prisma.upbitDonation.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum,
      }),
      prisma.upbitDonation.count({ where }),
    ]);

    res.json({
      donations,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error: any) {
    console.error('[AdminDonation] 목록 조회 실패:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/admin/donations/stats
 * 후원 통계
 */
router.get('/donations/stats', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    // 전체 통계
    const [totalStats, krwStats, usdtStats, pendingCount, confirmedCount, expiredCount] = await Promise.all([
      // 전체 confirmed 금액
      prisma.upbitDonation.aggregate({
        where: { status: 'confirmed' },
        _sum: { confirmedAmount: true },
        _count: true,
      }),
      // KRW confirmed 금액
      prisma.upbitDonation.aggregate({
        where: { status: 'confirmed', currency: 'KRW' },
        _sum: { confirmedAmount: true },
        _count: true,
      }),
      // USDT confirmed 금액
      prisma.upbitDonation.aggregate({
        where: { status: 'confirmed', currency: 'USDT' },
        _sum: { confirmedAmount: true },
        _count: true,
      }),
      // pending 수
      prisma.upbitDonation.count({ where: { status: 'pending' } }),
      // confirmed 수
      prisma.upbitDonation.count({ where: { status: 'confirmed' } }),
      // expired 수
      prisma.upbitDonation.count({ where: { status: 'expired' } }),
    ]);

    // 최근 7일 일별 통계
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const recentDonations = await prisma.upbitDonation.findMany({
      where: {
        status: 'confirmed',
        confirmedAt: { gte: sevenDaysAgo },
      },
      select: {
        confirmedAt: true,
        confirmedAmount: true,
        currency: true,
      },
    });

    // 일별 그룹화
    const dailyStats: Record<string, { krw: number; usdt: number; count: number }> = {};
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      dailyStats[dateStr] = { krw: 0, usdt: 0, count: 0 };
    }

    recentDonations.forEach((d) => {
      if (d.confirmedAt) {
        const dateStr = d.confirmedAt.toISOString().split('T')[0];
        if (dailyStats[dateStr]) {
          dailyStats[dateStr].count++;
          if (d.currency === 'KRW') {
            dailyStats[dateStr].krw += d.confirmedAmount || 0;
          } else {
            dailyStats[dateStr].usdt += d.confirmedAmount || 0;
          }
        }
      }
    });

    res.json({
      total: {
        count: totalStats._count,
        amount: totalStats._sum.confirmedAmount || 0,
      },
      byStatus: {
        pending: pendingCount,
        confirmed: confirmedCount,
        expired: expiredCount,
      },
      byCurrency: {
        KRW: {
          count: krwStats._count,
          amount: krwStats._sum.confirmedAmount || 0,
        },
        USDT: {
          count: usdtStats._count,
          amount: usdtStats._sum.confirmedAmount || 0,
        },
      },
      daily: Object.entries(dailyStats).map(([date, data]) => ({
        date,
        ...data,
      })),
    });
  } catch (error: any) {
    console.error('[AdminDonation] 통계 조회 실패:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/donations/:id/confirm
 * 수동 후원 확인 (관리자)
 */
router.post('/donations/:id/confirm', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const donationId = parseInt(req.params.id);
    const { txId, confirmedAmount } = req.body;

    if (!txId || !confirmedAmount) {
      return res.status(400).json({ error: 'txId와 confirmedAmount가 필요합니다' });
    }

    const donation = await prisma.upbitDonation.findUnique({
      where: { id: donationId },
      include: { user: true },
    });

    if (!donation) {
      return res.status(404).json({ error: '후원을 찾을 수 없습니다' });
    }

    if (donation.status !== 'pending') {
      return res.status(400).json({ error: '대기 중인 후원만 확인할 수 있습니다' });
    }

    const now = new Date();
    const periodStart = now;
    const periodEnd = new Date(now);
    periodEnd.setDate(periodEnd.getDate() + 30);

    await prisma.$transaction([
      prisma.upbitDonation.update({
        where: { id: donationId },
        data: {
          status: 'confirmed',
          txId,
          confirmedAmount: parseFloat(confirmedAmount),
          confirmedAt: now,
          periodStart,
          periodEnd,
        },
      }),
      prisma.subscription.upsert({
        where: { userId: donation.userId },
        update: {
          plan: 'pro',
          status: 'active',
          paymentMethod: 'usdt',
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
        },
        create: {
          userId: donation.userId,
          plan: 'pro',
          status: 'active',
          paymentMethod: 'usdt',
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
        },
      }),
    ]);

    res.json({ message: '후원이 확인되었습니다' });
  } catch (error: any) {
    console.error('[AdminDonation] 수동 확인 실패:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/admin/donations/:id
 * 후원 요청 삭제 (관리자)
 */
router.delete('/donations/:id', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const donationId = parseInt(req.params.id);

    await prisma.upbitDonation.delete({
      where: { id: donationId },
    });

    res.json({ message: '후원이 삭제되었습니다' });
  } catch (error: any) {
    console.error('[AdminDonation] 삭제 실패:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
