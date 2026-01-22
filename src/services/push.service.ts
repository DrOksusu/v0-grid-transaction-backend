import prisma from '../config/database';

// web-push 동적 import (CJS 호환성)
let webPush: any = null;
let vapidConfigured = false;

// VAPID 키 설정 (환경변수에서 로드)
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || '';
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || '';
const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

// 초기화 함수 (지연 로딩)
async function initWebPush() {
  if (webPush) return true;

  try {
    webPush = require('web-push');
    if (vapidPublicKey && vapidPrivateKey) {
      webPush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
      vapidConfigured = true;
      console.log('[PushService] VAPID 설정 완료');
    } else {
      console.warn('[PushService] VAPID 키가 설정되지 않음');
    }
    return true;
  } catch (error) {
    console.error('[PushService] web-push 초기화 실패:', error);
    return false;
  }
}

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  data?: Record<string, unknown>;
}

export class PushService {
  // VAPID 공개키 반환 (프론트엔드에서 구독 시 사용)
  static async getVapidPublicKey(): Promise<string> {
    await initWebPush();
    return vapidPublicKey;
  }

  // VAPID 설정 여부 확인
  static async isConfigured(): Promise<boolean> {
    await initWebPush();
    return vapidConfigured;
  }

  // 푸시 구독 저장
  static async subscribe(
    userId: number,
    subscription: {
      endpoint: string;
      keys: {
        p256dh: string;
        auth: string;
      };
    },
    userAgent?: string
  ) {
    // 기존 구독이 있으면 업데이트, 없으면 생성
    const existing = await prisma.pushSubscription.findFirst({
      where: {
        userId,
        endpoint: subscription.endpoint,
      },
    });

    if (existing) {
      return prisma.pushSubscription.update({
        where: { id: existing.id },
        data: {
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
          userAgent,
          updatedAt: new Date(),
        },
      });
    }

    return prisma.pushSubscription.create({
      data: {
        userId,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        userAgent,
      },
    });
  }

  // 푸시 구독 해제
  static async unsubscribe(userId: number, endpoint: string) {
    return prisma.pushSubscription.deleteMany({
      where: {
        userId,
        endpoint,
      },
    });
  }

  // 특정 사용자에게 푸시 전송
  static async sendToUser(userId: number, payload: PushPayload) {
    const initialized = await initWebPush();
    if (!initialized || !vapidConfigured) {
      console.warn('[PushService] 푸시 전송 스킵 - VAPID 미설정');
      return [];
    }

    const subscriptions = await prisma.pushSubscription.findMany({
      where: { userId },
    });

    const results = await Promise.allSettled(
      subscriptions.map(async (sub) => {
        try {
          await webPush!.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: {
                p256dh: sub.p256dh,
                auth: sub.auth,
              },
            },
            JSON.stringify(payload)
          );
          return { success: true, endpoint: sub.endpoint };
        } catch (error: any) {
          // 구독이 만료되었거나 유효하지 않은 경우 삭제
          if (error.statusCode === 404 || error.statusCode === 410) {
            await prisma.pushSubscription.delete({ where: { id: sub.id } });
          }
          return { success: false, endpoint: sub.endpoint, error: error.message };
        }
      })
    );

    return results;
  }

  // 모든 사용자에게 푸시 전송
  static async sendToAll(payload: PushPayload) {
    const initialized = await initWebPush();
    if (!initialized || !vapidConfigured) {
      console.warn('[PushService] 푸시 전송 스킵 - VAPID 미설정');
      return [];
    }

    const subscriptions = await prisma.pushSubscription.findMany();

    const results = await Promise.allSettled(
      subscriptions.map(async (sub) => {
        try {
          await webPush!.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: {
                p256dh: sub.p256dh,
                auth: sub.auth,
              },
            },
            JSON.stringify(payload)
          );
          return { success: true };
        } catch (error: any) {
          if (error.statusCode === 404 || error.statusCode === 410) {
            await prisma.pushSubscription.delete({ where: { id: sub.id } });
          }
          return { success: false, error: error.message };
        }
      })
    );

    return results;
  }

  // 주문 체결 알림 전송
  static async sendOrderFilledNotification(
    userId: number,
    ticker: string,
    type: 'buy' | 'sell',
    price: number,
    quantity: number
  ) {
    const action = type === 'buy' ? '매수' : '매도';
    const payload: PushPayload = {
      title: `${ticker} ${action} 체결`,
      body: `${quantity}주 @ $${price.toFixed(2)}`,
      icon: '/apple-icon.png',
      badge: '/apple-icon.png',
      tag: `order-${ticker}-${Date.now()}`,
      data: {
        type: 'order_filled',
        ticker,
        tradeType: type,
        price,
        quantity,
      },
    };

    return this.sendToUser(userId, payload);
  }

  // 가격 알림 전송
  static async sendPriceAlertNotification(
    userId: number,
    ticker: string,
    currentPrice: number,
    targetPrice: number,
    direction: 'above' | 'below'
  ) {
    const directionText = direction === 'above' ? '도달' : '하락';
    const payload: PushPayload = {
      title: `${ticker} 가격 ${directionText}`,
      body: `현재가: $${currentPrice.toFixed(2)} (목표: $${targetPrice.toFixed(2)})`,
      icon: '/apple-icon.png',
      badge: '/apple-icon.png',
      tag: `price-${ticker}`,
      data: {
        type: 'price_alert',
        ticker,
        currentPrice,
        targetPrice,
        direction,
      },
    };

    return this.sendToUser(userId, payload);
  }

  // 관리자에게 후원 알림 전송
  static async sendDonationNotificationToAdmin(
    donorEmail: string,
    currency: 'KRW' | 'USDT',
    amount: number
  ) {
    // 관리자 이메일로 사용자 찾기
    const adminEmail = 'ok4192@hanmail.net';
    const admin = await prisma.user.findUnique({
      where: { email: adminEmail },
    });

    if (!admin) {
      console.warn('[PushService] 관리자를 찾을 수 없음:', adminEmail);
      return [];
    }

    const formattedAmount = currency === 'KRW'
      ? `${amount.toLocaleString()}원`
      : `${amount.toFixed(6)} USDT`;

    const payload: PushPayload = {
      title: '새로운 후원이 확인되었습니다!',
      body: `${donorEmail}님이 ${formattedAmount}를 후원했습니다`,
      icon: '/apple-icon.png',
      badge: '/apple-icon.png',
      tag: `donation-${Date.now()}`,
      data: {
        type: 'donation_confirmed',
        donorEmail,
        currency,
        amount,
        url: '/admin/donations',
      },
    };

    console.log(`[PushService] 관리자에게 후원 알림 전송: ${formattedAmount} from ${donorEmail}`);
    return this.sendToUser(admin.id, payload);
  }
}
