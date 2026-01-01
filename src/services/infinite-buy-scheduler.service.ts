import cron, { ScheduledTask } from 'node-cron';
import prisma from '../config/database';
import { KisService } from './kis.service';
import { decrypt } from '../utils/encryption';
import { InfiniteBuyStatus, SchedulerLogType, SchedulerLogStatus } from '@prisma/client';
import { infiniteBuyStrategy1Service } from './infinite-buy-strategy1.service';
import { isUSMarketOpen, isUSMarketEarlyCloseDay, getEarlyCloseDayName } from '../utils/us-market-holidays';
import { PushService } from './push.service';

// 로그 저장 헬퍼
interface LogParams {
  type: SchedulerLogType;
  status: SchedulerLogStatus;
  stockId?: number;
  ticker?: string;
  message: string;
  details?: any;
  errorMessage?: string;
}

async function saveLog(params: LogParams) {
  try {
    await prisma.schedulerLog.create({
      data: {
        type: params.type,
        status: params.status,
        stockId: params.stockId,
        ticker: params.ticker,
        message: params.message,
        details: params.details ? JSON.stringify(params.details) : null,
        errorMessage: params.errorMessage,
      },
    });
  } catch (error) {
    console.error('[SchedulerLog] 로그 저장 실패:', error);
  }
}

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
  private strategy1EarlyCloseJob: ScheduledTask | null = null;  // 조기마감일 LOC 전용
  private priceCheckJob: ScheduledTask | null = null;
  private orderCheckJob: ScheduledTask | null = null;
  private locOrderCheckJob: ScheduledTask | null = null;  // LOC 주문 체결 확인 전용
  private locEarlyCloseOrderCheckJob: ScheduledTask | null = null;  // 조기마감일 LOC 체결 확인
  private isRunning: boolean = false;
  private config: SchedulerConfig = {
    autoBuyEnabled: true,
    autoSellEnabled: true,
    priceCheckInterval: 5, // 5분마다 가격 체크
  };

  // 토큰 발급 제한 (2시간에 1회만)
  private lastTokenIssueTime: Map<number, Date> = new Map();
  private TOKEN_ISSUE_COOLDOWN = 2 * 60 * 60 * 1000; // 2시간

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

    // Strategy1 LOC 주문 (장 마감 1.5시간 전 - 04:30 KST 동절기)
    // 장 마감 가까운 시간에 LOC 주문을 넣어야 종가 예측이 가능
    this.strategy1BuyJob = cron.schedule('30 4 * * 2-6', async () => {
      console.log('[InfiniteBuyScheduler] Strategy1 LOC 자동 매수 스케줄 실행');
      await this.executeStrategy1AutoBuy(false);  // 조기마감일은 스킵
    }, {
      timezone: 'Asia/Seoul'
    });

    // Strategy1 조기마감일 LOC 주문 (02:00 KST - 조기마감 1시간 전)
    // 조기마감일(7/3, 블랙프라이데이, 12/24)은 1:00 PM ET 마감이므로 02:00 KST에 주문
    this.strategy1EarlyCloseJob = cron.schedule('0 2 * * 2-6', async () => {
      console.log('[InfiniteBuyScheduler] Strategy1 조기마감일 LOC 자동 매수 스케줄 실행');
      await this.executeStrategy1AutoBuy(true);  // 조기마감일 전용
    }, {
      timezone: 'Asia/Seoul'
    });

    // 장중 가격 체크 (매 5분마다, 미국 장 시간 22:30 ~ 05:00 KST)
    this.priceCheckJob = cron.schedule(`*/${this.config.priceCheckInterval} 22,23,0,1,2,3,4,5 * * 1-6`, async () => {
      await this.checkPricesAndSell();
    }, {
      timezone: 'Asia/Seoul'
    });

    // 기본 전략 체결 확인 (매 10분마다, 미국 장 시간) - LOC 주문 제외
    this.orderCheckJob = cron.schedule('*/10 22,23,0,1,2,3,4,5 * * 1-6', async () => {
      await this.checkPendingOrders('basic');
    }, {
      timezone: 'Asia/Seoul'
    });

    // LOC 주문 체결 확인 (장 마감 후 1회, 06:10 KST 동절기)
    // LOC 주문은 장 마감가(6:00 AM KST)에만 체결되므로 장 마감 후 한 번만 확인
    this.locOrderCheckJob = cron.schedule('10 6 * * 2-6', async () => {
      console.log('[InfiniteBuyScheduler] LOC 주문 체결 확인 실행');
      await this.checkPendingOrders('strategy1');
    }, {
      timezone: 'Asia/Seoul'
    });

    // 조기마감일 LOC 주문 체결 확인 (03:10 KST - 조기마감 후)
    // 조기마감일은 1:00 PM ET = 약 03:00 KST 마감이므로 03:10에 체결 확인
    this.locEarlyCloseOrderCheckJob = cron.schedule('10 3 * * 2-6', async () => {
      // 조기마감일에만 실행
      const today = new Date();
      if (isUSMarketEarlyCloseDay(today)) {
        console.log('[InfiniteBuyScheduler] 조기마감일 LOC 주문 체결 확인 실행');
        await this.checkPendingOrders('strategy1');
      }
    }, {
      timezone: 'Asia/Seoul'
    });

    this.isRunning = true;
    console.log('[InfiniteBuyScheduler] 스케줄 등록 완료');
    console.log('  - 기본 전략 매수: 매일 23:35 (KST, 동절기)');
    console.log('  - Strategy1 LOC 매수: 매일 04:30 (KST, 동절기) - 장 마감 1.5시간 전');
    console.log('  - Strategy1 조기마감일 LOC: 매일 02:00 (KST) - 조기마감 1시간 전');
    console.log(`  - 가격 체크: 장중 매 ${this.config.priceCheckInterval}분`);
    console.log('  - 기본 전략 체결 확인: 장중 매 10분');
    console.log('  - LOC 체결 확인: 장 마감 후 06:10 (KST) 1회');
    console.log('  - 조기마감일 LOC 체결 확인: 03:10 (KST) - 조기마감 후');
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
    if (this.strategy1EarlyCloseJob) {
      this.strategy1EarlyCloseJob.stop();
      this.strategy1EarlyCloseJob = null;
    }
    if (this.priceCheckJob) {
      this.priceCheckJob.stop();
      this.priceCheckJob = null;
    }
    if (this.orderCheckJob) {
      this.orderCheckJob.stop();
      this.orderCheckJob = null;
    }
    if (this.locOrderCheckJob) {
      this.locOrderCheckJob.stop();
      this.locOrderCheckJob = null;
    }
    if (this.locEarlyCloseOrderCheckJob) {
      this.locEarlyCloseOrderCheckJob.stop();
      this.locEarlyCloseOrderCheckJob = null;
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

  // 수동 체결 확인
  async runManualOrderCheck() {
    console.log('[InfiniteBuyScheduler] 수동 체결 확인 실행');
    await this.checkPendingOrders();
  }

  // KIS 서비스 인스턴스 가져오기
  private async getKisService(userId: number): Promise<KisService | null> {
    try {
      const credential = await prisma.credential.findFirst({
        where: { userId, exchange: 'kis' },
      });

      if (!credential) {
        console.log(`[InfiniteBuyScheduler] KIS 자격증명 없음 (userId: ${userId})`);
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
      let tokenStatus = '';

      if (credential.accessToken && credential.tokenExpireAt) {
        const now = new Date();
        const bufferTime = 10 * 60 * 1000; // 10분 여유
        const timeUntilExpiry = credential.tokenExpireAt.getTime() - now.getTime();

        if (timeUntilExpiry > bufferTime) {
          try {
            const decryptedToken = decrypt(credential.accessToken);
            kisService.setAccessToken(decryptedToken, credential.tokenExpireAt);
            needNewToken = false;
            tokenStatus = `유효 (만료까지 ${Math.round(timeUntilExpiry / 60000)}분)`;
          } catch (decryptError: any) {
            tokenStatus = `복호화 실패: ${decryptError.message}`;
          }
        } else {
          tokenStatus = `만료됨 (${Math.round(timeUntilExpiry / 60000)}분 전)`;
        }
      } else {
        tokenStatus = credential.accessToken ? 'tokenExpireAt 없음' : '토큰 없음';
      }

      // 토큰이 없거나 만료됐으면 새로 발급 후 DB에 저장
      if (needNewToken) {
        // 토큰 발급 쿨다운 체크 (1시간에 1회만)
        const lastIssue = this.lastTokenIssueTime.get(userId);
        const now = new Date();

        if (lastIssue && (now.getTime() - lastIssue.getTime()) < this.TOKEN_ISSUE_COOLDOWN) {
          const waitMinutes = Math.ceil((this.TOKEN_ISSUE_COOLDOWN - (now.getTime() - lastIssue.getTime())) / 60000);
          console.error(`[InfiniteBuyScheduler] KIS 토큰 발급 쿨다운 중 (userId: ${userId}, ${waitMinutes}분 후 재시도 가능)`);
          console.error(`[InfiniteBuyScheduler] 토큰 상태: ${tokenStatus}`);

          // 로그 저장
          await saveLog({
            type: 'auto_buy',
            status: 'error',
            message: `KIS 토큰 발급 쿨다운 - ${waitMinutes}분 후 재시도 가능`,
            details: { userId, tokenStatus, lastIssue: lastIssue.toISOString() },
          });

          return null;
        }

        console.log(`[InfiniteBuyScheduler] KIS 토큰 갱신 필요 (userId: ${userId})`);
        console.log(`[InfiniteBuyScheduler] 토큰 상태: ${tokenStatus}`);

        try {
          const tokenInfo = await kisService.getAccessToken();

          // 발급 시간 기록
          this.lastTokenIssueTime.set(userId, now);

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

          // 로그 저장
          await saveLog({
            type: 'auto_buy',
            status: 'completed',
            message: `KIS 토큰 갱신 완료`,
            details: { userId, expireAt: tokenInfo.tokenExpireAt.toISOString() },
          });
        } catch (tokenError: any) {
          console.error(`[InfiniteBuyScheduler] KIS 토큰 발급 실패:`, tokenError.message);

          // 로그 저장
          await saveLog({
            type: 'auto_buy',
            status: 'error',
            message: `KIS 토큰 발급 실패`,
            errorMessage: tokenError.message,
            details: { userId, tokenStatus },
          });

          return null;
        }
      }

      // 토큰 재발급 콜백 설정 (withTokenRefresh에서 자동 재발급 시 DB 저장용)
      kisService.setTokenRefreshCallback(async (newToken: string, newExpireAt: Date) => {
        try {
          const { encrypt } = await import('../utils/encryption');
          await prisma.credential.update({
            where: { id: credential.id },
            data: {
              accessToken: encrypt(newToken),
              tokenExpireAt: newExpireAt,
            },
          });
          console.log(`[InfiniteBuyScheduler] 토큰 자동 갱신 및 DB 저장 완료 (userId: ${userId})`);
        } catch (err: any) {
          console.error(`[InfiniteBuyScheduler] 토큰 DB 저장 실패:`, err.message);
        }
      });

      return kisService;
    } catch (error: any) {
      console.error(`[InfiniteBuyScheduler] KIS 서비스 생성 실패 (userId: ${userId}):`, error);
      return null;
    }
  }

  // 자동 매수 실행 (기본 전략용)
  private async executeAutoBuy() {
    if (!this.config.autoBuyEnabled) {
      console.log('[InfiniteBuyScheduler] 자동 매수 비활성화됨');
      await saveLog({
        type: 'auto_buy',
        status: 'skipped',
        message: '자동 매수 비활성화됨',
      });
      return;
    }

    // 오늘이 거래일인지 확인 (미국 휴일 체크)
    const today = new Date();
    if (!isUSMarketOpen(today)) {
      console.log('[InfiniteBuyScheduler] 기본 전략: 오늘은 미국 장 휴일입니다');
      await saveLog({
        type: 'auto_buy',
        status: 'skipped',
        message: '오늘은 미국 장 휴일 - 기본 전략 스케줄 스킵',
      });
      return;
    }

    // 스케줄 시작 로그
    await saveLog({
      type: 'auto_buy',
      status: 'started',
      message: '기본 전략 자동 매수 스케줄 시작',
    });

    let processedCount = 0;
    let successCount = 0;
    let skipCount = 0;
    let errorCount = 0;
    const results: any[] = [];

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
        processedCount++;
        try {
          const result = await this.processBuyForStock(stock);
          if (result.success) {
            successCount++;
          } else {
            skipCount++;
          }
          results.push(result);
        } catch (error: any) {
          errorCount++;
          console.error(`[InfiniteBuyScheduler] ${stock.ticker} 매수 처리 실패:`, error.message);
          results.push({
            stockId: stock.id,
            ticker: stock.ticker,
            success: false,
            error: error.message,
          });

          // 개별 에러 로그 (상세 에러 메시지 포함)
          await saveLog({
            type: 'auto_buy',
            status: 'error',
            stockId: stock.id,
            ticker: stock.ticker,
            message: `${stock.ticker} 매수 처리 실패`,
            errorMessage: error.message,
            details: {
              userId: stock.userId,
              ticker: stock.ticker,
              currentRound: stock.currentRound,
              buyAmount: stock.buyAmount,
              errorDetail: error.message,
            },
          });

          // 주문 실패 시 푸시 알림 전송
          try {
            await PushService.sendToUser(stock.userId, {
              title: `❌ ${stock.ticker} 매수 주문 실패`,
              body: error.message,
              icon: '/icon-192x192.svg',
              tag: `order-failed-${stock.ticker}`,
              data: {
                type: 'order_failed',
                ticker: stock.ticker,
                error: error.message,
              },
            });
          } catch (pushError) {
            console.error(`[InfiniteBuyScheduler] 푸시 알림 전송 실패:`, pushError);
          }
        }

        // API 호출 간 딜레이 (rate limit 방지)
        await this.delay(1000);
      }

      // 완료 로그
      await saveLog({
        type: 'auto_buy',
        status: 'completed',
        message: `기본 전략 자동 매수 완료: ${stocks.length}개 대상, ${successCount}개 성공, ${skipCount}개 스킵, ${errorCount}개 에러`,
        details: {
          totalTargets: stocks.length,
          processed: processedCount,
          success: successCount,
          skipped: skipCount,
          errors: errorCount,
          results,
        },
      });
    } catch (error: any) {
      console.error('[InfiniteBuyScheduler] 자동 매수 실행 오류:', error);
      await saveLog({
        type: 'auto_buy',
        status: 'error',
        message: '자동 매수 실행 중 오류 발생',
        errorMessage: error.message,
      });
    }
  }

  // Strategy1 자동 매수 실행 (LOC 주문)
  // forEarlyCloseDay: true면 조기마감일 전용 스케줄에서 호출 (02:00 KST)
  //                   false면 일반 스케줄에서 호출 (04:30 KST)
  private async executeStrategy1AutoBuy(forEarlyCloseDay: boolean = false) {
    if (!this.config.autoBuyEnabled) {
      console.log('[InfiniteBuyScheduler] 자동 매수 비활성화됨');
      await saveLog({
        type: 'strategy1_buy',
        status: 'skipped',
        message: '자동 매수 비활성화됨',
      });
      return;
    }

    // 오늘이 거래일인지 확인
    const today = new Date();
    if (!isUSMarketOpen(today)) {
      console.log('[InfiniteBuyScheduler] Strategy1: 오늘은 미국 장 휴일입니다');
      await saveLog({
        type: 'strategy1_buy',
        status: 'skipped',
        message: '오늘은 미국 장 휴일 - Strategy1 스케줄 스킵',
      });
      return;
    }

    const isEarlyCloseToday = isUSMarketEarlyCloseDay(today);
    const dayName = isEarlyCloseToday ? (getEarlyCloseDayName(today) || '조기 마감일') : null;

    // 조기마감일 처리 로직
    if (forEarlyCloseDay) {
      // 02:00 KST 스케줄: 조기마감일에만 실행
      if (!isEarlyCloseToday) {
        console.log('[InfiniteBuyScheduler] Strategy1: 조기마감일 아님 - 02:00 스케줄 스킵');
        return;  // 로그 없이 조용히 스킵
      }
      console.log(`[InfiniteBuyScheduler] Strategy1: ${dayName} - 조기마감일 LOC 주문 실행`);
    } else {
      // 04:30 KST 스케줄: 조기마감일에는 스킵 (02:00에 이미 실행됨)
      if (isEarlyCloseToday) {
        console.log(`[InfiniteBuyScheduler] Strategy1: ${dayName}로 조기 마감 - 04:30 스케줄 스킵 (02:00에 실행됨)`);
        await saveLog({
          type: 'strategy1_buy',
          status: 'skipped',
          message: `${dayName} - 04:30 스케줄 스킵 (02:00에 실행됨)`,
          details: { reason: 'early_close_already_executed', dayName },
        });
        return;
      }
    }

    // 스케줄 시작 로그
    await saveLog({
      type: 'strategy1_buy',
      status: 'started',
      message: forEarlyCloseDay
        ? `Strategy1 LOC 자동 매수 스케줄 시작 (${dayName} - 02:00 스케줄)`
        : 'Strategy1 LOC 자동 매수 스케줄 시작 (04:30 스케줄)',
    });

    let processedCount = 0;
    let successCount = 0;
    let skipCount = 0;
    let errorCount = 0;
    const results: any[] = [];

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
        processedCount++;
        try {
          const result = await this.processStrategy1BuyForStock(stock);
          if (result.success) {
            successCount++;
          } else {
            skipCount++;
          }
          results.push(result);
        } catch (error: any) {
          errorCount++;
          console.error(`[InfiniteBuyScheduler] Strategy1 ${stock.ticker} 매수 처리 실패:`, error.message);
          results.push({
            stockId: stock.id,
            ticker: stock.ticker,
            success: false,
            error: error.message,
          });

          // 개별 에러 로그 (상세 에러 메시지 포함)
          await saveLog({
            type: 'strategy1_buy',
            status: 'error',
            stockId: stock.id,
            ticker: stock.ticker,
            message: `Strategy1 ${stock.ticker} LOC 매수 처리 실패`,
            errorMessage: error.message,
            details: {
              userId: stock.userId,
              ticker: stock.ticker,
              currentRound: stock.currentRound,
              buyAmount: stock.buyAmount,
              errorDetail: error.message,
            },
          });

          // 주문 실패 시 푸시 알림 전송
          try {
            await PushService.sendToUser(stock.userId, {
              title: `❌ ${stock.ticker} 매수 주문 실패`,
              body: error.message,
              icon: '/icon-192x192.svg',
              tag: `order-failed-${stock.ticker}`,
              data: {
                type: 'order_failed',
                ticker: stock.ticker,
                error: error.message,
              },
            });
          } catch (pushError) {
            console.error(`[InfiniteBuyScheduler] 푸시 알림 전송 실패:`, pushError);
          }
        }

        // API 호출 간 딜레이 (rate limit 방지)
        await this.delay(2000);  // LOC 주문은 더 긴 딜레이
      }

      // 완료 로그
      await saveLog({
        type: 'strategy1_buy',
        status: 'completed',
        message: `Strategy1 자동 매수 완료: ${stocks.length}개 대상, ${successCount}개 성공, ${skipCount}개 스킵, ${errorCount}개 에러`,
        details: {
          totalTargets: stocks.length,
          processed: processedCount,
          success: successCount,
          skipped: skipCount,
          errors: errorCount,
          results,
        },
      });
    } catch (error: any) {
      console.error('[InfiniteBuyScheduler] Strategy1 자동 매수 실행 오류:', error);
      await saveLog({
        type: 'strategy1_buy',
        status: 'error',
        message: 'Strategy1 자동 매수 실행 중 오류 발생',
        errorMessage: error.message,
      });
    }
  }

  // Strategy1 개별 종목 매수 처리 (결과 반환)
  private async processStrategy1BuyForStock(stock: any): Promise<{
    stockId: number;
    ticker: string;
    success: boolean;
    skipped?: boolean;
    reason?: string;
    orders?: number;
    totalQuantity?: number;
    sellOrders?: number;
  }> {
    const { id: stockId, userId, ticker, currentRound, totalRounds, totalQuantity } = stock;

    // 최대 회차 도달 체크
    if (currentRound >= totalRounds) {
      const reason = `최대 회차 도달 (${currentRound}/${totalRounds})`;
      console.log(`[InfiniteBuyScheduler] Strategy1 ${ticker}: ${reason}`);
      return { stockId, ticker, success: false, skipped: true, reason };
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
      const reason = `오늘 이미 매수함 (${todayBuyCount}회)`;
      console.log(`[InfiniteBuyScheduler] Strategy1 ${ticker}: ${reason} - 스킵`);
      return { stockId, ticker, success: false, skipped: true, reason };
    }

    console.log(`[InfiniteBuyScheduler] Strategy1 ${ticker}: LOC 매수 실행 중...`);

    let buyResult: any = null;
    let sellResult: any = null;

    // 1. 매수 주문 실행
    try {
      buyResult = await infiniteBuyStrategy1Service.executeBuy(userId, stockId);
      console.log(`[InfiniteBuyScheduler] Strategy1 ${ticker}: LOC 매수 주문 완료 - ${buyResult.orders.length}개 주문, 총 ${buyResult.totalQuantity}주`);
    } catch (error: any) {
      const reason = `LOC 매수 주문 실패 - ${error.message}`;
      console.error(`[InfiniteBuyScheduler] Strategy1 ${ticker}: ${reason}`);
      return { stockId, ticker, success: false, reason };
    }

    // 2. 매도 주문 실행 (보유 수량이 있을 때만)
    // 매수 주문 후 DB가 업데이트되었으므로 최신 종목 정보로 매도
    try {
      const updatedStock = await prisma.infiniteBuyStock.findUnique({
        where: { id: stockId },
      });

      if (updatedStock && updatedStock.totalQuantity > 0) {
        console.log(`[InfiniteBuyScheduler] Strategy1 ${ticker}: LOC 매도 실행 중... (보유: ${updatedStock.totalQuantity}주)`);
        sellResult = await infiniteBuyStrategy1Service.executeSell(userId, stockId);
        console.log(`[InfiniteBuyScheduler] Strategy1 ${ticker}: 매도 주문 완료 - ${sellResult.orders.length}개 주문, 총 ${sellResult.totalQuantity}주`);

        // 매도 주문 로그 저장
        await saveLog({
          type: 'strategy1_buy',
          status: 'completed',
          stockId,
          ticker,
          message: `Strategy1 ${ticker} 매도 주문 완료`,
          details: {
            orders: sellResult.orders.length,
            totalQuantity: sellResult.totalQuantity,
            orderDetails: sellResult.orders,
          },
        });
      } else {
        console.log(`[InfiniteBuyScheduler] Strategy1 ${ticker}: 보유 수량 없음 - 매도 주문 스킵`);
      }
    } catch (error: any) {
      console.error(`[InfiniteBuyScheduler] Strategy1 ${ticker}: 매도 주문 실패 - ${error.message}`);
      // 매도 실패해도 매수는 성공으로 처리
      await saveLog({
        type: 'strategy1_buy',
        status: 'error',
        stockId,
        ticker,
        message: `Strategy1 ${ticker} 매도 주문 실패`,
        errorMessage: error.message,
      });
    }

    return {
      stockId,
      ticker,
      success: true,
      orders: buyResult.orders.length,
      totalQuantity: buyResult.totalQuantity,
      sellOrders: sellResult?.orders?.length || 0,
    };
  }

  // 개별 종목 매수 처리 (결과 반환)
  private async processBuyForStock(stock: any): Promise<{
    stockId: number;
    ticker: string;
    success: boolean;
    skipped?: boolean;
    reason?: string;
    round?: number;
    quantity?: number;
    price?: number;
    orderId?: string;
  }> {
    const { id: stockId, userId, ticker, exchange, buyAmount, currentRound, totalRounds, avgPrice, buyCondition } = stock;

    // 최대 회차 도달 체크
    if (currentRound >= totalRounds) {
      const reason = `최대 회차 도달 (${currentRound}/${totalRounds})`;
      console.log(`[InfiniteBuyScheduler] ${ticker}: ${reason}`);
      return { stockId, ticker, success: false, skipped: true, reason };
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
      const reason = `오늘 이미 매수함 (${todayBuyCount}회)`;
      console.log(`[InfiniteBuyScheduler] ${ticker}: ${reason} - 스킵`);
      return { stockId, ticker, success: false, skipped: true, reason };
    }

    // KIS 서비스 가져오기
    const kisService = await this.getKisService(userId);
    if (!kisService) {
      const reason = 'KIS 서비스 없음';
      console.log(`[InfiniteBuyScheduler] ${ticker}: ${reason}`);
      return { stockId, ticker, success: false, skipped: true, reason };
    }

    // 현재가 조회
    let priceData;
    try {
      priceData = await kisService.getUSStockPrice(ticker, exchange);
    } catch (error: any) {
      const reason = `가격 조회 실패 - ${error.message}`;
      console.error(`[InfiniteBuyScheduler] ${ticker}: ${reason}`);
      return { stockId, ticker, success: false, reason };
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
      const reason = `매수 조건 미충족 - ${shouldBuy.reason}`;
      console.log(`[InfiniteBuyScheduler] ${ticker}: ${reason}`);
      return { stockId, ticker, success: false, skipped: true, reason };
    }

    console.log(`[InfiniteBuyScheduler] ${ticker}: 매수 실행 (${currentRound + 1}회차, ${currentPrice})`);

    // 매수 수량 계산 (미국 주식은 정수만 가능)
    const quantity = Math.floor(buyAmount / currentPrice);
    if (quantity < 1) {
      const reason = `매수 금액(${buyAmount})으로 1주도 살 수 없음 (현재가 ${currentPrice})`;
      console.log(`[InfiniteBuyScheduler] ${ticker}: ${reason}`);
      return { stockId, ticker, success: false, skipped: true, reason };
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
      const reason = `주문 실패 - ${error.message}`;
      console.error(`[InfiniteBuyScheduler] ${ticker}: ${reason}`);
      return { stockId, ticker, success: false, reason };
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
          // 모든 주문은 pending으로 저장, 체결 확인 스케줄러에서 실제 체결 여부 확인
          orderStatus: 'pending',
        },
      }),
    ]);

    console.log(`[InfiniteBuyScheduler] ${ticker}: 주문 완료 - 회차: ${nextRound}, ${quantity}주, $${currentPrice}, 체결 확인 대기중`);

    return {
      stockId,
      ticker,
      success: true,
      round: nextRound,
      quantity,
      price: currentPrice,
      orderId: orderId || undefined,
    };
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
  // strategyFilter: 'basic' = 기본전략만, 'strategy1' = LOC주문만, undefined = 전체
  private async checkPendingOrders(strategyFilter?: 'basic' | 'strategy1') {
    try {
      // pending 상태인 주문 조회
      const whereClause: any = {
        orderStatus: 'pending',
        orderId: { not: null },
      };

      // 전략 필터링
      if (strategyFilter) {
        whereClause.stock = {
          strategy: strategyFilter,
        };
      }

      const pendingRecords = await prisma.infiniteBuyRecord.findMany({
        where: whereClause,
        include: {
          stock: true,
        },
      });

      const strategyLabel = strategyFilter === 'strategy1' ? 'LOC' : strategyFilter === 'basic' ? '기본전략' : '전체';

      if (pendingRecords.length === 0) {
        console.log(`[InfiniteBuyScheduler] ${strategyLabel} 체결 대기 주문 없음`);
        return;
      }

      console.log(`[InfiniteBuyScheduler] ${strategyLabel} 체결 대기 주문 확인: ${pendingRecords.length}건`);

      await saveLog({
        type: 'order_check',
        status: 'started',
        message: `체결 대기 주문 확인 시작: ${pendingRecords.length}건`,
        details: {
          pendingCount: pendingRecords.length,
          tickers: pendingRecords.map(r => r.stock.ticker).filter((v, i, a) => a.indexOf(v) === i),
        },
      });

      // 유저별로 그룹화
      const userRecordMap = new Map<number, typeof pendingRecords>();
      for (const record of pendingRecords) {
        const userId = record.stock.userId;
        const userRecords = userRecordMap.get(userId) || [];
        userRecords.push(record);
        userRecordMap.set(userId, userRecords);
      }

      let filledCount = 0;
      let errorCount = 0;

      // 유저별로 KIS API 호출하여 체결 확인
      for (const [userId, records] of userRecordMap) {
        const kisService = await this.getKisService(userId);
        if (!kisService) {
          await saveLog({
            type: 'order_check',
            status: 'error',
            message: `KIS 서비스 초기화 실패 (userId: ${userId})`,
          });
          continue;
        }

        try {
          // pending 주문들의 executedAt 날짜 수집 (주문 생성일 기준으로 KIS 조회)
          const orderDates = records.map(r => r.executedAt);
          console.log(`[InfiniteBuyScheduler] 주문 생성일 목록:`, orderDates.map(d => d.toISOString().slice(0, 10)));

          // KIS API에서 체결 내역 조회 (해당 날짜들만)
          const kisFilledOrders = await kisService.getUSStockOrders(orderDates);
          console.log(`[InfiniteBuyScheduler] KIS 체결 내역: ${kisFilledOrders.length}건 조회됨`);

          // KIS API에서 미체결 내역 조회
          let kisPendingOrders: any[] = [];
          try {
            kisPendingOrders = await kisService.getUSStockPendingOrders();
            console.log(`[InfiniteBuyScheduler] KIS 미체결 내역: ${kisPendingOrders.length}건 조회됨`);
          } catch (pendingError: any) {
            console.warn(`[InfiniteBuyScheduler] 미체결 내역 조회 실패:`, pendingError.message);
          }

          // 디버깅: 매칭할 주문번호 목록
          console.log(`[InfiniteBuyScheduler] 매칭 대상 주문번호:`, records.map(r => r.orderId));

          // orderId로 매칭하여 체결 확인
          for (const record of records) {
            const filledOrder = kisFilledOrders.find((o: any) => o.orderId === record.orderId);
            const pendingOrder = kisPendingOrders.find((o: any) => o.orderId === record.orderId);

            if (filledOrder && filledOrder.filledQty > 0) {
              // 체결됨 - DB 업데이트
              const filledPrice = filledOrder.filledPrice || record.price;
              const filledQty = filledOrder.filledQty;
              const filledAmount = filledPrice * filledQty;

              // 기존 record의 주문 시점 값
              const oldAmount = record.amount;
              const oldQuantity = record.quantity;

              // stock의 totalInvested, totalQuantity, avgPrice 재계산
              // 주문 시점 값을 빼고 실제 체결 값을 더함
              const newTotalInvested = record.stock.totalInvested - oldAmount + filledAmount;
              const newTotalQuantity = record.stock.totalQuantity - oldQuantity + filledQty;
              const newAvgPrice = newTotalQuantity > 0 ? newTotalInvested / newTotalQuantity : 0;

              // Record와 Stock 동시 업데이트
              await prisma.$transaction([
                prisma.infiniteBuyRecord.update({
                  where: { id: record.id },
                  data: {
                    orderStatus: 'filled',
                    price: filledPrice,
                    quantity: filledQty,
                    amount: filledAmount,
                    filledAt: new Date(),
                  },
                }),
                prisma.infiniteBuyStock.update({
                  where: { id: record.stockId },
                  data: {
                    totalInvested: newTotalInvested,
                    totalQuantity: newTotalQuantity,
                    avgPrice: newAvgPrice,
                  },
                }),
              ]);

              // 메모리 상의 record.stock도 업데이트 (같은 stock의 다른 record 처리 시 사용)
              record.stock.totalInvested = newTotalInvested;
              record.stock.totalQuantity = newTotalQuantity;
              record.stock.avgPrice = newAvgPrice;

              filledCount++;
              console.log(`[InfiniteBuyScheduler] ${record.stock.ticker}: 체결 확인 완료 (주문번호: ${record.orderId}, ${filledQty}주, $${filledPrice}, 새 평단: $${newAvgPrice.toFixed(2)})`);

              await saveLog({
                type: 'order_check',
                status: 'completed',
                message: `${record.stock.ticker}: 체결 확인 완료 - 평균단가 재계산`,
                stockId: record.stockId,
                ticker: record.stock.ticker,
                details: {
                  orderId: record.orderId,
                  filledQty,
                  filledPrice,
                  oldAmount,
                  newAmount: filledAmount,
                  newAvgPrice,
                  newTotalInvested,
                },
              });
            } else if (pendingOrder) {
              // 미체결 상태 - 아직 대기중
              console.log(`[InfiniteBuyScheduler] ${record.stock.ticker}: 미체결 대기중 (주문번호: ${record.orderId})`);

              await saveLog({
                type: 'order_check',
                status: 'skipped',
                message: `${record.stock.ticker}: 미체결 대기중`,
                stockId: record.stockId,
                ticker: record.stock.ticker,
                details: {
                  orderId: record.orderId,
                  remainQty: pendingOrder.remainQty,
                  orderPrice: pendingOrder.orderPrice,
                },
              });
            } else {
              // 체결/미체결 내역 둘 다 없음 - 만료/취소된 것으로 판단
              const orderDate = new Date(record.executedAt);
              const now = new Date();
              const daysDiff = Math.floor((now.getTime() - orderDate.getTime()) / (24 * 60 * 60 * 1000));
              const hoursDiff = Math.floor((now.getTime() - orderDate.getTime()) / (60 * 60 * 1000));

              // LOC 주문 (strategy1) 체결 확인은 장 마감 후(06:10, 03:10)에 실행됨
              // 이 시점에 체결 내역이 없으면 미체결로 즉시 처리 (Day Order/LOC는 장 마감 시 자동 소멸)
              // 기본 전략은 1일 이상 지난 주문만 만료 처리
              const isLOCSchedule = strategyFilter === 'strategy1';
              const isLOCOrder = record.orderType === 'loc';

              // strategy1 스케줄에서 호출되면 즉시 미체결 처리 (장 마감 후이므로)
              // 그 외 LOC 주문은 2시간 경과 후, 기본 전략은 1일 경과 후
              const shouldExpire = isLOCSchedule
                ? true  // 장 마감 후 체결 확인이므로 즉시 미체결 처리
                : (isLOCOrder ? hoursDiff >= 2 : daysDiff >= 1);

              if (shouldExpire) {
                // LOC 미체결 원인 분석: 종가 조회하여 주문가격과 비교
                let unfilledReason = '';
                let closingPrice: number | null = null;

                if (isLOCOrder || isLOCSchedule) {
                  try {
                    // 종가(전일 종가) 조회
                    const priceData = await kisService.getUSStockPrice(
                      record.stock.ticker,
                      record.stock.exchange
                    );
                    closingPrice = priceData.prevClose || priceData.currentPrice || null;

                    if (closingPrice !== null) {
                      const orderPrice = record.targetPrice || record.price;
                      const orderType = record.type; // 'buy' or 'sell'

                      if (orderType === 'buy') {
                        // LOC 매수: 지정가 >= 종가 → 체결 (종가 이하로 매수)
                        if (orderPrice < closingPrice) {
                          unfilledReason = `LOC 매수 미체결: 주문가($${orderPrice.toFixed(2)}) < 종가($${closingPrice.toFixed(2)}) - 종가가 주문가보다 높아 체결 불가`;
                        } else {
                          unfilledReason = `LOC 매수 미체결: 주문가($${orderPrice.toFixed(2)}), 종가($${closingPrice.toFixed(2)}) - 원인 불명 (시장 상황 확인 필요)`;
                        }
                      } else {
                        // LOC 매도: 지정가 <= 종가 → 체결 (종가 이상으로 매도)
                        if (orderPrice > closingPrice) {
                          unfilledReason = `LOC 매도 미체결: 주문가($${orderPrice.toFixed(2)}) > 종가($${closingPrice.toFixed(2)}) - 종가가 주문가보다 낮아 체결 불가`;
                        } else {
                          unfilledReason = `LOC 매도 미체결: 주문가($${orderPrice.toFixed(2)}), 종가($${closingPrice.toFixed(2)}) - 원인 불명 (시장 상황 확인 필요)`;
                        }
                      }
                    } else {
                      unfilledReason = 'LOC 미체결 (종가 데이터 없음)';
                    }
                  } catch (priceError: any) {
                    console.warn(`[InfiniteBuyScheduler] ${record.stock.ticker}: 종가 조회 실패 - ${priceError.message}`);
                    unfilledReason = 'LOC 미체결 (종가 조회 실패로 원인 분석 불가)';
                  }
                }

                // 'unfilled' 상태로 변경 (미체결)
                await prisma.infiniteBuyRecord.update({
                  where: { id: record.id },
                  data: { orderStatus: 'unfilled' },
                });

                const expireReason = unfilledReason || (isLOCSchedule
                  ? `LOC/Day Order 미체결 (장 마감 시 자동 소멸)`
                  : isLOCOrder
                    ? `LOC 주문 미체결 (${hoursDiff}시간 경과)`
                    : `주문 미체결 (${daysDiff}일 경과)`);

                console.log(`[InfiniteBuyScheduler] ${record.stock.ticker}: ${expireReason} (주문번호: ${record.orderId})`);

                await saveLog({
                  type: 'order_check',
                  status: 'completed',
                  message: `${record.stock.ticker}: ${expireReason}`,
                  stockId: record.stockId,
                  ticker: record.stock.ticker,
                  details: {
                    orderId: record.orderId,
                    daysSinceOrder: daysDiff,
                    hoursSinceOrder: hoursDiff,
                    orderType: record.orderType,
                    tradeType: record.type,
                    orderPrice: record.targetPrice || record.price,
                    closingPrice,
                    unfilledReason,
                    reason: isLOCSchedule
                      ? '장 마감 후 LOC/Day Order 미체결 - 자동 소멸'
                      : '체결/미체결 내역 없음 - 만료/취소된 주문',
                  },
                });
              } else {
                // 아직 대기
                await saveLog({
                  type: 'order_check',
                  status: 'skipped',
                  message: `${record.stock.ticker}: 체결 확인 대기 (${isLOCOrder ? hoursDiff + '시간' : daysDiff + '일'} 경과)`,
                  stockId: record.stockId,
                  ticker: record.stock.ticker,
                  details: {
                    orderId: record.orderId,
                    daysSinceOrder: daysDiff,
                    hoursSinceOrder: hoursDiff,
                  },
                });
              }
            }
          }
        } catch (error: any) {
          errorCount++;
          console.error(`[InfiniteBuyScheduler] 체결 확인 실패 (userId: ${userId}):`, error.message);

          await saveLog({
            type: 'order_check',
            status: 'error',
            message: `체결 확인 API 호출 실패 (userId: ${userId})`,
            errorMessage: error.message,
          });
        }

        // API 호출 간 딜레이
        await this.delay(500);
      }

      await saveLog({
        type: 'order_check',
        status: 'completed',
        message: `체결 확인 완료: 체결 ${filledCount}건, 에러 ${errorCount}건`,
        details: { filledCount, errorCount, pendingCount: pendingRecords.length },
      });
    } catch (error: any) {
      console.error('[InfiniteBuyScheduler] 체결 확인 오류:', error);
      await saveLog({
        type: 'order_check',
        status: 'error',
        message: '체결 확인 중 오류 발생',
        errorMessage: error.message,
      });
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

        // 토큰 상태 상세 정보
        let tokenStatus = '';
        let tokenExpireAtStr = '';
        let tokenRemainingMinutes = 0;
        if (!credential) {
          tokenStatus = 'KIS 자격증명 없음';
        } else if (!credential.accessToken) {
          tokenStatus = '토큰 미발급';
        } else if (!credential.tokenExpireAt) {
          tokenStatus = '만료시간 없음';
        } else {
          const timeUntilExpiry = credential.tokenExpireAt.getTime() - now.getTime();
          tokenRemainingMinutes = Math.round(timeUntilExpiry / 60000);
          tokenExpireAtStr = credential.tokenExpireAt.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
          if (timeUntilExpiry <= 0) {
            tokenStatus = '만료됨';
          } else if (timeUntilExpiry < 10 * 60 * 1000) {
            tokenStatus = `곧 만료 (${tokenRemainingMinutes}분 남음)`;
          } else {
            const hours = Math.floor(tokenRemainingMinutes / 60);
            const mins = tokenRemainingMinutes % 60;
            tokenStatus = `유효 (${hours}시간 ${mins}분 남음)`;
          }
        }

        // 토큰 발급 쿨다운 상태
        const lastIssue = this.lastTokenIssueTime.get(stock.userId);
        let tokenCooldownStatus = '';
        let canIssueNewToken = true;
        if (lastIssue) {
          const timeSinceLastIssue = now.getTime() - lastIssue.getTime();
          const cooldownRemaining = this.TOKEN_ISSUE_COOLDOWN - timeSinceLastIssue;
          if (cooldownRemaining > 0) {
            canIssueNewToken = false;
            const cooldownMinutes = Math.ceil(cooldownRemaining / 60000);
            tokenCooldownStatus = `쿨다운 중 (${cooldownMinutes}분 후 재발급 가능)`;
          } else {
            tokenCooldownStatus = '재발급 가능';
          }
        } else {
          tokenCooldownStatus = '재발급 가능 (발급 기록 없음)';
        }

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
          tokenInfo: {
            status: tokenStatus,
            expireAt: tokenExpireAtStr,
            remainingMinutes: tokenRemainingMinutes,
            cooldownStatus: tokenCooldownStatus,
            canIssueNewToken,
          },
          canBuy,
          skipReason: !canBuy
            ? maxRoundsReached
              ? '최대 회차 도달'
              : todayBuyCount > 0
                ? '오늘 이미 매수함'
                : !hasKisCredential
                  ? 'KIS 자격증명 없음'
                  : !hasValidToken
                    ? '토큰 만료/미발급'
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

        // 토큰 상태 상세 정보
        let tokenStatus = '';
        let tokenExpireAtStr = '';
        let tokenRemainingMinutes = 0;
        if (!credential) {
          tokenStatus = 'KIS 자격증명 없음';
        } else if (!credential.accessToken) {
          tokenStatus = '토큰 미발급';
        } else if (!credential.tokenExpireAt) {
          tokenStatus = '만료시간 없음';
        } else {
          const timeUntilExpiry = credential.tokenExpireAt.getTime() - now.getTime();
          tokenRemainingMinutes = Math.round(timeUntilExpiry / 60000);
          tokenExpireAtStr = credential.tokenExpireAt.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
          if (timeUntilExpiry <= 0) {
            tokenStatus = '만료됨';
          } else if (timeUntilExpiry < 10 * 60 * 1000) {
            tokenStatus = `곧 만료 (${tokenRemainingMinutes}분 남음)`;
          } else {
            const hours = Math.floor(tokenRemainingMinutes / 60);
            const mins = tokenRemainingMinutes % 60;
            tokenStatus = `유효 (${hours}시간 ${mins}분 남음)`;
          }
        }

        // 토큰 발급 쿨다운 상태
        const lastIssue = this.lastTokenIssueTime.get(stock.userId);
        let tokenCooldownStatus = '';
        let canIssueNewToken = true;
        if (lastIssue) {
          const timeSinceLastIssue = now.getTime() - lastIssue.getTime();
          const cooldownRemaining = this.TOKEN_ISSUE_COOLDOWN - timeSinceLastIssue;
          if (cooldownRemaining > 0) {
            canIssueNewToken = false;
            const cooldownMinutes = Math.ceil(cooldownRemaining / 60000);
            tokenCooldownStatus = `쿨다운 중 (${cooldownMinutes}분 후 재발급 가능)`;
          } else {
            tokenCooldownStatus = '재발급 가능';
          }
        } else {
          tokenCooldownStatus = '재발급 가능 (발급 기록 없음)';
        }

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
          tokenInfo: {
            status: tokenStatus,
            expireAt: tokenExpireAtStr,
            remainingMinutes: tokenRemainingMinutes,
            cooldownStatus: tokenCooldownStatus,
            canIssueNewToken,
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
                    : !hasValidToken
                      ? '토큰 만료/미발급'
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
      tokenCooldownHours: this.TOKEN_ISSUE_COOLDOWN / (60 * 60 * 1000),
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

  // 로그 조회
  async getLogs(params?: {
    type?: SchedulerLogType;
    status?: SchedulerLogStatus;
    stockId?: number;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  }) {
    const where: any = {};

    if (params?.type) {
      where.type = params.type;
    }
    if (params?.status) {
      where.status = params.status;
    }
    if (params?.stockId) {
      where.stockId = params.stockId;
    }
    if (params?.startDate || params?.endDate) {
      where.executedAt = {};
      if (params?.startDate) {
        where.executedAt.gte = params.startDate;
      }
      if (params?.endDate) {
        where.executedAt.lte = params.endDate;
      }
    }

    const [logs, total] = await Promise.all([
      prisma.schedulerLog.findMany({
        where,
        orderBy: { executedAt: 'desc' },
        take: params?.limit || 100,
        skip: params?.offset || 0,
      }),
      prisma.schedulerLog.count({ where }),
    ]);

    // details 필드 파싱
    const parsedLogs = logs.map((log) => ({
      ...log,
      details: log.details ? JSON.parse(log.details) : null,
    }));

    return {
      logs: parsedLogs,
      total,
      limit: params?.limit || 100,
      offset: params?.offset || 0,
    };
  }

  // 오래된 로그 정리 (30일 이상)
  async cleanupOldLogs(daysToKeep: number = 30) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const result = await prisma.schedulerLog.deleteMany({
      where: {
        executedAt: {
          lt: cutoffDate,
        },
      },
    });

    console.log(`[InfiniteBuyScheduler] ${result.count}개의 오래된 로그 삭제됨`);
    return result.count;
  }
}

export const infiniteBuyScheduler = new InfiniteBuySchedulerService();
