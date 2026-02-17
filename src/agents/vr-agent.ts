import cron, { ScheduledTask } from 'node-cron';
import { BaseAgent } from './base-agent';
import prisma from '../config/database';
import { SchedulerLogType, SchedulerLogStatus } from '@prisma/client';
import { infiniteBuyVRService } from '../services/infinite-buy-vr.service';
import { isUSMarketOpen } from '../utils/us-market-holidays';
import { PushService } from '../services/push.service';

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
    console.error('[VRAgent] 로그 저장 실패:', error);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class VRAgent extends BaseAgent {
  private vrCycleCheckJob: ScheduledTask | null = null;
  private vrOrderCheckJob: ScheduledTask | null = null;
  private cycleCheckCount = 0;
  private orderCheckCount = 0;
  private lastCycleCheckAt: Date | null = null;
  private lastOrderCheckAt: Date | null = null;

  constructor() {
    super({
      id: 'vr',
      name: 'VRAgent',
      description: 'VR(Value Rebalancing) 전략 스케줄러 - 사이클 체크 및 체결 확인',
      cycleIntervalMs: 0,
    });
  }

  protected async onStart(): Promise<void> {
    // VR 사이클 체크 (매일 장 시작 전 22:00 KST)
    // 사이클 주기가 도래한 종목의 V값을 갱신하고 새 주문 생성
    this.vrCycleCheckJob = cron.schedule('0 22 * * 1-5', async () => {
      console.log('[VRAgent] VR 사이클 체크 실행');
      await this.executeVRCycleCheck();
    }, {
      timezone: 'Asia/Seoul'
    });

    // VR 주문 체결 확인 (장중 매 30분, 체결 시 Pool 반영)
    this.vrOrderCheckJob = cron.schedule('*/30 22,23,0,1,2,3,4,5 * * 1-6', async () => {
      await this.checkVRPendingOrders();
    }, {
      timezone: 'Asia/Seoul'
    });

    console.log('[VRAgent] 스케줄 등록 완료');
    console.log('  - VR 사이클 체크: 매일 22:00 (KST) - 장 시작 전');
    console.log('  - VR 체결 확인: 장중 매 30분');
  }

  protected async onStop(): Promise<void> {
    if (this.vrCycleCheckJob) {
      this.vrCycleCheckJob.stop();
      this.vrCycleCheckJob = null;
    }
    if (this.vrOrderCheckJob) {
      this.vrOrderCheckJob.stop();
      this.vrOrderCheckJob = null;
    }
  }

  protected async onCycle(): Promise<void> {
    // 내부 cron 사용 - 별도 사이클 불필요
  }

  protected getExtraInfo(): Record<string, any> {
    return {
      lastCycleCheckAt: this.lastCycleCheckAt,
      lastOrderCheckAt: this.lastOrderCheckAt,
      cycleCheckCount: this.cycleCheckCount,
      orderCheckCount: this.orderCheckCount,
      schedules: {
        vrCycleCheck: '0 22 * * 1-5 (KST)',
        vrOrderCheck: '*/30 22,23,0,1,2,3,4,5 * * 1-6 (KST)',
      },
    };
  }

  // ==================== VR 전략 핵심 메서드 ====================

  /**
   * VR 사이클 체크 및 실행
   * - 사이클 주기가 도래한 VR 종목을 찾아서 V값 갱신 + 새 주문 생성
   */
  private async executeVRCycleCheck() {
    // 오늘이 거래일인지 확인
    const today = new Date();
    if (!isUSMarketOpen(today)) {
      console.log('[VRAgent] 오늘은 미국 장 휴일입니다');
      await saveLog({
        type: 'vr_cycle',
        status: 'skipped',
        message: '오늘은 미국 장 휴일 - VR 사이클 체크 스킵',
      });
      return;
    }

    await saveLog({
      type: 'vr_cycle',
      status: 'started',
      message: 'VR 사이클 체크 시작',
    });

    try {
      // autoEnabled가 true인 VR 전략 종목 조회
      const vrStocks = await prisma.infiniteBuyStock.findMany({
        where: {
          strategy: 'vr',
          status: 'buying',
          autoEnabled: true,
          vrValue: { not: null },
          vrPool: { not: null },
        },
      });

      console.log(`[VRAgent] VR 자동 실행 대상: ${vrStocks.length}개 종목`);

      let cycleExecuted = 0;
      let orderGenerated = 0;
      let skipped = 0;
      let errors = 0;

      for (const stock of vrStocks) {
        try {
          // 사이클 주기 체크
          const shouldExecuteCycle = this.shouldExecuteVRCycle(stock);

          if (shouldExecuteCycle) {
            // 사이클 실행 (V 갱신 + 주문 생성)
            console.log(`[VRAgent] VR ${stock.ticker}: 사이클 실행`);
            const result = await infiniteBuyVRService.executeCycle(stock.userId, stock.id);
            cycleExecuted++;
            orderGenerated += result.ordersCreated;

            await saveLog({
              type: 'vr_cycle',
              status: 'completed',
              stockId: stock.id,
              ticker: stock.ticker,
              message: `VR ${stock.ticker}: 사이클 실행 완료`,
              details: {
                oldV: result.oldV,
                newV: result.newV,
                oldPool: result.oldPool,
                newPool: result.newPool,
                ordersCreated: result.ordersCreated,
              },
            });
          } else {
            // 사이클 미도래 - 기존 주문 갱신만 (미체결 주문이 없으면 새로 생성)
            const pendingOrders = await prisma.infiniteBuyRecord.count({
              where: {
                stockId: stock.id,
                orderStatus: 'pending',
                vrOrderIndex: { not: null },
              },
            });

            if (pendingOrders === 0) {
              // 미체결 주문이 없으면 새 주문 생성
              console.log(`[VRAgent] VR ${stock.ticker}: 주문 생성 (미체결 없음)`);
              const result = await infiniteBuyVRService.generateOrders(stock.userId, stock.id);
              orderGenerated += result.totalOrders;
            } else {
              console.log(`[VRAgent] VR ${stock.ticker}: 스킵 (사이클 미도래, 미체결 ${pendingOrders}건)`);
              skipped++;
            }
          }
        } catch (error: any) {
          errors++;
          console.error(`[VRAgent] VR ${stock.ticker} 처리 실패:`, error.message);

          await saveLog({
            type: 'vr_cycle',
            status: 'error',
            stockId: stock.id,
            ticker: stock.ticker,
            message: `VR ${stock.ticker} 처리 실패`,
            errorMessage: error.message,
          });

          // 푸시 알림
          try {
            await PushService.sendToUser(stock.userId, {
              title: `❌ ${stock.ticker} VR 자동 실행 실패`,
              body: error.message,
              icon: '/icon-192x192.svg',
              tag: `vr-error-${stock.ticker}`,
              data: { type: 'vr_error', ticker: stock.ticker },
            });
          } catch (pushError) {
            console.error('[VRAgent] 푸시 알림 전송 실패:', pushError);
          }
        }

        // API 호출 간 딜레이
        await delay(2000);
      }

      await saveLog({
        type: 'vr_cycle',
        status: 'completed',
        message: `VR 사이클 체크 완료: 사이클 ${cycleExecuted}건, 주문 ${orderGenerated}건, 스킵 ${skipped}건, 에러 ${errors}건`,
        details: { cycleExecuted, orderGenerated, skipped, errors, totalTargets: vrStocks.length },
      });
    } catch (error: any) {
      console.error('[VRAgent] VR 사이클 체크 오류:', error);
      await saveLog({
        type: 'vr_cycle',
        status: 'error',
        message: 'VR 사이클 체크 중 오류 발생',
        errorMessage: error.message,
      });
    }

    this.cycleCheckCount++;
    this.lastCycleCheckAt = new Date();
  }

  /**
   * VR 사이클 실행 여부 판단
   */
  private shouldExecuteVRCycle(stock: any): boolean {
    if (!stock.vrCycleStartDate) {
      return true; // 시작일이 없으면 첫 사이클
    }

    const cycleWeeks = stock.vrCycleWeeks || 2;
    const cycleDays = cycleWeeks * 7;
    const daysSinceCycleStart = Math.floor(
      (Date.now() - stock.vrCycleStartDate.getTime()) / (1000 * 60 * 60 * 24)
    );

    return daysSinceCycleStart >= cycleDays;
  }

  /**
   * VR 미체결 주문 확인 및 체결 처리
   */
  private async checkVRPendingOrders() {
    try {
      // VR 전략의 미체결 주문 조회
      const pendingRecords = await prisma.infiniteBuyRecord.findMany({
        where: {
          orderStatus: 'pending',
          vrOrderIndex: { not: null },
          orderId: { not: null },
        },
        include: {
          stock: true,
        },
      });

      if (pendingRecords.length === 0) {
        return;
      }

      console.log(`[VRAgent] VR 체결 확인: ${pendingRecords.length}건`);

      // 유저별로 그룹화
      const userRecordMap = new Map<number, typeof pendingRecords>();
      for (const record of pendingRecords) {
        const userId = record.stock.userId;
        const userRecords = userRecordMap.get(userId) || [];
        userRecords.push(record);
        userRecordMap.set(userId, userRecords);
      }

      let filledCount = 0;

      for (const [userId, records] of userRecordMap) {
        try {
          // VR 서비스의 syncFilledOrders 사용 (각 종목별로)
          const stockIds = [...new Set(records.map(r => r.stockId))];

          for (const stockId of stockIds) {
            try {
              const result = await infiniteBuyVRService.syncFilledOrders(userId, stockId);
              filledCount += result.synced;

              if (result.synced > 0) {
                const stock = records.find(r => r.stockId === stockId)?.stock;
                console.log(`[VRAgent] VR ${stock?.ticker}: ${result.synced}건 체결`);
              }
            } catch (syncError: any) {
              console.error(`[VRAgent] VR 체결 동기화 실패 (stockId: ${stockId}):`, syncError.message);
            }
          }
        } catch (error: any) {
          console.error(`[VRAgent] VR 체결 확인 실패 (userId: ${userId}):`, error.message);
        }

        await delay(1000);
      }

      if (filledCount > 0) {
        await saveLog({
          type: 'vr_order',
          status: 'completed',
          message: `VR 체결 확인 완료: ${filledCount}건 체결`,
          details: { filledCount, pendingChecked: pendingRecords.length },
        });
      }
    } catch (error: any) {
      console.error('[VRAgent] VR 체결 확인 오류:', error);
    }

    this.orderCheckCount++;
    this.lastOrderCheckAt = new Date();
  }
}
