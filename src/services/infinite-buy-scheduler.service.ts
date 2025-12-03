import cron from 'node-cron';
import prisma from '../config/database';
import { KisService } from './kis.service';
import { decrypt } from '../utils/encryption';
import { InfiniteBuyStatus } from '@prisma/client';

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
  private autoBuyJob: cron.ScheduledTask | null = null;
  private priceCheckJob: cron.ScheduledTask | null = null;
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
    // 매일 22:35 (서머타임), 23:35 (동절기)에 자동 매수 실행
    // 테스트를 위해 매 시간 35분에도 실행
    this.autoBuyJob = cron.schedule('35 22,23 * * 1-5', async () => {
      console.log('[InfiniteBuyScheduler] 자동 매수 스케줄 실행');
      await this.executeAutoBuy();
    }, {
      timezone: 'Asia/Seoul'
    });

    // 장중 가격 체크 (매 5분마다, 미국 장 시간 22:30 ~ 05:00 KST)
    this.priceCheckJob = cron.schedule(`*/${this.config.priceCheckInterval} 22,23,0,1,2,3,4,5 * * 1-6`, async () => {
      await this.checkPricesAndSell();
    }, {
      timezone: 'Asia/Seoul'
    });

    this.isRunning = true;
    console.log('[InfiniteBuyScheduler] 스케줄 등록 완료');
    console.log('  - 자동 매수: 매일 22:35, 23:35 (KST)');
    console.log(`  - 가격 체크: 장중 매 ${this.config.priceCheckInterval}분`);
  }

  // 스케줄러 중지
  stop() {
    if (this.autoBuyJob) {
      this.autoBuyJob.stop();
      this.autoBuyJob = null;
    }
    if (this.priceCheckJob) {
      this.priceCheckJob.stop();
      this.priceCheckJob = null;
    }
    this.isRunning = false;
    console.log('[InfiniteBuyScheduler] 스케줄러 중지됨');
  }

  // 수동 실행 (테스트용)
  async runManualBuy() {
    console.log('[InfiniteBuyScheduler] 수동 매수 실행');
    await this.executeAutoBuy();
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

      if (credential.accessToken && credential.tokenExpireAt) {
        kisService.setAccessToken(
          decrypt(credential.accessToken),
          credential.tokenExpireAt
        );
      }

      return kisService;
    } catch (error) {
      console.error(`[InfiniteBuyScheduler] KIS 서비스 생성 실패 (userId: ${userId}):`, error);
      return null;
    }
  }

  // 자동 매수 실행
  private async executeAutoBuy() {
    if (!this.config.autoBuyEnabled) {
      console.log('[InfiniteBuyScheduler] 자동 매수 비활성화됨');
      return;
    }

    try {
      // 자동매수 활성화된 buying 상태 종목 조회
      const stocks = await prisma.infiniteBuyStock.findMany({
        where: {
          status: 'buying',
          autoEnabled: true,
        },
        include: {
          user: true,
        },
      });

      console.log(`[InfiniteBuyScheduler] 자동 매수 대상: ${stocks.length}개 종목`);

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

  // 개별 종목 매수 처리
  private async processBuyForStock(stock: any) {
    const { id: stockId, userId, ticker, exchange, buyAmount, currentRound, totalRounds, avgPrice, buyCondition } = stock;

    // 최대 회차 도달 체크
    if (currentRound >= totalRounds) {
      console.log(`[InfiniteBuyScheduler] ${ticker}: 최대 회차 도달 (${currentRound}/${totalRounds})`);
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
    const previousClose = priceData.previousClose || currentPrice;

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

    console.log(`[InfiniteBuyScheduler] ${ticker}: 매수 실행 (${currentRound + 1}회차, $${currentPrice})`);

    // 매수 수량 계산
    const quantity = buyAmount / currentPrice;
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
      console.log(`[InfiniteBuyScheduler] ${ticker}: 주문 완료 (주문번호: ${orderId})`);
    } catch (error: any) {
      console.error(`[InfiniteBuyScheduler] ${ticker}: 주문 실패 -`, error.message);
      // 주문 실패해도 기록은 남김 (모의투자 테스트용)
    }

    // 새 평균단가 계산
    const newTotalInvested = stock.totalInvested + buyAmount;
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
          amount: buyAmount,
          orderId,
          orderStatus: orderId ? 'filled' : 'pending',
        },
      }),
    ]);

    console.log(`[InfiniteBuyScheduler] ${ticker}: 매수 완료 - 회차: ${nextRound}, 평단: $${newAvgPrice.toFixed(2)}`);
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

  // 설정 변경
  updateConfig(newConfig: Partial<SchedulerConfig>) {
    this.config = { ...this.config, ...newConfig };
    console.log('[InfiniteBuyScheduler] 설정 변경:', this.config);
  }
}

export const infiniteBuyScheduler = new InfiniteBuySchedulerService();
