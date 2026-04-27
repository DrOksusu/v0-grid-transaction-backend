import { BaseAgent } from './base-agent';
import {
  subscribeStablecoinOrderbooks,
  unsubscribeStablecoinOrderbooks,
  getAllStablecoinOrderbooks,
  onStablecoinOrderbookUpdate,
} from '../services/upbit-price-manager';
import { findBestOpportunity, type ArbOpportunity } from '../services/stablecoin-arb-detector';
import * as arbService from '../services/stablecoin-arb.service';
import { stablecoinPrisma as prisma } from '../config/database';
import mainPrisma from '../config/database';
import type { OrderbookTop } from '../services/upbit-price-manager';
import { decrypt } from '../utils/encryption';
import { UpbitService } from '../services/upbit.service';
import { tradingLock } from '../services/stablecoin-trading-lock';
import { runAll as preCheckAll } from '../services/stablecoin-pre-check';
import { executeArbitrage, type ExecutorResult } from '../services/stablecoin-arb-executor';
import { BalanceCache } from '../services/upbit-balance-cache';
import {
  shouldTriggerKillSwitch,
  recordLeg2Failure,
  recordLeg2Success,
} from '../services/stablecoin-auto-killswitch';
import { socketService } from '../services/socket.service';
import { ArbTradeStatus } from '.prisma/client-stablecoin';

/**
 * 스테이블코인 아비트리지 에이전트.
 *
 * 호가 update마다 활성 봇별 기회 감지:
 *  - bot.live=false → DB에 detection만 기록 (M2 호환)
 *  - bot.live=true  → preCheck → executor → Trade 기록 (M3 실거래)
 */
export class StablecoinArbAgent extends BaseAgent {
  private unsubscribe: (() => void) | null = null;
  private evaluateInFlight = false;
  // userId별 Upbit 클라이언트 + balance 캐시 (lazy init)
  private clients = new Map<number, { upbit: UpbitService; cache: BalanceCache }>();

  constructor() {
    super({
      id: 'stablecoin-arb',
      name: 'StablecoinArbAgent',
      description: 'Upbit 스테이블코인 간 아비트리지 봇 (M2 detection / M3 live)',
      cycleIntervalMs: 0,
    });
  }

  protected async onStart(): Promise<void> {
    subscribeStablecoinOrderbooks();
    this.unsubscribe = onStablecoinOrderbookUpdate(() => {
      this.evaluate().catch((err: Error) => {
        console.error('[StablecoinArbAgent] evaluate unhandled:', err.message);
      });
    });
    console.log('[StablecoinArbAgent] 시작 (live 분기 가능)');
  }

  protected async onStop(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    unsubscribeStablecoinOrderbooks();
    this.clients.clear();
    console.log('[StablecoinArbAgent] 정지');
  }

  protected async onCycle(): Promise<void> {
    // 이벤트 드리븐
  }

  private async evaluate(): Promise<void> {
    if (this.evaluateInFlight) return;
    this.evaluateInFlight = true;

    try {
      const bots = await prisma.stablecoinArbBot.findMany({
        where: { enabled: true, killSwitch: false },
      });
      if (bots.length === 0) return;

      const books = getAllStablecoinOrderbooks();

      for (const bot of bots) {
        const coinsEnabled = (bot.coinsEnabled as string[]) || [];
        if (coinsEnabled.length < 2) continue;

        const opp = findBestOpportunity(books, coinsEnabled, bot.entryThresholdBps);
        if (!opp) continue;

        // M2: detection-only — 기존 흐름 유지
        if (!bot.live) {
          await this.logSkip(bot.id, opp, 'detection_only_mode');
          continue;
        }

        // M3: live 거래 — tradingLock 보호
        const lockHolder = `arb-bot-${bot.id}`;
        if (!tradingLock.tryAcquire(lockHolder)) {
          // 다른 거래 진행 중 → 이번 update skip
          continue;
        }

        try {
          await this.processLiveBot(bot, opp, books);
        } finally {
          tradingLock.release(lockHolder);
        }
      }
    } catch (err: any) {
      this.metrics.errors++;
      this.metrics.lastError = err.message;
      console.error('[StablecoinArbAgent] evaluate error:', err.message);
    } finally {
      this.evaluateInFlight = false;
    }
  }

  /** live=true 봇 처리: preCheck → executor → Trade 기록 */
  private async processLiveBot(
    bot: Awaited<ReturnType<typeof prisma.stablecoinArbBot.findMany>>[number],
    opp: ArbOpportunity,
    books: ReadonlyMap<string, OrderbookTop>,
  ): Promise<void> {
    let client;
    try {
      client = await this.getClientFor(bot.userId);
    } catch (err: any) {
      console.error(`[StablecoinArbAgent] bot ${bot.id} credential 로드 실패:`, err.message);
      await this.logSkip(bot.id, opp, 'credential_missing');
      return;
    }

    const balance = await client.cache.get();
    const todayStats = await arbService.getTodayStats(bot.id);

    const qtyByDepth = Math.min(opp.bidSoldSize, opp.askBoughtSize);
    const qtyByBudget = bot.tradeSizeKrw / opp.askBoughtKrw;
    const qtyByBalance = balance[opp.soldCoin] ?? 0;
    const qty = Math.min(qtyByDepth, qtyByBudget, qtyByBalance);

    const pre = preCheckAll(
      {
        id: bot.id,
        killSwitch: bot.killSwitch,
        maxDailyTrades: bot.maxDailyTrades,
        dailyLossLimitKrw: bot.dailyLossLimitKrw,
        depegBps: bot.depegBps,
      },
      opp,
      books,
      balance,
      todayStats,
      qty,
    );

    if (!pre.ok) {
      await this.logSkip(bot.id, opp, pre.reason);
      return;
    }

    const result = await executeArbitrage(opp, bot, balance, books, client.upbit);

    // 거래 직후 잔고 캐시 invalidate (다음 evaluate에서 fresh)
    client.cache.invalidate();

    await this.recordTrade(bot.id, opp, result);

    // PR C: leg-2 결과 기록 (auto kill switch 카운터)
    if (result.ok) {
      recordLeg2Success(bot.id);
    } else if (result.rolledBack) {
      // ROLLED_BACK = leg-1 성공 + leg-2 zero → leg-2 실패
      recordLeg2Failure(bot.id);
    }
    // result.ok === false && !rolledBack은 leg-1 실패 → leg-2 카운터 영향 없음

    // PR C: auto kill switch 검사
    // dailyLossLimitKrw 유효성 검증 (boundary safety — Task 4 reviewer 권장)
    if (bot.dailyLossLimitKrw > 0) {
      const todayStats = await arbService.getTodayStats(bot.id);
      const trigger = shouldTriggerKillSwitch({
        botId: bot.id,
        todayNetProfitKrw: todayStats.todayNetProfitKrw,
        dailyLossLimitKrw: bot.dailyLossLimitKrw,
      });

      if (trigger.trigger) {
        console.error(
          `[StablecoinArbAgent] AUTO KILL SWITCH triggered for bot ${bot.id}: ${trigger.reason} — ${trigger.detail}`,
        );
        await arbService.setKillSwitch(bot.userId, true);
        // Socket.IO emit (best-effort)
        try {
          const io = socketService.getIO();
          if (io) {
            io.emit('stablecoin:killswitch_triggered', {
              botId: bot.id,
              userId: bot.userId,
              reason: trigger.reason,
              detail: trigger.detail,
              triggeredAt: new Date().toISOString(),
            });
          }
        } catch (e) {
          console.warn('[StablecoinArbAgent] socket emit failed:', (e as Error).message);
        }
      }
    }

    if (result.ok) {
      await prisma.stablecoinArbBot.update({
        where: { id: bot.id },
        data: {
          totalTrades: { increment: 1 },
          lastExecutedAt: new Date(),
          // totalProfitUsd 환율 변환은 별도 PR에서
        },
      });
    }
  }

  /** userId별 Upbit 클라이언트 + balance 캐시 lazy init */
  private async getClientFor(userId: number): Promise<{ upbit: UpbitService; cache: BalanceCache }> {
    const existing = this.clients.get(userId);
    if (existing) return existing;

    const credential = await mainPrisma.credential.findFirst({
      where: { userId, exchange: 'upbit' },
    });
    if (!credential) {
      throw new Error(`Upbit credential not found for userId=${userId}`);
    }
    const accessKey = decrypt(credential.apiKey);
    const secretKey = decrypt(credential.secretKey);
    const upbit = new UpbitService({ accessKey, secretKey });
    const cache = new BalanceCache({
      ttlMs: 5000,
      fetcher: () => upbit.getAccounts(),
    });

    const client = { upbit, cache };
    this.clients.set(userId, client);
    return client;
  }

  /** detection-only 또는 preCheck abort를 Opportunity row로 기록 */
  private async logSkip(
    botId: number,
    opp: ArbOpportunity,
    skipReason: string,
  ): Promise<void> {
    try {
      await arbService.logOpportunity({
        botId,
        detectedAt: new Date(opp.detectedAt),
        soldCoin: opp.soldCoin,
        boughtCoin: opp.boughtCoin,
        bidSoldKrw: opp.bidSoldKrw,
        askBoughtKrw: opp.askBoughtKrw,
        spreadBps: opp.spreadBps,
        executed: false,
        skipReason,
      });
    } catch (err: any) {
      console.error(`[StablecoinArbAgent] bot ${botId} logOpportunity 실패:`, err.message);
    }
  }

  /** ExecutorResult를 StablecoinArbTrade row로 기록 */
  private async recordTrade(
    botId: number,
    opp: ArbOpportunity,
    result: ExecutorResult,
  ): Promise<void> {
    const baseData = {
      botId,
      soldCoin: opp.soldCoin,
      boughtCoin: opp.boughtCoin,
      detectedAt: new Date(opp.detectedAt),
      bidSoldKrw: opp.bidSoldKrw,
      askBoughtKrw: opp.askBoughtKrw,
      expectedSpreadBps: opp.spreadBps,
      plannedSizeCoin: 0, // qty 추적은 추후
    };

    try {
      if (result.ok) {
        await prisma.stablecoinArbTrade.create({
          data: {
            ...baseData,
            status: ArbTradeStatus.COMPLETED,
            leg1OrderUuid: result.legA.uuid,
            leg1FilledVol: result.legA.filledVol,
            leg1ReceivedKrw: result.legA.filledKrw,
            leg1FeeKrw: result.legA.feeKrw,
            leg1CompletedAt: new Date(),
            leg2OrderUuid: result.legB.uuid,
            leg2FilledVol: result.legB.filledVol,
            leg2SpentKrw: result.legB.filledKrw,
            leg2FeeKrw: result.legB.feeKrw,
            leg2CompletedAt: new Date(),
            realizedSpreadBps: result.realizedSpreadBps,
            krwFlowNetKrw: result.krwFlowNet,
            totalFeeKrw: result.totalFeeKrw,
            completedAt: new Date(),
          },
        });
      } else if (result.rolledBack) {
        await prisma.stablecoinArbTrade.create({
          data: {
            ...baseData,
            status: ArbTradeStatus.FALLBACK_DONE,
            leg1OrderUuid: result.legA?.uuid ?? null,
            leg1FilledVol: result.legA?.filledVol ?? null,
            leg1ReceivedKrw: result.legA?.filledKrw ?? null,
            leg1FeeKrw: result.legA?.feeKrw ?? null,
            leg2OrderUuid: result.legB?.uuid ?? null,
            leg2FilledVol: result.legB?.filledVol ?? null,
            error: result.reason,
            completedAt: new Date(),
          },
        });
      } else {
        await prisma.stablecoinArbTrade.create({
          data: {
            ...baseData,
            status: ArbTradeStatus.FAILED,
            leg1OrderUuid: result.legA?.uuid ?? null,
            leg1FilledVol: result.legA?.filledVol ?? null,
            error: result.reason,
            completedAt: new Date(),
          },
        });
      }
    } catch (err: any) {
      console.error(`[StablecoinArbAgent] bot ${botId} recordTrade 실패:`, err.message);
    }
  }
}
