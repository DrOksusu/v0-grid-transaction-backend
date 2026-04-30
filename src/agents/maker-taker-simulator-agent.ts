import { BaseAgent } from './base-agent';
import {
  subscribeStablecoinOrderbooks,
  unsubscribeStablecoinOrderbooks,
  getAllStablecoinOrderbooks,
  onStablecoinOrderbookUpdate,
  type OrderbookTop,
} from '../services/upbit-price-manager';
import { stablecoinPrisma as prisma } from '../config/database';
import mainPrisma from '../config/database';
import {
  shouldFill,
  simulateTakerLeg,
  isAbort,
} from '../services/maker-taker-simulator.service';
import {
  processLiveBot as runLiveExecutor,
  type OrderClient,
  type PendingTradeInput,
  type LiveBotInput,
  type LiveExecutorResult,
} from '../services/maker-taker-live-executor';
import { tradingLock } from '../services/stablecoin-trading-lock';
import { checkMakerPlacementBalance } from '../services/maker-taker-balance-precheck';
import { shouldAutoPauseForMinBalance } from '../services/maker-taker-min-balance-guard';
import { UpbitService } from '../services/upbit.service';
import { BalanceCache } from '../services/upbit-balance-cache';
import { decrypt } from '../utils/encryption';
import { isSpreadProfitable } from '../services/maker-taker-spread-gate';

/**
 * Maker-Taker 시뮬레이터 (실거래 없이 DB 가상 기록)
 *
 * 설계서 §3~§4 참조.
 *   - 호가 업데이트마다 활성 봇별로 evaluate
 *   - pending 주문 없음 → 새 가상 주문 생성 (PENDING)
 *   - pending 주문 있음 → shouldFill() 판정 → FILLED / EXPIRED
 *   - FILLED 시 taker leg 시뮬레이션 + P&L 저장
 */
export class MakerTakerSimulatorAgent extends BaseAgent {
  private unsubscribe: (() => void) | null = null;
  private evaluateInFlight = false;
  // userId별 Upbit 클라이언트 + balance 캐시 (live=true 봇용, lazy init)
  private clients = new Map<number, { upbit: UpbitService; cache: BalanceCache }>();

  constructor() {
    super({
      id: 'maker-taker-sim',
      name: 'MakerTakerSimulatorAgent',
      description: 'Upbit 스테이블 maker-taker 시뮬레이터 (M3 전 관찰)',
      cycleIntervalMs: 0,
    });
  }

  protected async onStart(): Promise<void> {
    subscribeStablecoinOrderbooks();
    this.unsubscribe = onStablecoinOrderbookUpdate(() => {
      this.evaluate().catch((err: Error) => {
        console.error('[MakerTakerSimulatorAgent] evaluate unhandled:', err.message);
      });
    });
    console.log('[MakerTakerSimulatorAgent] 시뮬레이션 시작');
  }

  protected async onStop(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    unsubscribeStablecoinOrderbooks();
    this.clients.clear();
    console.log('[MakerTakerSimulatorAgent] 정지');
  }

  protected async onCycle(): Promise<void> {
    // 이벤트 드리븐 - 사이클 루프 미사용
  }

  private async evaluate(): Promise<void> {
    if (this.evaluateInFlight) return;
    this.evaluateInFlight = true;

    try {
      const bots = await prisma.makerTakerSimBot.findMany({
        where: { enabled: true, killSwitch: false },
      });
      if (bots.length === 0) return;

      const books = getAllStablecoinOrderbooks();

      for (const bot of bots) {
        try {
          await this.processBot(bot, books);
        } catch (err: any) {
          console.error(
            `[MakerTakerSimulatorAgent] bot ${bot.id} processBot 실패:`,
            err.message,
          );
        }
      }
    } catch (err: any) {
      this.metrics.errors++;
      this.metrics.lastError = err.message;
      console.error('[MakerTakerSimulatorAgent] evaluate error:', err.message);
    } finally {
      this.evaluateInFlight = false;
    }
  }

  private async processBot(
    bot: Awaited<ReturnType<typeof prisma.makerTakerSimBot.findMany>>[number],
    books: ReadonlyMap<string, OrderbookTop>,
  ): Promise<void> {
    if (bot.live === true) {
      await this.handleLiveBot(bot, books);
      return;
    }

    const makerBook = books.get(`KRW-${bot.makerCoin}`);
    const takerBook = books.get(`KRW-${bot.takerCoin}`);
    if (!makerBook || !takerBook) return;

    const now = new Date();

    // 현재 PENDING trade 조회
    const pending = await prisma.makerTakerSimTrade.findFirst({
      where: { botId: bot.id, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });

    if (!pending) {
      // PR H — 수익성 게이팅 (live/sim 정합성)
      const gate = isSpreadProfitable(makerBook, bot.minSpreadKrw);
      if (!gate.ok) {
        // row 미생성 — 통계 단절 리스크는 spec §7 R1 참조
        return;
      }

      // 새 가상 주문 생성: makerCoin의 현재 best bid + bidOffsetKrw
      const makerOrderPrice = makerBook.bid.price + bot.bidOffsetKrw;
      await prisma.makerTakerSimTrade.create({
        data: {
          botId: bot.id,
          makerCoin: bot.makerCoin,
          takerCoin: bot.takerCoin,
          makerOrderPrice,
          quantity: bot.quantity,
          status: 'PENDING',
          notes: `생성: makerBid=${makerBook.bid.price}, offset=${bot.bidOffsetKrw}, spread=${gate.spreadKrw}`,
        },
      });
      return;
    }

    // pending 주문 있음 → 체결 판정
    const decision = shouldFill(
      {
        makerOrderPrice: pending.makerOrderPrice,
        createdAt: pending.createdAt,
        maxPendingMs: bot.maxPendingMs,
      },
      makerBook,
      now,
    );

    if (decision === 'wait') return;

    if (decision === 'expire') {
      await prisma.makerTakerSimTrade.update({
        where: { id: pending.id },
        data: {
          status: 'EXPIRED',
          notes: (pending.notes ?? '') + ` | EXPIRED at ${now.toISOString()}`,
        },
      });
      return;
    }

    // decision === 'fill' → taker leg 시뮬레이션
    const takerResult = simulateTakerLeg({
      makerFilledPrice: pending.makerOrderPrice,
      takerOrderbook: takerBook,
      quantity: Number(bot.quantity),
      feeBpsMaker: bot.makerFeeBps,
      feeBpsTaker: bot.takerFeeBps,
      minTakerBidKrw: bot.minTakerBidKrw ?? undefined,
    });

    if (isAbort(takerResult)) {
      await prisma.makerTakerSimTrade.update({
        where: { id: pending.id },
        data: {
          status: 'CANCELLED',
          makerFilledAt: now,
          makerFilledPrice: pending.makerOrderPrice,
          notes: (pending.notes ?? '') + ` | taker abort: ${takerResult.reason}`,
        },
      });
      return;
    }

    await prisma.makerTakerSimTrade.update({
      where: { id: pending.id },
      data: {
        status: 'FILLED',
        makerFilledAt: now,
        makerFilledPrice: pending.makerOrderPrice,
        takerExecutedAt: now,
        takerMarketBid: takerResult.takerPrice,
        takerSlippageBps: takerResult.slippageBps,
        grossProfitKrw: takerResult.grossProfitKrw,
        feeKrw: takerResult.feeKrw,
        netProfitKrw: takerResult.netProfitKrw,
        realizedSpreadBps: takerResult.realizedSpreadBps,
        notes:
          (pending.notes ?? '') +
          ` | FILLED takerBid=${takerResult.takerPrice} net=${takerResult.netProfitKrw.toFixed(2)}`,
      },
    });
  }

  /**
   * live=true 봇 처리. maker-taker-live-executor에 위임 + DB write 적용.
   *
   * 메서드명은 `handleLiveBot` — import한 executor 함수 `processLiveBot`(alias `runLiveExecutor`)와 구분.
   */
  private async handleLiveBot(
    bot: Awaited<ReturnType<typeof prisma.makerTakerSimBot.findMany>>[number],
    books: ReadonlyMap<string, OrderbookTop>,
  ): Promise<void> {
    if (bot.killSwitch) return;

    // 1. PENDING 조회 (live=true 트레이드만)
    const pending = await prisma.makerTakerSimTrade.findFirst({
      where: { botId: bot.id, status: 'PENDING', live: true },
      orderBy: { createdAt: 'desc' },
    });

    const pendingInput: PendingTradeInput | null = pending
      ? {
          id: pending.id,
          status: pending.status,
          makerOrderUuid: pending.makerOrderUuid,
          makerOrderPrice: pending.makerOrderPrice,
          createdAt: pending.createdAt,
          notes: pending.notes,
        }
      : null;

    // 2. 클라이언트 (with credential cache)
    let upbitClient;
    try {
      upbitClient = await this.getClientFor(bot.userId);
    } catch (err: any) {
      console.error(
        `[MakerTakerSimulatorAgent] bot ${bot.id} credential missing:`,
        err.message,
      );
      return;
    }

    // 3. 잔고 가드 + pre-check (CASE A — pending null일 때만)
    let preCheckOk = true;
    if (pending === null) {
      let balances: Record<string, number>;
      try {
        balances = await upbitClient.cache.get();
      } catch (err: any) {
        console.error(
          `[MakerTakerSimulatorAgent] bot ${bot.id} balance fetch 실패:`,
          err.message,
        );
        return;
      }

      // (a) minTakerBalance 자동 일시정지
      const guard = shouldAutoPauseForMinBalance({
        takerCoin: bot.takerCoin,
        takerBalance: balances[bot.takerCoin] ?? 0,
        minTakerBalance: bot.minTakerBalance,
      });
      if (guard.autoPause) {
        await prisma.makerTakerSimBot.update({
          where: { id: bot.id },
          data: { enabled: false },
        });
        console.warn(
          `[MakerTakerSimulatorAgent] bot ${bot.id} 자동 일시정지 (enabled=false): ${guard.reason}`,
        );
        return;
      }

      // (b) 사전 잔고 체크 — maker placement 직전
      const makerBook = books.get(`KRW-${bot.makerCoin}`);
      if (!makerBook) {
        return;
      }
      const makerOrderPrice = makerBook.bid.price + bot.bidOffsetKrw;
      const precheck = checkMakerPlacementBalance({
        takerCoin: bot.takerCoin,
        quantity: Number(bot.quantity),
        makerOrderPrice,
        makerFeeBps: bot.makerFeeBps,
        balances,
      });
      if (!precheck.ok) {
        console.log(
          `[MakerTakerSimulatorAgent] bot ${bot.id} pre-check 실패: ${precheck.reason}`,
        );
        preCheckOk = false;
      }

      // PR H — 수익성 게이팅 (precheck 통과 후에만 검사)
      if (preCheckOk) {
        const gate = isSpreadProfitable(makerBook, bot.minSpreadKrw);
        if (!gate.ok) {
          console.log(
            `[MakerTakerSimulatorAgent] bot ${bot.id} spread gate: ${gate.reason}`,
          );
          preCheckOk = false;
        }
      }
    }

    const client: OrderClient = {
      placeLimit: (m, s, p) => upbitClient.upbit.placeLimitOrder(m, s, p),
      placeBestIoc: (m, s, p) => upbitClient.upbit.placeBestIoc(m, s, p),
      getOrder: (uuid) => upbitClient.upbit.getOrder(uuid),
      cancelOrder: (uuid) => upbitClient.upbit.cancelOrder(uuid),
    };

    const liveBot: LiveBotInput = {
      id: bot.id,
      userId: bot.userId,
      makerCoin: bot.makerCoin,
      takerCoin: bot.takerCoin,
      bidOffsetKrw: bot.bidOffsetKrw,
      quantity: Number(bot.quantity),
      maxPendingMs: bot.maxPendingMs,
      killSwitch: bot.killSwitch,
      minSpreadKrw: bot.minSpreadKrw, // PR H — agent 가 spread gate 결정 시 사용 (Prisma NOT NULL, Int @default(12))
    };

    const result = await runLiveExecutor({
      bot: liveBot,
      pending: pendingInput,
      books,
      client,
      isLocked: () => tradingLock.isLocked(),
      preCheckOk,
    });

    // 거래 직후 잔고 캐시 invalidate (다음 evaluate에서 fresh)
    if (
      result.kind === 'placed' ||
      result.kind === 'filled' ||
      result.kind === 'partial_hold'
    ) {
      upbitClient.cache.invalidate();
    }

    // 4. 결과별 DB write
    await this.persistLiveResult(bot, pending, result);
  }

  /** LiveExecutorResult 7가지 kind를 DB row에 반영 */
  private async persistLiveResult(
    bot: Awaited<ReturnType<typeof prisma.makerTakerSimBot.findMany>>[number],
    pending: Awaited<ReturnType<typeof prisma.makerTakerSimTrade.findFirst>>,
    result: LiveExecutorResult,
  ): Promise<void> {
    switch (result.kind) {
      case 'noop':
        // lock held / preCheck abort / no book / placeLimit rejected 케이스 — 운영 가시성 위해 로깅
        console.log(
          `[MakerTakerSimulatorAgent] bot ${bot.id} live noop (lock held / preCheck abort / no book / placeLimit rejected)`,
        );
        return;

      case 'waiting':
        // 일반 polling — 로그 불필요 (스팸 방지)
        return;

      case 'placed':
        await prisma.makerTakerSimTrade.create({
          data: {
            botId: bot.id,
            makerCoin: bot.makerCoin,
            takerCoin: bot.takerCoin,
            makerOrderPrice: result.makerOrderPrice,
            quantity: bot.quantity,
            status: 'PENDING',
            live: true,
            makerOrderUuid: result.makerOrderUuid,
            notes: `LIVE order placed at ${result.makerOrderPrice}`,
          },
        });
        return;

      case 'expired':
        await prisma.makerTakerSimTrade.update({
          where: { id: result.pendingId },
          data: {
            status: 'EXPIRED',
            notes:
              (pending?.notes ?? '') +
              ` | LIVE expired (cancelled at ${new Date().toISOString()})`,
          },
        });
        return;

      case 'filled': {
        const now = new Date();
        // 모든 KRW 값은 raw float — DB Decimal 컬럼에 맞춰 round (Decimal은 자동 처리되지만 안전 위해)
        const grossProfitKrw = +(result.filledSellKrw - result.filledMakerKrw).toFixed(4);
        const feeKrw = +result.paidFeeKrw.toFixed(4);
        const netProfitKrw = +result.netProfitKrw.toFixed(4);

        await prisma.makerTakerSimTrade.update({
          where: { id: result.pendingId },
          data: {
            status: 'FILLED',
            makerFilledAt: now,
            makerFilledPrice: pending?.makerOrderPrice ?? null,
            takerExecutedAt: now,
            takerMarketBid: Math.round(
              result.filledSellKrw / Math.max(result.filledQty, 1e-9),
            ),
            grossProfitKrw,
            feeKrw,
            netProfitKrw,
            realizedSpreadBps: result.realizedSpreadBps,
            notes:
              (pending?.notes ?? '') +
              ` | LIVE FILLED maker=${result.filledMakerKrw} sell=${result.filledSellKrw} fees=${feeKrw} net=${netProfitKrw}`,
          },
        });
        return;
      }

      case 'partial_hold':
        await prisma.makerTakerSimTrade.update({
          where: { id: result.pendingId },
          data: {
            status: 'PARTIAL_HOLD',
            notes: (pending?.notes ?? '') + ` | LIVE ${result.reason}`,
          },
        });
        return;

      default: {
        // exhaustive check — 향후 새 kind 추가 시 컴파일 에러로 알림
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  }

  /** userId별 Upbit 클라이언트 + balance 캐시 lazy init (PR B 패턴) */
  private async getClientFor(
    userId: number,
  ): Promise<{ upbit: UpbitService; cache: BalanceCache }> {
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
}
