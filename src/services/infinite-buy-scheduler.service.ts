import cron, { ScheduledTask } from 'node-cron';
import prisma from '../config/database';
import { KisService } from './kis.service';
import { decrypt } from '../utils/encryption';
import { InfiniteBuyStatus } from '@prisma/client';
import { infiniteBuyStrategy1Service } from './infinite-buy-strategy1.service';
import { isUSMarketOpen } from '../utils/us-market-holidays';

interface SchedulerConfig {
  autoBuyEnabled: boolean;
  autoSellEnabled: boolean;
  priceCheckInterval: number; // 분 단위
}

interface StockWithCredential {
  stock: any;
  kisService: KisService;
}

export class InfiniteBuySchedulerService {
  private autoBuyJob: ScheduledTask | null = null;
  private strategy1BuyJob: ScheduledTask | null = null;  // strategy1 전용
  private priceCheckJob: ScheduledTask | null = null;
  private orderCheckJob: ScheduledTask | null = null;
  private isRunning: boolean = false;
  private config: SchedulerConfig = {
    autoBuyEnabled: true,
    autoSellEnabled: true,
    priceCheckInterval: 5, // 5분마다 가격 체크
  };

  // 스케줄러 시작
  start() {
    if (this.isRunning) {
      console.log('[InfiniteBuyScheduler] 이미 실행 중입니다');
      return;
    }

    console.log('[InfiniteBuyScheduler] 무한매수법 자동매매 스케줄러 시작');

    // 미국 장 시작 시간 (한국시간 23:30, 서머타임 22:30)
    // 동절기 기준 23:35에 자동 매수 실행 (하루 1회) - basic 전략용
    // 서머타임 기간(3월~11월)에는 22:35로 변경 필요
    this.autoBuyJob = cron.schedule('35 23 * * 1-5', async () => {
      console.log('[InfiniteBuyScheduler] 기본 전략 자동 매수 스케줄 실행');
      await this.executeAutoBuy();
    }, {
      timezone: 'Asia/Seoul'
    });

    // Strategy1 LOC 주문 (장 시작 후 40분에 실행 - 23:40 KST 동절기)
    // LOC 주문은 장중에 넣으면 장 마감 시 체결됨
    this.strategy1BuyJob = cron.schedule('40 23 * * 1-5', async () => {
      console.log('[InfiniteBuyScheduler] Strategy1 LOC 자동 매수 스케줄 실행');
      await this.executeStrategy1AutoBuy();
    }, {
      timezone: 'Asia/Seoul'
    });

    // 장중 가격 체크 (매 5분마다, 미국 장 시간 22:30 ~ 05:00 KST)
    this.priceCheckJob = cron.schedule(`*/${this.config.priceCheckInterval} 22,23,0,1,2,3,4,5 * * 1-6`, async () => {
      await this.checkPricesAndSell();
    }, {
      timezone: 'Asia/Seoul'
    });

    // 체결 확인 (매 10분마다, 미국 장 시간)
    this.orderCheckJob = cron.schedule('*/10 22,23,0,1,2,3,4,5 * * 1-6', async () => {
      await this.checkPendingOrders();
    }, {
      timezone: 'Asia/Seoul'
    });

    this.isRunning = true;
    console.log('[InfiniteBuyScheduler] 스케줄 등록 완료');
    console.log('  - 기본 전략 매수: 매일 23:35 (KST, 동절기)');
    console.log('  - Strategy1 LOC 매수: 매일 23:40 (KST, 동절기)');
    console.log(`  - 가격 체크: 장중 매 ${this.config.priceCheckInterval}분`);
    console.log('  - 체결 확인: 장중 매 10분');
  }

  // 스케줄러 중지
  stop() {
    if (this.autoBuyJob) {
      this.autoBuyJob.stop();
      this.autoBuyJob = null;
    }
    if (this.strategy1BuyJob) {
      this.strategy1BuyJob.stop();
      this.strategy1BuyJob = null;
    }
    if (this.priceCheckJob) {
      this.priceCheckJob.stop();
      this.priceCheckJob = null;
    }
    if (this.orderCheckJob) {
      this.orderCheckJob.stop();
      this.orderCheckJob = null;
    }
    this.isRunning = false;
    console.log('[InfiniteBuyScheduler] 스케줄러 중지됨');
  }

  // 수동 실행 (테스트용)
  async runManualBuy() {
    console.log('[InfiniteBuyScheduler] 수동 매수 실행 (기본 전략)');
    await this.executeAutoBuy();
  }

  async runManualStrategy1Buy() {
    console.log('[InfiniteBuyScheduler] 수동 매수 실행 (Strategy1)');
    await this.executeStrategy1AutoBuy();
  }

  async runManualPriceCheck() {
    console.log('[InfiniteBuyScheduler] 수동 가격 체크 실행');
    await this.checkPricesAndSell();
  }

  // KIS 서비스 인스턴스 가져오기
  private async getKisService(userId: number): Promise<KisService | null> {
    try {
      const credential = await prisma.credential.findFirst({
        where: { userId, exchange: 'kis' },
      });

      if (!credential) {
        return null;
      }

      const appKey = decrypt(credential.apiKey);
      const appSecret = decrypt(credential.secretKey);

      const kisService = new KisService({
        appKey,
        appSecret,
        accountNo: credential.accountNo || '',
        isPaper: credential.isPaper,
      });

      // 기존 토큰이 있고 유효한지 확인
      let needNewToken = true;
      if (credential.accessToken && credential.tokenExpireAt) {
        const now = new Date();
        const bufferTime = 10 * 60 * 1000; // 10분 여유
        if (credential.tokenExpireAt.getTime() - bufferTime > now.getTime()) {
          kisService.setAccessToken(
            decrypt(credential.accessToken),
            credential.tokenExpireAt
          );
          needNewToken = false;
        }
      }

      // 토큰이 없거나 만료됐으면 새로 발급 후 DB에 저장
      if (needNewToken) {
        console.log(`[InfiniteBuyScheduler] KIS 토큰 갱신 필요 (userId: ${userId})`);
        try {
          const tokenInfo = await kisService.getAccessToken();

          // DB에 새 토큰 저장
          const { encrypt } = await import('../utils/encryption');
          await prisma.credential.update({
            where: { id: credential.id },
            data: {
              accessToken: encrypt(tokenInfo.accessToken),
              tokenExpireAt: tokenInfo.tokenExpireAt,
            },
          });
          console.log(`[InfiniteBuyScheduler] KIS 토큰 갱신 완료 (만료: ${tokenInfo.tokenExpireAt.toISOString()})`);
        } catch (tokenError: any) {
          console.error(`[InfiniteBuyScheduler] KIS 토큰 발급 실패:`, tokenError.message);
          return null;
        }
      }

      return kisService;
    } catch (error) {
      console.error(`[InfiniteBuyScheduler] KIS 서비스 생성 실패 (userId: ${userId}):`, error);
      return null;
    }
  }

  // 자동 매수 실행 (기본 전략용)
  private async executeAutoBuy() {
    if (!this.config.autoBuyEnabled) {
      console.log('[InfiniteBuyScheduler] 자동 매수 비활성화됨');
      return;
    }

    try {
      // 자동매수 활성화된 buying 상태 종목 조회 (기본 전략만)
      const stocks = await prisma.infiniteBuyStock.findMany({
        where: {
          status: 'buying',
          autoEnabled: true,
          strategy: 'basic',  // 기본 전략만
        },
        include: {
          user: true,
        },
      });

      console.log(`[InfiniteBuyScheduler] 기본 전략 자동 매수 대상: ${stocks.length}개 종목`);

      for (const stock of stocks) {
        try {
          await this.processBuyForStock(stock);
        } catch (error: any) {
          console.error(`[InfiniteBuyScheduler] ${stock.ticker} 매수 처리 실패:`, error.message);
        }

        // API 호출 간 딜레이 (rate limit 방지)
        await this.delay(1000);
      }
    } catch (error) {
      console.error('[InfiniteBuyScheduler] 자동 매수 실행 오류:', error);
    }
  }

  // Strategy1 자동 매수 실행 (LOC 주문)
  private async executeStrategy1AutoBuy() {
    if (!this.config.autoBuyEnabled) {
      console.log('[InfiniteBuyScheduler] 자동 매수 비활성화됨');
      return;
    }

    // 오늘이 거래일인지 확인
    const today = new Date();
    if (!isUSMarketOpen(today)) {
      console.log('[InfiniteBuyScheduler] Strategy1: 오늘은 미국 장 휴일입니다');
      return;
    }

    try {
      // 자동매수 활성화된 buying 상태 종목 조회 (strategy1만)
      const stocks = await prisma.infiniteBuyStock.findMany({
        where: {
          status: 'buying',
          autoEnabled: true,
          strategy: 'strategy1',  // strategy1만
        },
      });

      console.log(`[InfiniteBuyScheduler] Strategy1 자동 매수 대상: ${stocks.length}개 종목`);

      for (const stock of stocks) {
        try {
          await this.processStrategy1BuyForStock(stock);
        } catch (error: any) {
          console.error(`[InfiniteBuyScheduler] Strategy1 ${stock.ticker} 매수 처리 실패:`, error.message);
        }

        // API 호출 간 딜레이 (rate limit 방지)
        await this.delay(2000);  // LOC 주문은 더 긴 딜레이
      }
    } catch (error) {
      console.error('[InfiniteBuyScheduler] Strategy1 자동 매수 실행 오류:', error);
    }
  }

  // Strategy1 개별 종목 매수 처리
  private async processStrategy1BuyForStock(stock: any) {
    const { id: stockId, userId, ticker, currentRound, totalRounds } = stock;

    // 최대 회차 도달 체크
    if (currentRound >= totalRounds) {
      console.log(`[InfiniteBuyScheduler] Strategy1 ${ticker}: 최대 회차 도달 (${currentRound}/${totalRounds})`);
      return;
    }

    // 하루 1회 매수 제한 체크
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayBuyCount = await prisma.infiniteBuyRecord.count({
      where: {
        stockId,
        type: 'buy',
        executedAt: {
          gte: todayStart,
        },
      },
    });

    if (todayBuyCount > 0) {
      console.log(`[InfiniteBuyScheduler] Strategy1 ${ticker}: 오늘 이미 매수함 - 스킵`);
      return;
    }

    console.log(`[InfiniteBuyScheduler] Strategy1 ${ticker}: LOC 매수 실행 중...`);

    try {
      // infiniteBuyStrategy1Service의 executeBuy 호출
      const result = await infiniteBuyStrategy1Service.executeBuy(userId, stockId);
      console.log(`[InfiniteBuyScheduler] Strategy1 ${ticker}: LOC 주문 완료 - ${result.orders.length}개 주문, 총 ${result.totalQuantity}주`);
    } catch (error: any) {
      console.error(`[InfiniteBuyScheduler] Strategy1 ${ticker}: LOC 주문 실패 -`, error.message);
    }
  }

  // 개별 종목 매수 처리
  private async processBuyForStock(stock: any) {
    const { id: stockId, userId, ticker, exchange, buyAmount, currentRound, totalRounds, avgPrice, buyCondition } = stock;

    // 최대 회차 도달 체크
    if (currentRound >= totalRounds) {
      console.log(`[InfiniteBuyScheduler] ${ticker}: 최대 회차 도달 (${currentRound}/${totalRounds})`);
      return;
    }

    // 하루 1회 매수 제한 체크 (오늘 이미 매수했는지 확인)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayBuyCount = await prisma.infiniteBuyRecord.count({
      where: {
        stockId,
        type: 'buy',
        executedAt: {
          gte: todayStart,
        },
      },
    });

    if (todayBuyCount > 0) {
      console.log(`[InfiniteBuyScheduler] ${ticker}: 오늘 이미 매수함 (${todayBuyCount}회) - 스킵`);
      return;
    }

    // KIS 서비스 가져오기
    const kisService = await this.getKisService(userId);
    if (!kisService) {
      console.log(`[InfiniteBuyScheduler] ${ticker}: KIS 서비스 없음`);
      return;
    }

    // 현재가 조회
    let priceData;
    try {
      priceData = await kisService.getUSStockPrice(ticker, exchange);
    } catch (error: any) {
      console.error(`[InfiniteBuyScheduler] ${ticker}: 가격 조회 실패 -`, error.message);
      return;
    }

    const currentPrice = priceData.currentPrice;
    const previousClose = priceData.prevClose || currentPrice;

    // 매수 조건 체크
    const shouldBuy = await this.checkBuyCondition(
      buyCondition,
      currentPrice,
      previousClose,
      avgPrice,
      currentRound
    );

    if (!shouldBuy.result) {
      console.log(`[InfiniteBuyScheduler] ${ticker}: 매수 조건 미충족 - ${shouldBuy.reason}`);
      return;
    }

    console.log(`[InfiniteBuyScheduler] ${ticker}: 매수 실행 (${currentRound + 1}회차, ${currentPrice})`);

    // 매수 수량 계산 (미국 주식은 정수만 가능)
    const quantity = Math.floor(buyAmount / currentPrice);
    if (quantity < 1) {
      console.log(`[InfiniteBuyScheduler] ${ticker}: 매수 금액(${buyAmount})으로 1주도 살 수 없음 (현재가 ${currentPrice})`);
      return;
    }

    // 실제 투자 금액 계산 (정수 수량 기준)
    const actualInvestment = quantity * currentPrice;
    const nextRound = currentRound + 1;

    // 실제 매수 주문 실행
    let orderId: string | null = null;
    try {
      const exchangeCode = exchange === 'NAS' ? 'NASD' :
                          exchange === 'NYS' ? 'NYSE' : 'AMEX';
      const orderResult = await kisService.buyUSStock(
        ticker,
        quantity,
        currentPrice,
        exchangeCode
      );
      orderId = orderResult.orderId;
      console.log(`[InfiniteBuyScheduler] ${ticker}: 주문 완료 (주문번호: ${orderId}, ${quantity}주, ${actualInvestment.toFixed(2)})`);
    } catch (error: any) {
      console.error(`[InfiniteBuyScheduler] ${ticker}: 주문 실패 -`, error.message);
      // 주문 실패 시 기록하지 않고 리턴
      return;
    }

    // 새 평균단가 계산 (실제 투자금액 기준)
    const newTotalInvested = stock.totalInvested + actualInvestment;
    const newTotalQuantity = stock.totalQuantity + quantity;
    const newAvgPrice = newTotalQuantity > 0 ? newTotalInvested / newTotalQuantity : 0;

    // DB 업데이트
    await prisma.$transaction([
      prisma.infiniteBuyStock.update({
        where: { id: stockId },
        data: {
          currentRound: nextRound,
          totalInvested: newTotalInvested,
          totalQuantity: newTotalQuantity,
          avgPrice: newAvgPrice,
        },
      }),
      prisma.infiniteBuyRecord.create({
        data: {
          stockId,
          type: 'buy',
          round: nextRound,
          price: currentPrice,
          quantity,
          amount: actualInvestment,
          orderId,
          orderStatus: 'pending', // 주문 접수 상태로 저장, 체결 확인 후 filled로 변경
        },
      }),
    ]);

    console.log(`[InfiniteBuyScheduler] ${ticker}: 주문 접수 완료 - 회차: ${nextRound}, 체결 대기중...`);
  }

  // 매수 조건 체크
  private async checkBuyCondition(
    condition: string,
    currentPrice: number,
    previousClose: number,
    avgPrice: number,
    currentRound: number
  ): Promise<{ result: boolean; reason: string }> {
    switch (condition) {
      case 'daily':
        // 일일 매수: 무조건 매수
        return { result: true, reason: '일일 매수' };

      case 'loc':
        // LOC 조건: 현재가 <= 전일 종가
        if (currentPrice <= previousClose) {
          return { result: true, reason: `LOC 충족 (현재가 $${currentPrice} <= 전일종가 $${previousClose})` };
        }
        return { result: false, reason: `LOC 미충족 (현재가 $${currentPrice} > 전일종가 $${previousClose})` };

      case 'waterfall':
        // 물타기 조건: 첫 회차이거나, 현재가 <= 평균단가 * 0.95 (-5%)
        if (currentRound === 0) {
          return { result: true, reason: '첫 매수' };
        }
        const waterfallThreshold = avgPrice * 0.95;
        if (currentPrice <= waterfallThreshold) {
          return { result: true, reason: `물타기 충족 (현재가 $${currentPrice} <= 평단-5% $${waterfallThreshold.toFixed(2)})` };
        }
        return { result: false, reason: `물타기 미충족 (현재가 $${currentPrice} > 평단-5% $${waterfallThreshold.toFixed(2)})` };

      case 'loc_waterfall':
        // LOC + 물타기: 둘 다 충족해야 함
        const locCheck = currentPrice <= previousClose;
        const waterfallCheck = currentRound === 0 || currentPrice <= avgPrice * 0.95;

        if (currentRound === 0) {
          // 첫 매수는 LOC만 체크
          if (locCheck) {
            return { result: true, reason: '첫 매수 + LOC 충족' };
          }
          return { result: false, reason: 'LOC 미충족' };
        }

        if (locCheck && waterfallCheck) {
          return { result: true, reason: 'LOC + 물타기 모두 충족' };
        }
        if (!locCheck) {
          return { result: false, reason: 'LOC 미충족' };
        }
        return { result: false, reason: '물타기 미충족' };

      default:
        return { result: true, reason: '기본 매수' };
    }
  }

  // 가격 체크 및 자동 익절
  private async checkPricesAndSell() {
    if (!this.config.autoSellEnabled) {
      return;
    }

    try {
      // buying 상태이고 보유수량이 있는 종목 조회
      const stocks = await prisma.infiniteBuyStock.findMany({
        where: {
          status: 'buying',
          totalQuantity: { gt: 0 },
        },
      });

      if (stocks.length === 0) {
        return;
      }

      // 유저별로 그룹화
      const userStockMap = new Map<number, typeof stocks>();
      for (const stock of stocks) {
        const userStocks = userStockMap.get(stock.userId) || [];
        userStocks.push(stock);
        userStockMap.set(stock.userId, userStocks);
      }

      // 유저별로 처리
      for (const [userId, userStocks] of userStockMap) {
        const kisService = await this.getKisService(userId);
        if (!kisService) continue;

        for (const stock of userStocks) {
          try {
            await this.checkAndSellStock(stock, kisService);
          } catch (error: any) {
            console.error(`[InfiniteBuyScheduler] ${stock.ticker} 익절 체크 실패:`, error.message);
          }

          // API 호출 간 딜레이
          await this.delay(500);
        }
      }
    } catch (error) {
      console.error('[InfiniteBuyScheduler] 가격 체크 오류:', error);
    }
  }

  // 개별 종목 익절 체크 및 실행
  private async checkAndSellStock(stock: any, kisService: KisService) {
    const { id: stockId, ticker, exchange, avgPrice, targetProfit, totalQuantity, totalInvested } = stock;

    // 목표가 계산
    const targetPrice = avgPrice * (1 + targetProfit / 100);

    // 현재가 조회
    let priceData;
    try {
      priceData = await kisService.getUSStockPrice(ticker, exchange);
    } catch {
      return;
    }

    const currentPrice = priceData.currentPrice;

    // 익절 조건 체크: 현재가 >= 목표가
    if (currentPrice < targetPrice) {
      return;
    }

    console.log(`[InfiniteBuyScheduler] ${ticker}: 익절 조건 충족! (현재가 $${currentPrice} >= 목표가 $${targetPrice.toFixed(2)})`);

    // 매도 금액 및 수익 계산
    const sellAmount = currentPrice * totalQuantity;
    const profit = sellAmount - totalInvested;
    const profitPercent = totalInvested > 0 ? (profit / totalInvested) * 100 : 0;

    // 실제 매도 주문 실행
    let orderId: string | null = null;
    try {
      const exchangeCode = exchange === 'NAS' ? 'NASD' :
                          exchange === 'NYS' ? 'NYSE' : 'AMEX';
      const orderResult = await kisService.sellUSStock(
        ticker,
        totalQuantity,
        currentPrice,
        exchangeCode
      );
      orderId = orderResult.orderId;
      console.log(`[InfiniteBuyScheduler] ${ticker}: 매도 주문 완료 (주문번호: ${orderId})`);
    } catch (error: any) {
      console.error(`[InfiniteBuyScheduler] ${ticker}: 매도 주문 실패 -`, error.message);
    }

    // DB 업데이트 - 익절 완료
    await prisma.$transaction([
      prisma.infiniteBuyStock.update({
        where: { id: stockId },
        data: {
          totalQuantity: 0,
          totalInvested: 0,
          avgPrice: 0,
          currentRound: 0,
          status: 'completed',
          completedAt: new Date(),
        },
      }),
      prisma.infiniteBuyRecord.create({
        data: {
          stockId,
          type: 'sell',
          price: currentPrice,
          quantity: totalQuantity,
          amount: sellAmount,
          profit,
          profitPercent,
          orderId,
          orderStatus: orderId ? 'filled' : 'pending',
        },
      }),
    ]);

    console.log(`[InfiniteBuyScheduler] ${ticker}: 익절 완료 - 수익: $${profit.toFixed(2)} (${profitPercent.toFixed(2)}%)`);
  }

  // 체결 대기중인 주문 확인
  private async checkPendingOrders() {
    try {
      // pending 상태인 주문 조회
      const pendingRecords = await prisma.infiniteBuyRecord.findMany({
        where: {
          orderStatus: 'pending',
          orderId: { not: null },
        },
        include: {
          stock: true,
        },
      });

      if (pendingRecords.length === 0) {
        return;
      }

      console.log(`[InfiniteBuyScheduler] 체결 대기 주문 확인: ${pendingRecords.length}건`);

      // 유저별로 그룹화
      const userRecordMap = new Map<number, typeof pendingRecords>();
      for (const record of pendingRecords) {
        const userId = record.stock.userId;
        const userRecords = userRecordMap.get(userId) || [];
        userRecords.push(record);
        userRecordMap.set(userId, userRecords);
      }

      // 유저별로 KIS API 호출하여 체결 확인
      for (const [userId, records] of userRecordMap) {
        const kisService = await this.getKisService(userId);
        if (!kisService) continue;

        try {
          // KIS API에서 체결 내역 조회
          const kisOrders = await kisService.getUSStockOrders();

          // orderId로 매칭하여 체결 확인
          for (const record of records) {
            const kisOrder = kisOrders.find((o: any) => o.orderId === record.orderId);

            if (kisOrder && kisOrder.filledQty > 0) {
              // 체결됨 - DB 업데이트
              await prisma.infiniteBuyRecord.update({
                where: { id: record.id },
                data: {
                  orderStatus: 'filled',
                  price: kisOrder.filledPrice || record.price, // 실제 체결가로 업데이트
                  quantity: kisOrder.filledQty,
                  amount: kisOrder.filledPrice * kisOrder.filledQty,
                  filledAt: new Date(),
                },
              });

              console.log(`[InfiniteBuyScheduler] ${record.stock.ticker}: 체결 확인 완료 (주문번호: ${record.orderId}, ${kisOrder.filledQty}주, $${kisOrder.filledPrice})`);
            }
          }
        } catch (error: any) {
          console.error(`[InfiniteBuyScheduler] 체결 확인 실패 (userId: ${userId}):`, error.message);
        }

        // API 호출 간 딜레이
        await this.delay(500);
      }
    } catch (error) {
      console.error('[InfiniteBuyScheduler] 체결 확인 오류:', error);
    }
  }

  // 딜레이 유틸리티
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // 상태 조회
  getStatus() {
    return {
      isRunning: this.isRunning,
      config: this.config,
    };
  }

  // 진단 정보 조회 (디버깅용)
  async getDiagnostics(userId?: number) {
    const now = new Date();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // 오늘이 거래일인지 확인
    const isMarketDay = isUSMarketOpen(now);

    // 기본 전략 대상 종목 조회
    const basicStocksQuery: any = {
      status: 'buying',
      autoEnabled: true,
      strategy: 'basic',
    };
    if (userId) basicStocksQuery.userId = userId;

    const basicStocks = await prisma.infiniteBuyStock.findMany({
      where: basicStocksQuery,
      include: { user: { select: { email: true } } },
    });

    // Strategy1 대상 종목 조회
    const strategy1StocksQuery: any = {
      status: 'buying',
      autoEnabled: true,
      strategy: 'strategy1',
    };
    if (userId) strategy1StocksQuery.userId = userId;

    const strategy1Stocks = await prisma.infiniteBuyStock.findMany({
      where: strategy1StocksQuery,
      include: { user: { select: { email: true } } },
    });

    // 각 종목별 상세 진단 정보
    const basicDiagnostics = await Promise.all(
      basicStocks.map(async (stock) => {
        // 오늘 매수 기록 확인
        const todayBuyCount = await prisma.infiniteBuyRecord.count({
          where: {
            stockId: stock.id,
            type: 'buy',
            executedAt: { gte: todayStart },
          },
        });

        // 최대 회차 도달 여부
        const maxRoundsReached = stock.currentRound >= stock.totalRounds;

        // KIS 자격증명 확인
        const credential = await prisma.credential.findFirst({
          where: { userId: stock.userId, exchange: 'kis' },
          select: { id: true, accessToken: true, tokenExpireAt: true },
        });

        const hasKisCredential = !!credential;
        const hasValidToken = credential?.accessToken && credential?.tokenExpireAt
          ? credential.tokenExpireAt.getTime() > now.getTime()
          : false;

        // 매수 조건 설명
        let buyConditionDesc = '';
        switch (stock.buyCondition) {
          case 'daily':
            buyConditionDesc = '일일 매수 - 항상 매수';
            break;
          case 'loc':
            buyConditionDesc = 'LOC - 현재가 <= 전일종가일 때만 매수';
            break;
          case 'waterfall':
            buyConditionDesc = '물타기 - 첫회차 또는 현재가 <= 평단-5%일 때만 매수';
            break;
          case 'loc_waterfall':
            buyConditionDesc = 'LOC+물타기 - 두 조건 모두 충족시 매수';
            break;
          default:
            buyConditionDesc = stock.buyCondition || '기본';
        }

        // 매수 가능 여부 판단
        const canBuy = !maxRoundsReached && todayBuyCount === 0 && hasKisCredential;

        return {
          stockId: stock.id,
          ticker: stock.ticker,
          name: stock.name,
          strategy: stock.strategy,
          status: stock.status,
          autoEnabled: stock.autoEnabled,
          currentRound: stock.currentRound,
          totalRounds: stock.totalRounds,
          buyAmount: stock.buyAmount,
          buyCondition: stock.buyCondition,
          buyConditionDesc,
          avgPrice: stock.avgPrice,
          checks: {
            maxRoundsReached,
            alreadyBoughtToday: todayBuyCount > 0,
            todayBuyCount,
            hasKisCredential,
            hasValidToken,
          },
          canBuy,
          skipReason: !canBuy
            ? maxRoundsReached
              ? '최대 회차 도달'
              : todayBuyCount > 0
                ? '오늘 이미 매수함'
                : !hasKisCredential
                  ? 'KIS 자격증명 없음'
                  : '알 수 없음'
            : null,
          userId: stock.userId,
          userEmail: (stock as any).user?.email,
        };
      })
    );

    const strategy1Diagnostics = await Promise.all(
      strategy1Stocks.map(async (stock) => {
        // 오늘 매수 기록 확인
        const todayBuyCount = await prisma.infiniteBuyRecord.count({
          where: {
            stockId: stock.id,
            type: 'buy',
            executedAt: { gte: todayStart },
          },
        });

        // 최대 회차 도달 여부
        const maxRoundsReached = stock.currentRound >= stock.totalRounds;

        // KIS 자격증명 확인
        const credential = await prisma.credential.findFirst({
          where: { userId: stock.userId, exchange: 'kis' },
          select: { id: true, accessToken: true, tokenExpireAt: true },
        });

        const hasKisCredential = !!credential;
        const hasValidToken = credential?.accessToken && credential?.tokenExpireAt
          ? credential.tokenExpireAt.getTime() > now.getTime()
          : false;

        // 매수 가능 여부 판단
        const canBuy = isMarketDay && !maxRoundsReached && todayBuyCount === 0 && hasKisCredential;

        return {
          stockId: stock.id,
          ticker: stock.ticker,
          name: stock.name,
          strategy: stock.strategy,
          status: stock.status,
          autoEnabled: stock.autoEnabled,
          currentRound: stock.currentRound,
          totalRounds: stock.totalRounds,
          buyAmount: stock.buyAmount,
          avgPrice: stock.avgPrice,
          checks: {
            isMarketDay,
            maxRoundsReached,
            alreadyBoughtToday: todayBuyCount > 0,
            todayBuyCount,
            hasKisCredential,
            hasValidToken,
          },
          canBuy,
          skipReason: !canBuy
            ? !isMarketDay
              ? '미국 장 휴일'
              : maxRoundsReached
                ? '최대 회차 도달'
                : todayBuyCount > 0
                  ? '오늘 이미 매수함'
                  : !hasKisCredential
                    ? 'KIS 자격증명 없음'
                    : '알 수 없음'
            : null,
          userId: stock.userId,
          userEmail: (stock as any).user?.email,
        };
      })
    );

    return {
      timestamp: now.toISOString(),
      schedulerStatus: this.getStatus(),
      marketInfo: {
        isMarketDay,
        currentTime: now.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
        dayOfWeek: now.toLocaleDateString('ko-KR', { weekday: 'long', timeZone: 'Asia/Seoul' }),
      },
      basic: {
        totalTargets: basicStocks.length,
        canBuyCount: basicDiagnostics.filter(d => d.canBuy).length,
        stocks: basicDiagnostics,
      },
      strategy1: {
        totalTargets: strategy1Stocks.length,
        canBuyCount: strategy1Diagnostics.filter(d => d.canBuy).length,
        stocks: strategy1Diagnostics,
      },
    };
  }

  // 설정 변경
  updateConfig(newConfig: Partial<SchedulerConfig>) {
    this.config = { ...this.config, ...newConfig };
    console.log('[InfiniteBuyScheduler] 설정 변경:', this.config);
  }
}

export const infiniteBuyScheduler = new InfiniteBuySchedulerService();
