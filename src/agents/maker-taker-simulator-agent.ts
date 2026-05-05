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
  decideLegOrder,
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
 *   - pending 주문 없음 → 방향 결정(decideLegOrder) 후 새 가상 주문 생성 (PENDING)
 *   - pending 주문 있음 → shouldFill() 판정 → FILLED / EXPIRED
 *   - FILLED 시 taker leg 시뮬레이션 + P&L 저장
 */
export class MakerTakerSimulatorAgent extends BaseAgent {
  private unsubscribe: (() => void) | null = null;
  private evaluateInFlight = false;
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

    const pending = await (prisma.makerTakerSimTrade as any).findFirst({
      where: { botId: bot.id, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });

    if (!pending) {
      // 방향 결정
      const direction = decideLegOrder(makerBook, takerBook);

      if (direction === 'MAKER_BUY_FIRST') {
        const gate = isSpreadProfitable(makerBook, bot.minSpreadKrw);
        if (!gate.ok) return;

        const makerOrderPrice = makerBook.bid.price + bot.bidOffsetKrw;
        await (prisma.makerTakerSimTrade as any).create({
          data: {
            botId: bot.id,
            makerCoin: bot.makerCoin,
            takerCoin: bot.takerCoin,
            makerOrderPrice,
            quantity: bot.quantity,
            status: 'PENDING',
            legOrder: 'MAKER_BUY_FIRST',
            notes: `생성[MAKER_BUY_FIRST]: makerBid=${makerBook.bid.price}, offset=${bot.bidOffsetKrw}, spread=${gate.spreadKrw}`,
          },
        });
      } else {
        // TAKER_SELL_FIRST: makerCoin.bid > takerCoin.bid
        const crossSpread = makerBook.bid.price - takerBook.bid.price;
        if (crossSpread < bot.minSpreadKrw) return;

        // 시뮬: IOC 매도 makerCoin at makerBook.bid
        const takerFirstPrice = makerBook.bid.price;
        const qty = Number(bot.quantity);
        const takerFirstCostKrw = takerFirstPrice * qty;
        const takerFirstFeeKrw = (takerFirstCostKrw * bot.takerFeeBps) / 10000;

        // takerCoin maker BID 주문가
        const makerOrderPrice = takerBook.bid.price + bot.bidOffsetKrw;

        await (prisma.makerTakerSimTrade as any).create({
          data: {
            botId: bot.id,
            makerCoin: bot.makerCoin,
            takerCoin: bot.takerCoin,
            makerOrderPrice,
            quantity: bot.quantity,
            status: 'PENDING',
            legOrder: 'TAKER_SELL_FIRST',
            takerFirstCostKrw,
            takerFirstFeeKrw,
            notes: `생성[TAKER_SELL_FIRST]: makerBid=${makerBook.bid.price}, takerBid=${takerBook.bid.price}, crossSpread=${crossSpread}`,
          },
        });
      }
      return;
    }

    // pending 주문 있음 → 체결 판정
    const legOrder: string = pending.legOrder ?? 'MAKER_BUY_FIRST';

    // 체결 판정 시 사용할 호가북: TAKER_SELL_FIRST는 takerBook 기준
    const bookForFill = legOrder === 'TAKER_SELL_FIRST' ? takerBook : makerBook;
    const decision = shouldFill(
      {
        makerOrderPrice: pending.makerOrderPrice,
        createdAt: pending.createdAt,
        maxPendingMs: bot.maxPendingMs,
      },
      bookForFill,
      now,
    );

    if (decision === 'wait') return;

    if (decision === 'expire') {
      await (prisma.makerTakerSimTrade as any).update({
        where: { id: pending.id },
        data: {
          status: 'EXPIRED',
          notes: (pending.notes ?? '') + ` | EXPIRED at ${now.toISOString()}`,
        },
      });
      return;
    }

    // decision === 'fill'
    if (legOrder === 'TAKER_SELL_FIRST') {
      // takerCoin maker BID 체결 → P&L 계산
      const qty = Number(bot.quantity);
      const takerFirstCostKrw = Number(pending.takerFirstCostKrw ?? 0);
      const takerFirstFeeKrw = Number(pending.takerFirstFeeKrw ?? 0);
      const makerFilledKrw = pending.makerOrderPrice * qty;
      const makerFee = (makerFilledKrw * bot.makerFeeBps) / 10000;
      const feeKrw = takerFirstFeeKrw + makerFee;
      const grossProfitKrw = takerFirstCostKrw - makerFilledKrw;
      const netProfitKrw = grossProfitKrw - feeKrw;
      const realizedSpreadBps = makerFilledKrw > 0
        ? Math.floor(((takerFirstCostKrw - makerFilledKrw) / makerFilledKrw) * 10000)
        : 0;

      await (prisma.makerTakerSimTrade as any).update({
        where: { id: pending.id },
        data: {
          status: 'FILLED',
          makerFilledAt: now,
          makerFilledPrice: pending.makerOrderPrice,
          takerExecutedAt: now,
          takerMarketBid: Math.round(takerFirstCostKrw / Math.max(qty, 1e-9)),
          grossProfitKrw,
          feeKrw,
          netProfitKrw,
          realizedSpreadBps,
          notes:
            (pending.notes ?? '') +
            ` | FILLED[TAKER_SELL_FIRST] takerSell=${takerFirstCostKrw} takerBuy=${makerFilledKrw} net=${netProfitKrw.toFixed(2)}`,
        },
      });
      return;
    }

    // MAKER_BUY_FIRST: 기존 taker leg 시뮬
    const takerResult = simulateTakerLeg({
      makerFilledPrice: pending.makerOrderPrice,
      takerOrderbook: takerBook,
      quantity: Number(bot.quantity),
      feeBpsMaker: bot.makerFeeBps,
      feeBpsTaker: bot.takerFeeBps,
      minTakerBidKrw: bot.minTakerBidKrw ?? undefined,
    });

    if (isAbort(takerResult)) {
      await (prisma.makerTakerSimTrade as any).update({
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

    await (prisma.makerTakerSimTrade as any).update({
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
          ` | FILLED[MAKER_BUY_FIRST] takerBid=${takerResult.takerPrice} net=${takerResult.netProfitKrw.toFixed(2)}`,
      },
    });
  }

  /**
   * live=true 봇 처리. maker-taker-live-executor에 위임 + DB write 적용.
   */
  private async handleLiveBot(
    bot: Awaited<ReturnType<typeof prisma.makerTakerSimBot.findMany>>[number],
    books: ReadonlyMap<string, OrderbookTop>,
  ): Promise<void> {
    if (bot.killSwitch) return;

    const pending = await (prisma.makerTakerSimTrade as any).findFirst({
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
          legOrder: pending.legOrder ?? 'MAKER_BUY_FIRST',
          takerFirstCostKrw: pending.takerFirstCostKrw != null ? Number(pending.takerFirstCostKrw) : null,
          takerFirstFeeKrw: pending.takerFirstFeeKrw != null ? Number(pending.takerFirstFeeKrw) : null,
        }
      : null;

    let upbitClient;
    try {
      upbitClient = await this.getClientFor(bot.userId);
    } catch (err: any) {
      console.error(`[MakerTakerSimulatorAgent] bot ${bot.id} credential missing:`, err.message);
      return;
    }

    let preCheckOk = true;
    if (pending === null) {
      const makerBook = books.get(`KRW-${bot.makerCoin}`);
      const takerBook = books.get(`KRW-${bot.takerCoin}`);
      if (!makerBook || !takerBook) return;

      let balances: Record<string, number>;
      try {
        balances = await upbitClient.cache.get();
      } catch (err: any) {
        console.error(`[MakerTakerSimulatorAgent] bot ${bot.id} balance fetch 실패:`, err.message);
        return;
      }

      const direction = decideLegOrder(makerBook, takerBook);

      if (direction === 'MAKER_BUY_FIRST') {
        // (a) minTakerBalance 자동 일시정지
        const guard = shouldAutoPauseForMinBalance({
          takerCoin: bot.takerCoin,
          takerBalance: balances[bot.takerCoin] ?? 0,
          minTakerBalance: bot.minTakerBalance,
        });
        if (guard.autoPause) {
          await prisma.makerTakerSimBot.update({ where: { id: bot.id }, data: { enabled: false } });
          console.warn(`[MakerTakerSimulatorAgent] bot ${bot.id} 자동 일시정지: ${guard.reason}`);
          return;
        }

        // (b) 사전 잔고 체크
        const makerOrderPrice = makerBook.bid.price + bot.bidOffsetKrw;
        const precheck = checkMakerPlacementBalance({
          takerCoin: bot.takerCoin,
          quantity: Number(bot.quantity),
          makerOrderPrice,
          makerFeeBps: bot.makerFeeBps,
          balances,
        });
        if (!precheck.ok) {
          console.log(`[MakerTakerSimulatorAgent] bot ${bot.id} pre-check 실패: ${precheck.reason}`);
          preCheckOk = false;
        }

        // (c) 수익성 게이팅
        if (preCheckOk) {
          const gate = isSpreadProfitable(makerBook, bot.minSpreadKrw);
          if (!gate.ok) {
            console.log(`[MakerTakerSimulatorAgent] bot ${bot.id} spread gate: ${gate.reason}`);
            preCheckOk = false;
          }
        }
      } else {
        // TAKER_SELL_FIRST: makerCoin 잔고 체크 (매도해야 하므로)
        const makerCoinBalance = balances[bot.makerCoin] ?? 0;
        if (makerCoinBalance < Number(bot.quantity)) {
          console.log(
            `[MakerTakerSimulatorAgent] bot ${bot.id} TAKER_SELL_FIRST pre-check 실패: makerCoin 잔고 부족 (${makerCoinBalance} < ${bot.quantity})`,
          );
          preCheckOk = false;
        }

        // 수익성 게이팅: cross spread
        if (preCheckOk) {
          const crossSpread = makerBook.bid.price - takerBook.bid.price;
          if (crossSpread < bot.minSpreadKrw) {
            console.log(
              `[MakerTakerSimulatorAgent] bot ${bot.id} TAKER_SELL_FIRST spread gate: crossSpread ${crossSpread} < ${bot.minSpreadKrw}`,
            );
            preCheckOk = false;
          }
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
      minSpreadKrw: bot.minSpreadKrw,
    };

    const result = await runLiveExecutor({
      bot: liveBot,
      pending: pendingInput,
      books,
      client,
      isLocked: () => tradingLock.isLocked(),
      preCheckOk,
    });

    if (result.kind === 'placed' || result.kind === 'filled' || result.kind === 'partial_hold') {
      upbitClient.cache.invalidate();
    }

    await this.persistLiveResult(bot, pending, result);
  }

  /** LiveExecutorResult를 DB row에 반영 */
  private async persistLiveResult(
    bot: Awaited<ReturnType<typeof prisma.makerTakerSimBot.findMany>>[number],
    pending: any,
    result: LiveExecutorResult,
  ): Promise<void> {
    switch (result.kind) {
      case 'noop':
        console.log(`[MakerTakerSimulatorAgent] bot ${bot.id} live noop`);
        return;

      case 'waiting':
        return;

      case 'placed':
        await (prisma.makerTakerSimTrade as any).create({
          data: {
            botId: bot.id,
            makerCoin: bot.makerCoin,
            takerCoin: bot.takerCoin,
            makerOrderPrice: result.makerOrderPrice,
            quantity: bot.quantity,
            status: 'PENDING',
            live: true,
            makerOrderUuid: result.makerOrderUuid,
            legOrder: result.legOrder,
            takerFirstCostKrw: result.takerFirstCostKrw ?? null,
            takerFirstFeeKrw: result.takerFirstFeeKrw ?? null,
            notes: `LIVE order placed [${result.legOrder}] at ${result.makerOrderPrice}`,
          },
        });
        return;

      case 'expired':
        await (prisma.makerTakerSimTrade as any).update({
          where: { id: result.pendingId },
          data: {
            status: 'EXPIRED',
            notes: (pending?.notes ?? '') + ` | LIVE expired (cancelled at ${new Date().toISOString()})`,
          },
        });
        return;

      case 'filled': {
        const now = new Date();
        const grossProfitKrw = +(result.filledSellKrw - result.filledMakerKrw).toFixed(4);
        const feeKrw = +result.paidFeeKrw.toFixed(4);
        const netProfitKrw = +result.netProfitKrw.toFixed(4);
        const legOrder: string = pending?.legOrder ?? 'MAKER_BUY_FIRST';

        await (prisma.makerTakerSimTrade as any).update({
          where: { id: result.pendingId },
          data: {
            status: 'FILLED',
            makerFilledAt: now,
            makerFilledPrice: pending?.makerOrderPrice ?? null,
            takerExecutedAt: now,
            takerMarketBid: Math.round(result.filledSellKrw / Math.max(result.filledQty, 1e-9)),
            grossProfitKrw,
            feeKrw,
            netProfitKrw,
            realizedSpreadBps: result.realizedSpreadBps,
            notes:
              (pending?.notes ?? '') +
              ` | LIVE FILLED[${legOrder}] sell=${result.filledSellKrw} buy=${result.filledMakerKrw} fees=${feeKrw} net=${netProfitKrw}`,
          },
        });
        return;
      }

      case 'partial_hold':
        await (prisma.makerTakerSimTrade as any).update({
          where: { id: result.pendingId },
          data: {
            status: 'PARTIAL_HOLD',
            notes: (pending?.notes ?? '') + ` | LIVE ${result.reason}`,
          },
        });
        return;

      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  }

  private async getClientFor(
    userId: number,
  ): Promise<{ upbit: UpbitService; cache: BalanceCache }> {
    const existing = this.clients.get(userId);
    if (existing) return existing;

    const credential = await mainPrisma.credential.findFirst({
      where: { userId, exchange: 'upbit' },
    });
    if (!credential) throw new Error(`Upbit credential not found for userId=${userId}`);

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
