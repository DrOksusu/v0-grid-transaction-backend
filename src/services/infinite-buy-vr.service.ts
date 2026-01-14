import prisma from '../config/database';
import { KisService } from './kis.service';
import { decrypt, encrypt } from '../utils/encryption';
import { PushService } from './push.service';
import { SchedulerLogType, SchedulerLogStatus } from '@prisma/client';
import { getKisCredential } from '../utils/credential-helper';

/**
 * 밸류 리밸런싱(VR) 서비스
 *
 * 전략 요약:
 * - V (Value): 목표 평가금 (밴드의 중심)
 * - P (Pool): 보유 현금
 * - G (Gradient): 기울기 (10 또는 20)
 * - 밴드: V × 0.85 ~ V × 1.15 (±15%)
 *
 * 운용 스타일:
 * - deposit (적립식): Pool 75% 사용, G=10, V_new = V + P/G + 적립금
 * - hold (거치식): Pool 50% 사용, G=10, V_new = V + P/G
 * - withdraw (인출식): Pool 25% 사용, G=20, V_new = V + P/G - 인출금
 *
 * 매수/매도 가격:
 * - 매수점: 최소밴드 / (보유수량 + n)
 * - 매도점: 최대밴드 / (보유수량 - n)
 */

// 로그 저장 헬퍼 함수
async function saveLog(params: {
  type: SchedulerLogType;
  status: SchedulerLogStatus;
  message: string;
  stockId?: number;
  ticker?: string;
  details?: object;
  errorMessage?: string;
}) {
  try {
    await prisma.schedulerLog.create({
      data: {
        type: params.type,
        status: params.status,
        message: params.message,
        stockId: params.stockId,
        ticker: params.ticker,
        details: params.details ? JSON.stringify(params.details) : null,
        errorMessage: params.errorMessage,
      },
    });
  } catch (logError) {
    console.error('[VR] 로그 저장 실패:', logError);
  }
}

interface VRInitParams {
  vrValue: number;
  vrPool: number;
  vrGradient?: number;
  vrStyle: 'deposit' | 'hold' | 'withdraw';
  vrDepositAmount?: number;
  vrBandPercent?: number;
  vrCycleWeeks?: number;
  initialQuantity?: number;   // 초기 보유 수량
  initialAvgPrice?: number;   // 초기 평균 매수가
}

interface VROrderResult {
  orders: Array<{
    orderId: string | null;
    orderType: 'limit';
    targetPrice: number;
    quantity: number;
    index: number;
    band: 'min' | 'max';
  }>;
  totalOrders: number;
}

interface VRBand {
  min: number;
  max: number;
}

export class InfiniteBuyVRService {
  /**
   * 소수점 셋째자리 반올림
   */
  private round3(value: number): number {
    return Math.round(value * 1000) / 1000;
  }

  /**
   * 밴드 계산
   */
  private calculateBand(v: number, bandPercent: number = 15): VRBand {
    return {
      min: this.round3(v * (1 - bandPercent / 100)),
      max: this.round3(v * (1 + bandPercent / 100)),
    };
  }

  /**
   * 다음 V값 계산
   */
  private calculateNextV(
    v: number,
    p: number,
    g: number,
    style: string,
    depositAmount: number = 0
  ): number {
    const increment = p / g;
    switch (style) {
      case 'deposit':
        return this.round3(v + increment + depositAmount);
      case 'hold':
        return this.round3(v + increment);
      case 'withdraw':
        return this.round3(v + increment - depositAmount);
      default:
        return this.round3(v + increment);
    }
  }

  /**
   * Pool 사용률 계산
   */
  private getPoolUsageRate(style: string): number {
    switch (style) {
      case 'deposit':
        return 0.75;
      case 'hold':
        return 0.50;
      case 'withdraw':
        return 0.25;
      default:
        return 0.50;
    }
  }

  /**
   * 매수 주문 목록 생성
   */
  private calculateBuyOrders(
    minBand: number,
    currentQuantity: number,
    availablePool: number
  ): Array<{ price: number; quantity: number; index: number }> {
    const orders: Array<{ price: number; quantity: number; index: number }> = [];
    let usedPool = 0;
    let n = 0;

    while (usedPool < availablePool) {
      const baseQuantity = currentQuantity > 0 ? currentQuantity : 1;
      const price = this.round3(minBand / (baseQuantity + n));

      // 최소 가격 제한 ($1 이상)
      if (price < 1) break;

      // Pool 초과 체크
      if (usedPool + price > availablePool) break;

      usedPool += price;
      orders.push({ price, quantity: 1, index: n + 1 });
      n++;

      // 최대 주문 개수 제한 (안전장치)
      if (n >= 100) break;
    }

    return orders;
  }

  /**
   * 매도 주문 목록 생성
   */
  private calculateSellOrders(
    maxBand: number,
    currentQuantity: number
  ): Array<{ price: number; quantity: number; index: number }> {
    const orders: Array<{ price: number; quantity: number; index: number }> = [];

    // 최소 1주는 보유해야 함
    for (let n = 0; n < currentQuantity - 1; n++) {
      const price = this.round3(maxBand / (currentQuantity - n));
      orders.push({ price, quantity: 1, index: n + 1 });

      // 최대 주문 개수 제한 (안전장치)
      if (n >= 99) break;
    }

    return orders;
  }

  /**
   * KIS 서비스 인스턴스 가져오기 (VR용 credential 우선, 없으면 default 폴백)
   */
  private async getKisService(userId: number): Promise<KisService> {
    const credential = await getKisCredential(userId, 'vr');

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

    // 토큰 재발급 콜백 설정
    kisService.setTokenRefreshCallback(async (newToken: string, newExpireAt: Date) => {
      try {
        await prisma.credential.update({
          where: { id: credential.id },
          data: {
            accessToken: encrypt(newToken),
            tokenExpireAt: newExpireAt,
          },
        });
        console.log(`[VR] 토큰 자동 갱신 및 DB 저장 완료 (userId: ${userId})`);
      } catch (err: any) {
        console.error(`[VR] 토큰 DB 저장 실패:`, err.message);
      }
    });

    return kisService;
  }

  /**
   * VR 전략 초기화
   */
  async initializeVR(userId: number, stockId: number, params: VRInitParams) {
    const stock = await prisma.infiniteBuyStock.findFirst({
      where: { id: stockId, userId },
    });

    if (!stock) {
      throw new Error('종목을 찾을 수 없습니다');
    }

    if (stock.strategy !== 'vr') {
      throw new Error('VR 전략이 아닌 종목입니다. 먼저 전략을 VR로 변경해주세요');
    }

    // 기본값 설정
    const vrGradient = params.vrGradient || (params.vrStyle === 'withdraw' ? 20 : 10);
    const vrBandPercent = params.vrBandPercent || 15;
    const vrCycleWeeks = params.vrCycleWeeks || 2;

    // 초기 보유 수량 처리
    const initialQuantity = params.initialQuantity || 0;
    const initialAvgPrice = params.initialAvgPrice || 0;
    const initialInvested = initialQuantity * initialAvgPrice;

    const updated = await prisma.infiniteBuyStock.update({
      where: { id: stockId },
      data: {
        vrValue: params.vrValue,
        vrPool: params.vrPool,
        vrGradient,
        vrStyle: params.vrStyle,
        vrDepositAmount: params.vrDepositAmount || 0,
        vrBandPercent,
        vrCycleWeeks,
        vrCycleStartDate: new Date(),
        status: 'buying',
        // 초기 보유 수량 설정
        totalQuantity: initialQuantity,
        avgPrice: initialAvgPrice,
        totalInvested: initialInvested,
      },
    });

    await saveLog({
      type: 'vr_cycle',
      status: 'completed',
      message: `[VR] ${stock.ticker}: VR 전략 초기화 완료`,
      stockId,
      ticker: stock.ticker,
      details: {
        vrValue: params.vrValue,
        vrPool: params.vrPool,
        vrGradient,
        vrStyle: params.vrStyle,
        vrDepositAmount: params.vrDepositAmount,
        vrBandPercent,
        vrCycleWeeks,
        initialQuantity,
        initialAvgPrice,
        initialInvested,
      },
    });

    return {
      ...updated,
      band: this.calculateBand(params.vrValue, vrBandPercent),
    };
  }

  /**
   * VR 상태 조회
   */
  async getVRStatus(userId: number, stockId: number) {
    const stock = await prisma.infiniteBuyStock.findFirst({
      where: { id: stockId, userId },
    });

    if (!stock) {
      throw new Error('종목을 찾을 수 없습니다');
    }

    if (stock.strategy !== 'vr') {
      throw new Error('VR 전략이 아닌 종목입니다');
    }

    if (!stock.vrValue || !stock.vrPool) {
      throw new Error('VR 설정이 초기화되지 않았습니다');
    }

    const band = this.calculateBand(stock.vrValue, stock.vrBandPercent || 15);
    const poolUsageRate = this.getPoolUsageRate(stock.vrStyle || 'hold');
    const availablePool = stock.vrPool * poolUsageRate;

    // 현재가 조회
    let currentPrice = 0;
    let currentEval = 0;
    let bandStatus: 'below_min' | 'in_band' | 'above_max' = 'in_band';

    try {
      const kisService = await this.getKisService(userId);
      const priceData = await kisService.getUSStockPrice(stock.ticker, stock.exchange);
      currentPrice = priceData.currentPrice;
      currentEval = currentPrice * stock.totalQuantity;

      if (currentEval < band.min) {
        bandStatus = 'below_min';
      } else if (currentEval > band.max) {
        bandStatus = 'above_max';
      }
    } catch (error) {
      console.error('[VR] 현재가 조회 실패:', error);
    }

    // 다음 V 계산
    const nextV = this.calculateNextV(
      stock.vrValue,
      stock.vrPool,
      stock.vrGradient || 10,
      stock.vrStyle || 'hold',
      stock.vrDepositAmount || 0
    );

    // 예상 매수/매도 주문 계산
    const buyOrders = this.calculateBuyOrders(band.min, stock.totalQuantity, availablePool);
    const sellOrders = this.calculateSellOrders(band.max, stock.totalQuantity);

    // 다음 사이클까지 남은 일수 계산
    let daysUntilNextCycle = 0;
    if (stock.vrCycleStartDate) {
      const cycleWeeks = stock.vrCycleWeeks || 2;
      const cycleDays = cycleWeeks * 7;
      const daysSinceCycleStart = Math.floor(
        (Date.now() - stock.vrCycleStartDate.getTime()) / (1000 * 60 * 60 * 24)
      );
      daysUntilNextCycle = Math.max(0, cycleDays - daysSinceCycleStart);
    }

    // 미체결 주문 조회
    const pendingOrders = await prisma.infiniteBuyRecord.findMany({
      where: {
        stockId,
        orderStatus: 'pending',
        vrOrderIndex: { not: null },
      },
      orderBy: { executedAt: 'desc' },
    });

    return {
      ticker: stock.ticker,
      strategy: 'vr',
      v: stock.vrValue,
      p: stock.vrPool,
      g: stock.vrGradient || 10,
      style: stock.vrStyle || 'hold',
      depositAmount: stock.vrDepositAmount || 0,
      bandPercent: stock.vrBandPercent || 15,
      cycleWeeks: stock.vrCycleWeeks || 2,
      band,
      currentPrice,
      currentEval,
      bandStatus,
      totalQuantity: stock.totalQuantity,
      avgPrice: stock.avgPrice,
      nextV,
      poolUsageRate,
      availablePool,
      cycleStartDate: stock.vrCycleStartDate?.toISOString(),
      daysUntilNextCycle,
      expectedBuyOrders: buyOrders,
      expectedSellOrders: sellOrders,
      pendingOrders: pendingOrders.map((o) => ({
        id: o.id,
        type: o.type,
        price: o.targetPrice,
        quantity: o.quantity,
        index: o.vrOrderIndex,
        band: o.vrTargetBand,
        executedAt: o.executedAt.toISOString(),
      })),
    };
  }

  /**
   * VR 주문 생성 (매수 + 매도)
   */
  async generateOrders(userId: number, stockId: number): Promise<VROrderResult> {
    const stock = await prisma.infiniteBuyStock.findFirst({
      where: { id: stockId, userId },
    });

    if (!stock) {
      throw new Error('종목을 찾을 수 없습니다');
    }

    if (stock.strategy !== 'vr') {
      throw new Error('VR 전략이 아닌 종목입니다');
    }

    if (!stock.vrValue || !stock.vrPool) {
      throw new Error('VR 설정이 초기화되지 않았습니다');
    }

    if (stock.status !== 'buying') {
      throw new Error('진행 중인 종목이 아닙니다');
    }

    const band = this.calculateBand(stock.vrValue, stock.vrBandPercent || 15);
    const poolUsageRate = this.getPoolUsageRate(stock.vrStyle || 'hold');
    const availablePool = stock.vrPool * poolUsageRate;

    const kisService = await this.getKisService(userId);
    const exchangeCode = stock.exchange === 'NAS' ? 'NASD' :
                         stock.exchange === 'NYS' ? 'NYSE' : 'AMEX';

    const orders: VROrderResult['orders'] = [];
    const errors: string[] = [];

    // 매수 주문 생성
    const buyOrders = this.calculateBuyOrders(band.min, stock.totalQuantity, availablePool);
    for (const order of buyOrders) {
      try {
        const result = await kisService.buyUSStock(
          stock.ticker,
          order.quantity,
          order.price,
          exchangeCode
        );

        orders.push({
          orderId: result.orderId,
          orderType: 'limit',
          targetPrice: order.price,
          quantity: order.quantity,
          index: order.index,
          band: 'min',
        });

        // DB 기록
        await prisma.infiniteBuyRecord.create({
          data: {
            stockId,
            type: 'buy',
            price: order.price,
            quantity: order.quantity,
            amount: order.price * order.quantity,
            orderType: 'limit',
            targetPrice: order.price,
            orderId: result.orderId,
            orderStatus: 'pending',
            vrOrderIndex: order.index,
            vrTargetBand: 'min',
          },
        });
      } catch (error: any) {
        console.error(`[VR] 매수 주문 ${order.index} 실패:`, error.message);
        errors.push(`매수${order.index}: ${error.message}`);
      }
    }

    // 매도 주문 생성 (보유 수량이 있는 경우에만)
    if (stock.totalQuantity > 1) {
      const sellOrders = this.calculateSellOrders(band.max, stock.totalQuantity);
      for (const order of sellOrders) {
        try {
          const result = await kisService.sellUSStock(
            stock.ticker,
            order.quantity,
            order.price,
            exchangeCode
          );

          orders.push({
            orderId: result.orderId,
            orderType: 'limit',
            targetPrice: order.price,
            quantity: order.quantity,
            index: order.index,
            band: 'max',
          });

          // DB 기록
          await prisma.infiniteBuyRecord.create({
            data: {
              stockId,
              type: 'sell',
              price: order.price,
              quantity: order.quantity,
              amount: order.price * order.quantity,
              orderType: 'limit',
              targetPrice: order.price,
              orderId: result.orderId,
              orderStatus: 'pending',
              vrOrderIndex: order.index,
              vrTargetBand: 'max',
            },
          });
        } catch (error: any) {
          console.error(`[VR] 매도 주문 ${order.index} 실패:`, error.message);
          errors.push(`매도${order.index}: ${error.message}`);
        }
      }
    }

    if (orders.length === 0 && errors.length > 0) {
      throw new Error(`모든 주문 실패: ${errors.join(' | ')}`);
    }

    await saveLog({
      type: 'vr_order',
      status: 'completed',
      message: `[VR] ${stock.ticker}: ${orders.length}개 주문 생성`,
      stockId,
      ticker: stock.ticker,
      details: {
        buyOrders: orders.filter((o) => o.band === 'min').length,
        sellOrders: orders.filter((o) => o.band === 'max').length,
        errors,
      },
    });

    // 푸시 알림
    try {
      await PushService.sendToUser(userId, {
        title: `${stock.ticker} VR 주문 생성`,
        body: `매수 ${orders.filter((o) => o.band === 'min').length}건, 매도 ${orders.filter((o) => o.band === 'max').length}건`,
        icon: '/icon-192x192.svg',
        tag: `vr-orders-${stock.ticker}`,
        data: { type: 'vr_orders', ticker: stock.ticker },
      });
    } catch (pushError) {
      console.error('[VR] 푸시 알림 전송 실패:', pushError);
    }

    return { orders, totalOrders: orders.length };
  }

  /**
   * VR 사이클 실행 (V 갱신 + 새 주문 생성)
   */
  async executeCycle(userId: number, stockId: number) {
    const stock = await prisma.infiniteBuyStock.findFirst({
      where: { id: stockId, userId },
    });

    if (!stock) {
      throw new Error('종목을 찾을 수 없습니다');
    }

    if (stock.strategy !== 'vr') {
      throw new Error('VR 전략이 아닌 종목입니다');
    }

    if (!stock.vrValue || !stock.vrPool) {
      throw new Error('VR 설정이 초기화되지 않았습니다');
    }

    // 기존 미체결 주문 취소 (선택사항 - KIS API에서 미체결 주문 취소)
    // 참고: 지정가 주문은 당일 마감 시 자동 취소되므로 필요 시 구현

    // 적립금/인출금 반영
    let newPool = stock.vrPool;
    if (stock.vrStyle === 'deposit' && stock.vrDepositAmount) {
      newPool += stock.vrDepositAmount;
    } else if (stock.vrStyle === 'withdraw' && stock.vrDepositAmount) {
      newPool = Math.max(0, newPool - stock.vrDepositAmount);
    }

    // 새 V값 계산
    const newV = this.calculateNextV(
      stock.vrValue,
      newPool,
      stock.vrGradient || 10,
      stock.vrStyle || 'hold',
      stock.vrDepositAmount || 0
    );

    // DB 업데이트
    await prisma.infiniteBuyStock.update({
      where: { id: stockId },
      data: {
        vrValue: newV,
        vrPool: newPool,
        vrCycleStartDate: new Date(),
        vrLastCycleDate: new Date(),
      },
    });

    await saveLog({
      type: 'vr_cycle',
      status: 'completed',
      message: `[VR] ${stock.ticker}: 사이클 실행 완료`,
      stockId,
      ticker: stock.ticker,
      details: {
        oldV: stock.vrValue,
        newV,
        oldPool: stock.vrPool,
        newPool,
      },
    });

    // 새 주문 생성
    const orderResult = await this.generateOrders(userId, stockId);

    return {
      oldV: stock.vrValue,
      newV,
      oldPool: stock.vrPool,
      newPool,
      ordersCreated: orderResult.totalOrders,
    };
  }

  /**
   * VR 체결 확인 및 Pool 업데이트
   */
  async syncFilledOrders(userId: number, stockId: number) {
    const stock = await prisma.infiniteBuyStock.findFirst({
      where: { id: stockId, userId },
    });

    if (!stock) {
      throw new Error('종목을 찾을 수 없습니다');
    }

    const kisService = await this.getKisService(userId);

    // 미체결 주문 조회
    const pendingRecords = await prisma.infiniteBuyRecord.findMany({
      where: {
        stockId,
        orderStatus: 'pending',
        vrOrderIndex: { not: null },
        orderId: { not: null },
      },
    });

    if (pendingRecords.length === 0) {
      return { synced: 0, message: '확인할 미체결 주문이 없습니다' };
    }

    // KIS에서 체결 내역 조회
    const kisOrders = await kisService.getUSStockOrders();

    let synced = 0;
    let poolChange = 0;
    let quantityChange = 0;
    let investedChange = 0;

    for (const record of pendingRecords) {
      const kisOrder = kisOrders.find((o: any) => o.orderId === record.orderId);

      if (kisOrder && kisOrder.status === 'filled') {
        // 체결됨
        const filledPrice = kisOrder.filledPrice || record.price;
        const filledAmount = filledPrice * record.quantity;

        if (record.type === 'buy') {
          poolChange -= filledAmount;
          quantityChange += record.quantity;
          investedChange += filledAmount;
        } else {
          poolChange += filledAmount;
          quantityChange -= record.quantity;
          investedChange -= record.quantity * stock.avgPrice;
        }

        await prisma.infiniteBuyRecord.update({
          where: { id: record.id },
          data: {
            orderStatus: 'filled',
            price: filledPrice,
            amount: filledAmount,
            filledAt: new Date(),
            profit: record.type === 'sell' ? filledAmount - (record.quantity * stock.avgPrice) : null,
          },
        });

        synced++;
      }
    }

    if (synced > 0) {
      // 종목 상태 업데이트
      const newPool = (stock.vrPool || 0) + poolChange;
      const newQuantity = stock.totalQuantity + quantityChange;
      const newInvested = stock.totalInvested + investedChange;
      const newAvgPrice = newQuantity > 0 ? newInvested / newQuantity : 0;

      await prisma.infiniteBuyStock.update({
        where: { id: stockId },
        data: {
          vrPool: Math.max(0, newPool),
          totalQuantity: Math.max(0, newQuantity),
          totalInvested: Math.max(0, newInvested),
          avgPrice: newAvgPrice,
        },
      });

      await saveLog({
        type: 'vr_order',
        status: 'completed',
        message: `[VR] ${stock.ticker}: ${synced}건 체결 동기화`,
        stockId,
        ticker: stock.ticker,
        details: {
          synced,
          poolChange,
          quantityChange,
          investedChange,
        },
      });
    }

    return { synced, poolChange, quantityChange };
  }

  /**
   * VR 설정 변경
   */
  async updateVRSettings(
    userId: number,
    stockId: number,
    params: Partial<VRInitParams>
  ) {
    const stock = await prisma.infiniteBuyStock.findFirst({
      where: { id: stockId, userId },
    });

    if (!stock) {
      throw new Error('종목을 찾을 수 없습니다');
    }

    if (stock.strategy !== 'vr') {
      throw new Error('VR 전략이 아닌 종목입니다');
    }

    const updateData: any = {};

    if (params.vrValue !== undefined) updateData.vrValue = params.vrValue;
    if (params.vrPool !== undefined) updateData.vrPool = params.vrPool;
    if (params.vrGradient !== undefined) updateData.vrGradient = params.vrGradient;
    if (params.vrStyle !== undefined) updateData.vrStyle = params.vrStyle;
    if (params.vrDepositAmount !== undefined) updateData.vrDepositAmount = params.vrDepositAmount;
    if (params.vrBandPercent !== undefined) updateData.vrBandPercent = params.vrBandPercent;
    if (params.vrCycleWeeks !== undefined) updateData.vrCycleWeeks = params.vrCycleWeeks;

    const updated = await prisma.infiniteBuyStock.update({
      where: { id: stockId },
      data: updateData,
    });

    return updated;
  }
}

export const infiniteBuyVRService = new InfiniteBuyVRService();
