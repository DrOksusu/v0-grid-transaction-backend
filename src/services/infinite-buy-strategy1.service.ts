import prisma from '../config/database';
import { KisService } from './kis.service';
import { decrypt, encrypt } from '../utils/encryption';
import { getNextLOCExecutionTime } from '../utils/us-market-holidays';
import { PushService } from './push.service';

/**
 * 무한매수전략1 서비스
 *
 * 전략 요약:
 * - T (회차) = 매수 누적액 / 1회 매수액 (소수 둘째자리 올림)
 * - 40번에 나누어 분할매수 (전반전 20회, 후반전 20회)
 *
 * 전반전 매수 (1~20회):
 *   a. 1회 매수분/2 만큼 기존평단가의 LOC 매수 (평단 아래에서만 매수)
 *   b. 1회 매수분/2 만큼 기존평단가의 (10-T/2)% 위 LOC 매수
 *
 * 후반전 매수 (21~40회):
 *   a. 1회 매수분 전부를 기존평단가의 (10-T/2)% 아래 LOC 매수
 *
 * 매도 (전후반 무관):
 *   a. 누적수량/4 만큼 기존평단가의 (10-T/2)% 위 LOC 매도
 *   b. 누적수량*3/4 만큼 10% 위 지정가 매도
 *
 * Note: 분할회수가 x번이면: (10-T/2) * (40/x) % 로 조정
 * Note: 매수/매도가 같은 가격이면 -0.01달러 차이를 둠
 */

interface Strategy1BuyResult {
  orders: Array<{
    orderId: string | null;
    orderType: 'loc';
    targetPrice: number;
    quantity: number;
    amount: number;
    subType: 'first_half_a' | 'first_half_b' | 'second_half';
  }>;
  totalAmount: number;
  totalQuantity: number;
}

interface Strategy1SellResult {
  orders: Array<{
    orderId: string | null;
    orderType: 'loc' | 'limit';
    targetPrice: number;
    quantity: number;
    subType: 'sell_a' | 'sell_b';
  }>;
  totalQuantity: number;
}

export class InfiniteBuyStrategy1Service {

  /**
   * T (회차 개념) 계산
   * T = 매수 누적액 / 1회 매수액 (소수 둘째자리 올림)
   */
  private calculateT(totalInvested: number, buyAmount: number): number {
    if (buyAmount <= 0) return 0;
    const raw = totalInvested / buyAmount;
    return Math.ceil(raw * 100) / 100; // 소수 둘째자리 올림
  }

  /**
   * LOC 퍼센트 계산
   * 기본: (10 - T/2)%
   * 분할회수 조정: (10 - T/2) * (40 / totalRounds) %
   */
  private calculateLocPercent(t: number, totalRounds: number = 40): number {
    const basePercent = 10 - (t / 2);
    const adjustedPercent = basePercent * (40 / totalRounds);
    return Math.max(0, adjustedPercent); // 음수 방지
  }

  /**
   * 전반전/후반전 판단
   */
  private isFirstHalf(currentRound: number, totalRounds: number): boolean {
    return currentRound < totalRounds / 2;
  }

  /**
   * KIS 서비스 인스턴스 가져오기
   */
  private async getKisService(userId: number): Promise<KisService> {
    const credential = await prisma.credential.findFirst({
      where: { userId, exchange: 'kis' },
    });

    if (!credential) {
      throw new Error('한국투자증권 API 설정을 찾을 수 없습니다');
    }

    if (!credential.apiKey || !credential.secretKey) {
      throw new Error('API Key 또는 Secret Key가 없습니다');
    }

    const appKey = decrypt(credential.apiKey);
    const appSecret = decrypt(credential.secretKey);

    const kisService = new KisService({
      appKey,
      appSecret,
      accountNo: credential.accountNo || '',
      isPaper: credential.isPaper ?? true,
    });

    // 토큰 유효성 확인
    let isTokenValid = false;
    if (credential.accessToken && credential.tokenExpireAt) {
      const now = new Date();
      const bufferTime = 10 * 60 * 1000;
      isTokenValid = credential.tokenExpireAt.getTime() - bufferTime > now.getTime();
    }

    if (isTokenValid && credential.accessToken) {
      kisService.setAccessToken(
        decrypt(credential.accessToken),
        credential.tokenExpireAt!
      );
    } else {
      const tokenInfo = await kisService.getAccessToken();
      await prisma.credential.update({
        where: { id: credential.id },
        data: {
          accessToken: encrypt(tokenInfo.accessToken),
          tokenExpireAt: tokenInfo.tokenExpireAt,
          lastValidatedAt: new Date(),
        },
      });
    }

    // 토큰 재발급 콜백 설정 (withTokenRefresh에서 자동 재발급 시 DB 저장용)
    kisService.setTokenRefreshCallback(async (newToken: string, newExpireAt: Date) => {
      try {
        await prisma.credential.update({
          where: { id: credential.id },
          data: {
            accessToken: encrypt(newToken),
            tokenExpireAt: newExpireAt,
          },
        });
        console.log(`[Strategy1] 토큰 자동 갱신 및 DB 저장 완료 (userId: ${userId})`);
      } catch (err: any) {
        console.error(`[Strategy1] 토큰 DB 저장 실패:`, err.message);
      }
    });

    return kisService;
  }

  /**
   * 무한매수전략1 매수 실행
   */
  async executeBuy(userId: number, stockId: number): Promise<Strategy1BuyResult> {
    const stock = await prisma.infiniteBuyStock.findFirst({
      where: { id: stockId, userId },
    });

    if (!stock) {
      throw new Error('종목을 찾을 수 없습니다');
    }

    if (stock.status === 'completed') {
      throw new Error('이미 익절 완료된 종목입니다');
    }

    if (stock.currentRound >= stock.totalRounds) {
      throw new Error('최대 분할 횟수에 도달했습니다');
    }

    const kisService = await this.getKisService(userId);
    const priceData = await kisService.getUSStockPrice(stock.ticker, stock.exchange);
    const currentPrice = priceData.currentPrice;

    // 첫 매수인 경우 현재가를 평단가로 사용
    const avgPrice = stock.avgPrice > 0 ? stock.avgPrice : currentPrice;

    // T 계산 (현재 매수 후의 T)
    const newTotalInvested = stock.totalInvested + stock.buyAmount;
    const t = this.calculateT(newTotalInvested, stock.buyAmount);
    const locPercent = this.calculateLocPercent(t, stock.totalRounds);

    const nextRound = stock.currentRound + 1;
    const isFirstHalf = this.isFirstHalf(nextRound, stock.totalRounds);

    const exchangeCode = stock.exchange === 'NAS' ? 'NASD' :
                        stock.exchange === 'NYS' ? 'NYSE' : 'AMEX';

    const orders: Strategy1BuyResult['orders'] = [];
    let totalQuantity = 0;
    let totalAmount = 0;

    if (isFirstHalf) {
      // 전반전 매수: 2개의 LOC 주문
      const halfAmount = stock.buyAmount / 2;

      // a. 평단가 LOC 매수 (평단보다 아래에서만 매수)
      const priceA = avgPrice - 0.01; // 매수/매도 동시 방지
      const quantityA = Math.floor(halfAmount / priceA);
      const actualAmountA = quantityA * priceA;  // 실제 매수 금액

      if (quantityA >= 1) {
        try {
          const resultA = await kisService.buyUSStockLOC(
            stock.ticker,
            quantityA,
            priceA,
            exchangeCode
          );
          orders.push({
            orderId: resultA.orderId,
            orderType: 'loc',
            targetPrice: priceA,
            quantity: quantityA,
            amount: actualAmountA,  // 실제 매수 금액
            subType: 'first_half_a',
          });
          totalQuantity += quantityA;
          totalAmount += actualAmountA;
        } catch (error: any) {
          console.error('[Strategy1] 전반전 매수 A 실패:', error.message);
        }
      }

      // b. 평단가 + (10-T/2)% LOC 매수 (평단보다 조금 위에서도 매수)
      const priceB = avgPrice * (1 + locPercent / 100);
      const quantityB = Math.floor(halfAmount / priceB);
      const actualAmountB = quantityB * priceB;  // 실제 매수 금액

      if (quantityB >= 1) {
        try {
          const resultB = await kisService.buyUSStockLOC(
            stock.ticker,
            quantityB,
            priceB,
            exchangeCode
          );
          orders.push({
            orderId: resultB.orderId,
            orderType: 'loc',
            targetPrice: priceB,
            quantity: quantityB,
            amount: actualAmountB,  // 실제 매수 금액
            subType: 'first_half_b',
          });
          totalQuantity += quantityB;
          totalAmount += actualAmountB;
        } catch (error: any) {
          console.error('[Strategy1] 전반전 매수 B 실패:', error.message);
        }
      }
    } else {
      // 후반전 매수: 평단가 - (10-T/2)% LOC 매수
      const price = avgPrice * (1 - locPercent / 100) - 0.01;
      const quantity = Math.floor(stock.buyAmount / price);
      const actualAmount = quantity * price;  // 실제 매수 금액

      if (quantity >= 1) {
        try {
          const result = await kisService.buyUSStockLOC(
            stock.ticker,
            quantity,
            price,
            exchangeCode
          );
          orders.push({
            orderId: result.orderId,
            orderType: 'loc',
            targetPrice: price,
            quantity,
            amount: actualAmount,  // 실제 매수 금액
            subType: 'second_half',
          });
          totalQuantity += quantity;
          totalAmount += actualAmount;
        } catch (error: any) {
          console.error('[Strategy1] 후반전 매수 실패:', error.message);
        }
      }
    }

    if (orders.length === 0) {
      throw new Error('주문 실행에 실패했습니다');
    }

    // 예상 평균단가 계산 (LOC가 체결된다고 가정)
    const expectedTotalInvested = stock.totalInvested + totalAmount;
    const expectedTotalQuantity = stock.totalQuantity + totalQuantity;
    const expectedAvgPrice = expectedTotalQuantity > 0
      ? expectedTotalInvested / expectedTotalQuantity
      : avgPrice;

    // DB 업데이트 (주문 기록)
    await prisma.$transaction(async (tx) => {
      // 종목 상태 업데이트
      await tx.infiniteBuyStock.update({
        where: { id: stockId },
        data: {
          currentRound: nextRound,
          totalInvested: expectedTotalInvested,
          totalQuantity: expectedTotalQuantity,
          avgPrice: expectedAvgPrice,
          status: 'buying',
        },
      });

      // 주문 기록 생성
      for (const order of orders) {
        await tx.infiniteBuyRecord.create({
          data: {
            stockId,
            type: 'buy',
            round: nextRound,
            price: order.targetPrice,
            quantity: order.quantity,
            amount: order.amount,
            orderType: 'loc',
            targetPrice: order.targetPrice,
            orderSubType: order.subType,
            orderId: order.orderId,
            orderStatus: 'pending', // LOC는 체결 대기
          },
        });
      }
    });

    // 푸시 알림 전송 (LOC 주문 접수 완료)
    try {
      await PushService.sendToUser(userId, {
        title: `${stock.ticker} LOC 매수 주문`,
        body: `${totalQuantity}주 주문 접수 (장 마감 시 체결 예정)`,
        icon: '/icon-192x192.svg',
        tag: `loc-buy-${stock.ticker}`,
        data: { type: 'order_placed', ticker: stock.ticker },
      });
    } catch (pushError) {
      console.error('[Strategy1] 푸시 알림 전송 실패:', pushError);
    }

    return { orders, totalAmount, totalQuantity };
  }

  /**
   * 무한매수전략1 매도 주문 실행
   * a. 누적수량/4 만큼 평단가 + (10-T/2)% LOC 매도
   * b. 누적수량*3/4 만큼 평단가 + 10% 지정가 매도
   */
  async executeSell(userId: number, stockId: number): Promise<Strategy1SellResult> {
    const stock = await prisma.infiniteBuyStock.findFirst({
      where: { id: stockId, userId },
    });

    if (!stock) {
      throw new Error('종목을 찾을 수 없습니다');
    }

    if (stock.status === 'completed') {
      throw new Error('이미 익절 완료된 종목입니다');
    }

    if (stock.totalQuantity <= 0) {
      throw new Error('매도할 수량이 없습니다');
    }

    const kisService = await this.getKisService(userId);

    const t = this.calculateT(stock.totalInvested, stock.buyAmount);
    const locPercent = this.calculateLocPercent(t, stock.totalRounds);

    const exchangeCode = stock.exchange === 'NAS' ? 'NASD' :
                        stock.exchange === 'NYS' ? 'NYSE' : 'AMEX';

    const orders: Strategy1SellResult['orders'] = [];
    let totalQuantity = 0;

    // a. 누적수량/4 만큼 평단가 + (10-T/2)% LOC 매도
    const quantityA = Math.floor(stock.totalQuantity / 4);
    const priceA = stock.avgPrice * (1 + locPercent / 100);

    if (quantityA >= 1) {
      try {
        const resultA = await kisService.sellUSStockLOC(
          stock.ticker,
          quantityA,
          priceA,
          exchangeCode
        );
        orders.push({
          orderId: resultA.orderId,
          orderType: 'loc',
          targetPrice: priceA,
          quantity: quantityA,
          subType: 'sell_a',
        });
        totalQuantity += quantityA;
      } catch (error: any) {
        console.error('[Strategy1] 매도 A (LOC) 실패:', error.message);
      }
    }

    // b. 누적수량*3/4 만큼 평단가 + 10% 지정가 매도
    const quantityB = Math.floor(stock.totalQuantity * 3 / 4);
    const priceB = stock.avgPrice * 1.10; // 10% 위

    if (quantityB >= 1) {
      try {
        const resultB = await kisService.sellUSStock(
          stock.ticker,
          quantityB,
          priceB,
          exchangeCode
        );
        orders.push({
          orderId: resultB.orderId,
          orderType: 'limit',
          targetPrice: priceB,
          quantity: quantityB,
          subType: 'sell_b',
        });
        totalQuantity += quantityB;
      } catch (error: any) {
        console.error('[Strategy1] 매도 B (지정가) 실패:', error.message);
      }
    }

    if (orders.length === 0) {
      throw new Error('매도 주문 실행에 실패했습니다');
    }

    // 매도 주문 기록
    await prisma.$transaction(async (tx) => {
      for (const order of orders) {
        await tx.infiniteBuyRecord.create({
          data: {
            stockId,
            type: 'sell',
            price: order.targetPrice,
            quantity: order.quantity,
            amount: order.targetPrice * order.quantity,
            orderType: order.orderType,
            targetPrice: order.targetPrice,
            orderSubType: order.subType,
            orderId: order.orderId,
            orderStatus: 'pending',
          },
        });
      }
    });

    // 푸시 알림 전송 (매도 주문 접수 완료)
    try {
      await PushService.sendToUser(userId, {
        title: `${stock.ticker} 매도 주문`,
        body: `${totalQuantity}주 매도 주문 접수`,
        icon: '/icon-192x192.svg',
        tag: `sell-${stock.ticker}`,
        data: { type: 'order_placed', ticker: stock.ticker },
      });
    } catch (pushError) {
      console.error('[Strategy1] 푸시 알림 전송 실패:', pushError);
    }

    return { orders, totalQuantity };
  }

  /**
   * 현재 전략 상태 조회
   */
  async getStrategyStatus(userId: number, stockId: number) {
    const stock = await prisma.infiniteBuyStock.findFirst({
      where: { id: stockId, userId },
    });

    if (!stock) {
      throw new Error('종목을 찾을 수 없습니다');
    }

    const t = this.calculateT(stock.totalInvested, stock.buyAmount);
    const locPercent = this.calculateLocPercent(t, stock.totalRounds);
    const isFirstHalf = this.isFirstHalf(stock.currentRound + 1, stock.totalRounds);
    const halfRound = stock.totalRounds / 2;

    // 첫 매수 전에는 현재가 조회
    let basePrice = stock.avgPrice;
    let currentPrice: number | null = null;

    if (stock.avgPrice === 0) {
      // 현재가 조회 시도
      try {
        const kisService = await this.getKisService(userId);
        const priceData = await kisService.getUSStockPrice(stock.ticker, stock.exchange);
        basePrice = priceData.currentPrice;
        currentPrice = priceData.currentPrice;
      } catch (error) {
        // 현재가 조회 실패 시 0으로 유지
        console.error('[Strategy1] 현재가 조회 실패:', error);
      }
    }

    // 다음 매수 가격 및 예상 수량 계산
    let nextBuyPrices: { type: string; price: number; amount: number; quantity: number; percent: string }[] = [];

    if (stock.currentRound < stock.totalRounds && basePrice > 0) {
      if (isFirstHalf) {
        // 전반전: 50%씩 두 개의 LOC 주문
        const halfAmount = stock.buyAmount / 2;
        const priceA = basePrice - 0.01;
        const priceB = basePrice * (1 + locPercent / 100);
        const quantityA = Math.floor(halfAmount / priceA);
        const quantityB = Math.floor(halfAmount / priceB);

        nextBuyPrices = [
          { type: '전반전(평단으로 LOC매매)', price: priceA, amount: halfAmount, quantity: quantityA, percent: '50%' },
          { type: '전반전(평단×(1+조정비율)로 LOC매매)', price: priceB, amount: halfAmount, quantity: quantityB, percent: '50%' },
        ];
      } else {
        // 후반전: 100% 한 개의 LOC 주문
        const price = basePrice * (1 - locPercent / 100) - 0.01;
        const quantity = Math.floor(stock.buyAmount / price);

        nextBuyPrices = [
          { type: '후반전(평단×(1-조정비율)로 LOC매매)', price, amount: stock.buyAmount, quantity, percent: '100%' },
        ];
      }
    }

    // 매도 가격 계산
    const sellPrices = stock.totalQuantity > 0 && stock.avgPrice > 0 ? [
      { type: '1/4수량 평단×(1+조정비율)로 LOC매도', price: stock.avgPrice * (1 + locPercent / 100), quantity: Math.floor(stock.totalQuantity / 4) },
      { type: '3/4수량 평단×1.1로 지정가매도', price: stock.avgPrice * 1.10, quantity: Math.floor(stock.totalQuantity * 3 / 4) },
    ] : [];

    // 다음 LOC 체결 예정 시간
    const nextExecution = getNextLOCExecutionTime();

    return {
      ticker: stock.ticker,
      strategy: 'strategy1',
      currentRound: stock.currentRound,
      totalRounds: stock.totalRounds,
      halfRound,
      isFirstHalf,
      t: t.toFixed(2),
      locPercent: locPercent.toFixed(2) + '%',
      avgPrice: stock.avgPrice,
      currentPrice,  // 첫 매수 전일 때 현재가 반환
      basePrice,     // 계산에 사용된 기준가 (평단 또는 현재가)
      totalInvested: stock.totalInvested,
      totalQuantity: stock.totalQuantity,
      nextBuyPrices,
      sellPrices,
      isFirstBuy: stock.currentRound === 0,  // 첫 매수 여부
      nextExecution: {
        dateStr: nextExecution.dateStr,
        dayOfWeek: nextExecution.dayOfWeek,
        isToday: nextExecution.isToday,
        daysUntil: nextExecution.daysUntil,
        executionTimeKST: nextExecution.executionTimeKST,
        executionTimeET: nextExecution.executionTimeET,
      },
    };
  }
}

export const infiniteBuyStrategy1Service = new InfiniteBuyStrategy1Service();
