/**
 * USDT 구독 서비스
 *
 * USDT 결제를 통한 구독 관리
 * - 입금 요청 생성 (고유 코드 발급)
 * - 입금 상태 조회
 * - 구독 만료 관리
 */

import { config } from '../config/env';
import prisma from '../config/database';

interface DepositRequest {
  id: number;
  address: string;
  amount: number;          // 정확한 입금 금액 (10.XXXXXX)
  uniqueCode: string;      // 6자리 고유 코드
  expiresAt: Date;
  status: string;
}

interface DepositStatus {
  status: 'pending' | 'confirmed' | 'expired';
  txHash?: string;
  confirmedAmount?: number;
  confirmedAt?: Date;
  periodEnd?: Date;
}

class UsdtSubscriptionService {
  private readonly DEPOSIT_ADDRESS = config.tron.depositAddress;
  private readonly BASE_AMOUNT = config.usdt.subscriptionAmount;  // 10 USDT
  private readonly EXPIRE_HOURS = config.usdt.depositExpireHours; // 24시간

  /**
   * 입금 요청 생성
   */
  async createDepositRequest(userId: number): Promise<DepositRequest> {
    // 기존 pending 요청이 있으면 반환
    const existingDeposit = await prisma.usdtDeposit.findFirst({
      where: {
        userId,
        status: 'pending',
        expiresAt: { gt: new Date() }
      }
    });

    if (existingDeposit) {
      const amount = this.BASE_AMOUNT + parseInt(existingDeposit.uniqueCode) / 1000000;
      return {
        id: existingDeposit.id,
        address: existingDeposit.address,
        amount,
        uniqueCode: existingDeposit.uniqueCode,
        expiresAt: existingDeposit.expiresAt,
        status: existingDeposit.status,
      };
    }

    // 고유 코드 생성 (6자리 숫자)
    const uniqueCode = await this.generateUniqueCode();

    // 만료 시간
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + this.EXPIRE_HOURS);

    // 입금 요청 생성
    const deposit = await prisma.usdtDeposit.create({
      data: {
        userId,
        address: this.DEPOSIT_ADDRESS,
        uniqueCode,
        expectedAmount: this.BASE_AMOUNT,
        expiresAt,
      }
    });

    // 정확한 입금 금액 계산 (10.XXXXXX)
    const amount = this.BASE_AMOUNT + parseInt(uniqueCode) / 1000000;

    return {
      id: deposit.id,
      address: this.DEPOSIT_ADDRESS,
      amount,
      uniqueCode,
      expiresAt,
      status: 'pending',
    };
  }

  /**
   * 고유 코드 생성 (6자리)
   * 중복 방지 및 기존 코드 재사용 방지
   */
  private async generateUniqueCode(): Promise<string> {
    let attempts = 0;
    const maxAttempts = 100;

    while (attempts < maxAttempts) {
      // 100000 ~ 999999 사이의 랜덤 숫자
      const code = Math.floor(100000 + Math.random() * 900000).toString();

      // 중복 확인 (pending 상태만)
      const existing = await prisma.usdtDeposit.findFirst({
        where: {
          uniqueCode: code,
          status: 'pending',
        }
      });

      if (!existing) {
        return code;
      }

      attempts++;
    }

    throw new Error('고유 코드 생성 실패');
  }

  /**
   * 입금 상태 조회
   */
  async getDepositStatus(userId: number): Promise<DepositStatus | null> {
    // 가장 최근 입금 요청 조회
    const deposit = await prisma.usdtDeposit.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });

    if (!deposit) {
      return null;
    }

    // 만료 체크
    if (deposit.status === 'pending' && deposit.expiresAt < new Date()) {
      await prisma.usdtDeposit.update({
        where: { id: deposit.id },
        data: { status: 'expired' }
      });

      return { status: 'expired' };
    }

    if (deposit.status === 'confirmed') {
      // 구독 정보 조회
      const subscription = await prisma.subscription.findUnique({
        where: { userId }
      });

      return {
        status: 'confirmed',
        txHash: deposit.txHash || undefined,
        confirmedAmount: deposit.confirmedAmount || undefined,
        confirmedAt: deposit.confirmedAt || undefined,
        periodEnd: subscription?.currentPeriodEnd || undefined,
      };
    }

    return { status: deposit.status as 'pending' | 'confirmed' | 'expired' };
  }

  /**
   * 결제 내역 조회
   */
  async getPaymentHistory(userId: number) {
    return prisma.usdtPayment.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
  }

  /**
   * 현재 구독 정보 조회
   */
  async getSubscription(userId: number) {
    const subscription = await prisma.subscription.findUnique({
      where: { userId }
    });

    if (!subscription) {
      return {
        plan: 'free',
        status: 'active',
        paymentMethod: null,
        periodEnd: null,
        isExpired: false,
        isActive: false,
      };
    }

    // USDT 구독 만료 체크
    const isExpired = subscription.paymentMethod === 'usdt' &&
      subscription.currentPeriodEnd &&
      subscription.currentPeriodEnd < new Date();

    // USDT 구독 활성화 여부
    const isActive = subscription.paymentMethod === 'usdt' &&
      subscription.plan !== 'free' &&
      !isExpired;

    return {
      plan: isExpired ? 'free' : subscription.plan,
      status: subscription.status,
      paymentMethod: subscription.paymentMethod,
      periodEnd: subscription.currentPeriodEnd,
      isExpired,
      isActive,
    };
  }

  /**
   * 만료된 USDT 구독 다운그레이드
   * (매일 실행하는 cron job에서 호출)
   */
  async checkAndDowngradeExpiredSubscriptions(): Promise<number> {
    const now = new Date();

    const result = await prisma.subscription.updateMany({
      where: {
        paymentMethod: 'usdt',
        plan: { not: 'free' },
        currentPeriodEnd: { lt: now },
      },
      data: {
        plan: 'free',
        status: 'active',
      }
    });

    if (result.count > 0) {
      console.log(`[UsdtSubscription] ${result.count}개의 만료 구독 다운그레이드`);
    }

    return result.count;
  }

  /**
   * 사용량 조회
   */
  async getUsage(userId: number) {
    const subscription = await this.getSubscription(userId);

    const gridCount = await prisma.bot.count({ where: { userId } });
    const infiniteBuyCount = await prisma.infiniteBuyStock.count({
      where: { userId, strategy: { not: 'vr' } }
    });
    const vrCount = await prisma.infiniteBuyStock.count({
      where: { userId, strategy: 'vr' }
    });

    const limits = subscription.plan === 'free'
      ? { grid: 3, infiniteBuy: 2, vr: 1 }
      : { grid: Infinity, infiniteBuy: Infinity, vr: Infinity };

    return {
      plan: subscription.plan,
      grid: { current: gridCount, limit: limits.grid },
      infiniteBuy: { current: infiniteBuyCount, limit: limits.infiniteBuy },
      vr: { current: vrCount, limit: limits.vr },
    };
  }
}

export const usdtSubscriptionService = new UsdtSubscriptionService();
