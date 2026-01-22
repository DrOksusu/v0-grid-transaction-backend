import { PrismaClient, DonationCurrency, DonationStatus } from '@prisma/client';
import { UpbitService } from './upbit.service';
import { config } from '../config/env';
import { PushService } from './push.service';

const prisma = new PrismaClient();

// 운영자 업비트 서비스 (후원금 입금 확인용)
let adminUpbitService: UpbitService | null = null;

/**
 * 운영자 업비트 서비스 초기화
 */
function getAdminUpbitService(): UpbitService {
  if (!adminUpbitService) {
    if (!config.donation.upbitAccessKey || !config.donation.upbitSecretKey) {
      throw new Error('운영자 업비트 API 키가 설정되지 않았습니다');
    }
    adminUpbitService = new UpbitService({
      accessKey: config.donation.upbitAccessKey,
      secretKey: config.donation.upbitSecretKey,
    });
  }
  return adminUpbitService;
}

/**
 * 고유 금액 생성 (사용자 식별용)
 * KRW: 10,000원 + 랜덤 1~999원 (예: 10,123원)
 * USDT: 10 USDT + 랜덤 소수점 (예: 10.123456 USDT)
 */
async function generateUniqueAmount(currency: DonationCurrency): Promise<number> {
  const baseAmount = currency === 'KRW' ? config.donation.krwAmount : config.donation.usdtAmount;

  // 현재 pending 상태인 금액들 조회
  const pendingDonations = await prisma.upbitDonation.findMany({
    where: {
      currency,
      status: 'pending',
      expiresAt: { gt: new Date() },
    },
    select: { expectedAmount: true },
  });

  const usedAmounts = new Set(pendingDonations.map(d => d.expectedAmount));

  // 고유 금액 생성 (최대 100번 시도)
  for (let i = 0; i < 100; i++) {
    let amount: number;

    if (currency === 'KRW') {
      // KRW: 1~999원 랜덤 추가
      const randomPart = Math.floor(Math.random() * 999) + 1;
      amount = baseAmount + randomPart;
    } else {
      // USDT: 0.000001~0.999999 랜덤 추가
      const randomPart = Math.floor(Math.random() * 999999) + 1;
      amount = baseAmount + randomPart / 1000000;
      amount = Math.round(amount * 1000000) / 1000000; // 소수점 6자리
    }

    if (!usedAmounts.has(amount)) {
      return amount;
    }
  }

  throw new Error('고유 금액 생성에 실패했습니다. 잠시 후 다시 시도해주세요.');
}

/**
 * 후원 요청 생성
 */
export async function createDonationRequest(userId: number, currency: DonationCurrency) {
  // 기존 pending 요청 확인
  const existingRequest = await prisma.upbitDonation.findFirst({
    where: {
      userId,
      currency,
      status: 'pending',
      expiresAt: { gt: new Date() },
    },
  });

  if (existingRequest) {
    // 기존 요청 반환
    return {
      id: existingRequest.id,
      currency: existingRequest.currency,
      expectedAmount: existingRequest.expectedAmount,
      expiresAt: existingRequest.expiresAt,
      depositAddress: getDepositAddress(),
    };
  }

  // 고유 금액 생성
  const expectedAmount = await generateUniqueAmount(currency);

  // 만료 시간 설정
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + config.donation.depositExpireHours);

  // 후원 요청 생성
  const donation = await prisma.upbitDonation.create({
    data: {
      userId,
      currency,
      expectedAmount,
      expiresAt,
    },
  });

  return {
    id: donation.id,
    currency: donation.currency,
    expectedAmount: donation.expectedAmount,
    expiresAt: donation.expiresAt,
    depositAddress: getDepositAddress(),
  };
}

/**
 * 입금 주소 조회 (USDT TRC-20 전용)
 */
function getDepositAddress(): string {
  const usdtAddress = config.donation.upbitTronAddress;
  if (!usdtAddress) {
    throw new Error('USDT 입금 주소가 설정되지 않았습니다 (UPBIT_TRON_ADDRESS)');
  }
  return usdtAddress;
}

/**
 * 후원 상태 확인
 */
export async function getDonationStatus(userId: number, currency?: DonationCurrency) {
  const where: any = { userId };
  if (currency) where.currency = currency;

  const donations = await prisma.upbitDonation.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 5,
  });

  // 현재 활성 구독 확인
  const subscription = await prisma.subscription.findUnique({
    where: { userId },
  });

  const isActive = subscription?.plan === 'pro' &&
    subscription?.currentPeriodEnd &&
    subscription.currentPeriodEnd > new Date();

  return {
    donations,
    isActive,
    periodEnd: subscription?.currentPeriodEnd,
  };
}

/**
 * 입금 확인 및 후원 활성화
 */
export async function checkAndConfirmDeposits() {
  const upbitService = getAdminUpbitService();

  // pending 상태인 후원 요청 조회
  const pendingDonations = await prisma.upbitDonation.findMany({
    where: {
      status: 'pending',
      expiresAt: { gt: new Date() },
    },
  });

  if (pendingDonations.length === 0) {
    return { checked: 0, confirmed: 0 };
  }

  console.log(`[UpbitDonation] ${pendingDonations.length}개의 pending 요청 확인 중...`);

  let confirmed = 0;

  // USDT 입금 확인 (USDT만 지원)
  const usdtPending = pendingDonations.filter(d => d.currency === 'USDT');
  if (usdtPending.length > 0) {
    try {
      const usdtDeposits = await upbitService.getDeposits('USDT', 'accepted', 100);

      for (const donation of usdtPending) {
        // 금액이 일치하는 입금 찾기 (소수점 6자리까지 비교)
        const matchingDeposit = usdtDeposits.find((deposit: any) =>
          Math.abs(parseFloat(deposit.amount) - donation.expectedAmount) < 0.000001 &&
          new Date(deposit.done_at) > donation.createdAt
        );

        if (matchingDeposit) {
          await confirmDonation(donation.id, matchingDeposit.uuid, parseFloat(matchingDeposit.amount));
          confirmed++;
        }
      }
    } catch (error) {
      console.error('[UpbitDonation] USDT 입금 확인 실패:', error);
    }
  }

  // 만료된 요청 처리
  await prisma.upbitDonation.updateMany({
    where: {
      status: 'pending',
      expiresAt: { lte: new Date() },
    },
    data: {
      status: 'expired',
    },
  });

  return { checked: pendingDonations.length, confirmed };
}

/**
 * 후원 확인 및 구독 활성화
 */
async function confirmDonation(donationId: number, txId: string, confirmedAmount: number) {
  const donation = await prisma.upbitDonation.findUnique({
    where: { id: donationId },
    include: { user: true },
  });

  if (!donation || donation.status !== 'pending') {
    return;
  }

  const now = new Date();
  const periodStart = now;
  const periodEnd = new Date(now);
  periodEnd.setDate(periodEnd.getDate() + config.donation.subscriptionDays);

  // 트랜잭션으로 후원 확인 + 구독 업데이트
  await prisma.$transaction([
    // 후원 요청 업데이트
    prisma.upbitDonation.update({
      where: { id: donationId },
      data: {
        status: 'confirmed',
        txId,
        confirmedAmount,
        confirmedAt: now,
        periodStart,
        periodEnd,
      },
    }),
    // 구독 업데이트/생성
    prisma.subscription.upsert({
      where: { userId: donation.userId },
      update: {
        plan: 'pro',
        status: 'active',
        paymentMethod: 'usdt', // 업비트 후원도 동일하게 처리
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

  console.log(`[UpbitDonation] 후원 확인됨: userId=${donation.userId}, amount=${confirmedAmount}, txId=${txId}`);

  // 관리자에게 푸시 알림 전송
  try {
    await PushService.sendDonationNotificationToAdmin(
      donation.user.email,
      donation.currency,
      confirmedAmount
    );
  } catch (error) {
    console.error('[UpbitDonation] 관리자 알림 전송 실패:', error);
  }
}

/**
 * 수동 입금 확인 (관리자용)
 */
export async function manualConfirmDonation(donationId: number, txId: string, confirmedAmount: number) {
  await confirmDonation(donationId, txId, confirmedAmount);
}
