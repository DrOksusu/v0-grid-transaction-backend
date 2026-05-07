import { BaseAgent } from './base-agent';
import {
  subscribeStablecoinOrderbooks,
  unsubscribeStablecoinOrderbooks,
  getAllStablecoinOrderbooks,
  onStablecoinOrderbookUpdate,
  type OrderbookTop,
} from '../services/upbit-price-manager';
import {
  subscribeBithumbStablecoinOrderbooks,
  unsubscribeBithumbStablecoinOrderbooks,
  getBithumbStablecoinOrderbook,
} from '../services/bithumb-stablecoin-ws-manager';
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
  type NormalizedBook,
  type PendingTradeInput,
  type LiveBotInput,
  type LiveExecutorResult,
} from '../services/maker-taker-live-executor';
import { UpbitLeg, BithumbLeg } from '../services/exchange-leg';
import { tradingLock } from '../services/stablecoin-trading-lock';
import { checkMakerPlacementBalance } from '../services/maker-taker-balance-precheck';
import { shouldAutoPauseForMinBalance } from '../services/maker-taker-min-balance-guard';
import { UpbitService } from '../services/upbit.service';
import { BalanceCache } from '../services/upbit-balance-cache';
import { BithumbClient } from '../services/exchange/bithumb-client';
import { decrypt } from '../utils/encryption';
import { isSpreadProfitable } from '../services/maker-taker-spread-gate';

/** Upbit OrderbookTop → NormalizedBook */
function normalizeUpbit(book: OrderbookTop): NormalizedBook {
  return { bid: book.bid.price, ask: book.ask.price };
}

export class MakerTakerSimulatorAgent extends BaseAgent {
  private unsubscribe: (() => void) | null = null;
  private evaluateInFlight = false;
  private upbitClients = new Map<number, { upbit: UpbitService; cache: BalanceCache }>();
  private bithumbClients = new Map<number, BithumbClient>();
  private bithumbBalanceCaches = new Map<number, { data: Record<string, number>; at: number }>();

  constructor() {
    super({
      id: 'maker-taker-sim',
      name: 'MakerTakerSimulatorAgent',
      description: 'Maker-Taker 시뮬레이터 (크로스 거래소 지원)',
      cycleIntervalMs: 0,
    });
  }

  protected async onStart(): Promise<void> {
    subscribeStablecoinOrderbooks();
    subscribeBithumbStablecoinOrderbooks();
    this.unsubscribe = onStablecoinOrderbookUpdate(() => {
      this.evaluate().catch((err: Error) => {
        console.error('[MakerTakerSimulatorAgent] evaluate unhandled:', err.message);
      });
    });
    console.log('[MakerTakerSimulatorAgent] 시작 (Upbit + Bithumb WS)');
  }

  protected async onStop(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    unsubscribeStablecoinOrderbooks();
    unsubscribeBithumbStablecoinOrderbooks();
    this.upbitClients.clear();
    this.bithumbClients.clear();
    this.bithumbBalanceCaches.clear();
    console.log('[MakerTakerSimulatorAgent] 정지');
  }

  protected async onCycle(): Promise<void> {
    // 이벤트 드리븐 — 사이클 루프 미사용
  }

  private async evaluate(): Promise<void> {
    if (this.evaluateInFlight) return;
    this.evaluateInFlight = true;

    try {
      const bots = await (prisma.makerTakerSimBot as any).findMany({
        where: { enabled: true, killSwitch: false },
      });
      if (bots.length === 0) return;

      const upbitBooks = getAllStablecoinOrderbooks();

      for (const bot of bots) {
        try {
          await this.processBot(bot, upbitBooks);
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
    bot: any,
    upbitBooks: ReadonlyMap<string, OrderbookTop>,
  ): Promise<void> {
    if (bot.live === true) {
      await this.handleLiveBot(bot, upbitBooks);
      return;
    }

    // 시뮬 모드: 업비트 호가로 판정 (크로스 거래소 시뮬은 추후 개선)
    const makerBook = upbitBooks.get(`KRW-${bot.makerCoin}`);
    const takerBook = upbitBooks.get(`KRW-${bot.takerCoin}`);
    if (!makerBook || !takerBook) return;

    const makerNorm = normalizeUpbit(makerBook);
    const takerNorm = normalizeUpbit(takerBook);
    const now = new Date();

    const pending = await (prisma.makerTakerSimTrade as any).findFirst({
      where: { botId: bot.id, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });

    if (!pending) {
      const direction = decideLegOrder(makerNorm, takerNorm);

      if (direction === 'MAKER_BUY_FIRST') {
        const gate = isSpreadProfitable(makerBook, bot.minSpreadKrw);
        if (!gate.ok) return;

        const makerOrderPrice = makerNorm.bid + bot.bidOffsetKrw;
        await (prisma.makerTakerSimTrade as any).create({
          data: {
            botId: bot.id,
            makerCoin: bot.makerCoin,
            takerCoin: bot.takerCoin,
            makerOrderPrice,
            quantity: bot.quantity,
            status: 'PENDING',
            legOrder: 'MAKER_BUY_FIRST',
            notes: `생성[MAKER_BUY_FIRST]: makerBid=${makerNorm.bid}, offset=${bot.bidOffsetKrw}, spread=${gate.spreadKrw}`,
          },
        });
      } else {
        const crossSpread = makerNorm.bid - takerNorm.bid;
        if (crossSpread < bot.minSpreadKrw) return;

        const takerFirstPrice = makerNorm.bid;
        const qty = Number(bot.quantity);
        const takerFirstCostKrw = takerFirstPrice * qty;
        const takerFirstFeeKrw = (takerFirstCostKrw * bot.takerFeeBps) / 10000;
        const makerOrderPrice = takerNorm.bid + bot.bidOffsetKrw;

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
            notes: `생성[TAKER_SELL_FIRST]: makerBid=${makerNorm.bid}, takerBid=${takerNorm.bid}, crossSpread=${crossSpread}`,
          },
        });
      }
      return;
    }

    // pending 주문 → 체결 판정
    const legOrder: string = pending.legOrder ?? 'MAKER_BUY_FIRST';
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

    if (legOrder === 'TAKER_SELL_FIRST') {
      const qty = Number(bot.quantity);
      const takerFirstCostKrw = Number(pending.takerFirstCostKrw ?? 0);
      const takerFirstFeeKrw = Number(pending.takerFirstFeeKrw ?? 0);
      const makerFilledKrw = pending.makerOrderPrice * qty;
      const makerFee = (makerFilledKrw * bot.makerFeeBps) / 10000;
      const feeKrw = takerFirstFeeKrw + makerFee;
      const grossProfitKrw = takerFirstCostKrw - makerFilledKrw;
      const netProfitKrw = grossProfitKrw - feeKrw;
      const realizedSpreadBps =
        makerFilledKrw > 0
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
   * live=true 봇 처리. 크로스 거래소 지원.
   */
  private async handleLiveBot(
    bot: any,
    upbitBooks: ReadonlyMap<string, OrderbookTop>,
  ): Promise<void> {
    if (bot.killSwitch) return;

    const makerExchange: string = bot.makerExchange ?? 'upbit';
    const takerExchange: string = bot.takerExchange ?? 'upbit';

    // 거래소별 호가 조회 및 정규화
    const makerBookRaw =
      makerExchange === 'bithumb'
        ? getBithumbStablecoinOrderbook(bot.makerCoin)
        : upbitBooks.get(`KRW-${bot.makerCoin}`);
    const takerBookRaw =
      takerExchange === 'bithumb'
        ? getBithumbStablecoinOrderbook(bot.takerCoin)
        : upbitBooks.get(`KRW-${bot.takerCoin}`);

    if (!makerBookRaw || !takerBookRaw) return;

    const makerBook: NormalizedBook =
      makerExchange === 'bithumb'
        ? { bid: (makerBookRaw as any).bid, ask: (makerBookRaw as any).ask }
        : normalizeUpbit(makerBookRaw as OrderbookTop);
    const takerBook: NormalizedBook =
      takerExchange === 'bithumb'
        ? { bid: (takerBookRaw as any).bid, ask: (takerBookRaw as any).ask }
        : normalizeUpbit(takerBookRaw as OrderbookTop);

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
          takerFirstCostKrw:
            pending.takerFirstCostKrw != null ? Number(pending.takerFirstCostKrw) : null,
          takerFirstFeeKrw:
            pending.takerFirstFeeKrw != null ? Number(pending.takerFirstFeeKrw) : null,
        }
      : null;

    // 거래소 클라이언트 확보
    let upbitClient: { upbit: UpbitService; cache: BalanceCache } | null = null;
    let bithumbClient: BithumbClient | null = null;

    const needsUpbit = makerExchange === 'upbit' || takerExchange === 'upbit';
    const needsBithumb = makerExchange === 'bithumb' || takerExchange === 'bithumb';

    if (needsUpbit) {
      try {
        upbitClient = await this.getUpbitClientFor(bot.userId);
      } catch (err: any) {
        console.error(`[MakerTakerSimulatorAgent] bot ${bot.id} Upbit credential:`, err.message);
        return;
      }
    }

    if (needsBithumb) {
      try {
        bithumbClient = await this.getBithumbClientFor(bot.userId);
      } catch (err: any) {
        console.error(`[MakerTakerSimulatorAgent] bot ${bot.id} Bithumb credential:`, err.message);
        return;
      }
    }

    // ExchangeLeg 생성
    const makerLeg =
      makerExchange === 'bithumb'
        ? new BithumbLeg(bithumbClient!)
        : new UpbitLeg(upbitClient!.upbit);
    const takerLeg =
      takerExchange === 'bithumb'
        ? new BithumbLeg(bithumbClient!)
        : new UpbitLeg(upbitClient!.upbit);

    // 잔고 사전 체크 (pending 없을 때만)
    let preCheckOk = true;
    if (pending === null) {
      const direction = decideLegOrder(makerBook, takerBook);

      if (direction === 'MAKER_BUY_FIRST' && upbitClient && makerExchange === 'upbit') {
        let balances: Record<string, number>;
        try {
          balances = await upbitClient.cache.get();
        } catch (err: any) {
          console.error(`[MakerTakerSimulatorAgent] bot ${bot.id} balance fetch 실패:`, err.message);
          return;
        }

        const guard = shouldAutoPauseForMinBalance({
          takerCoin: bot.takerCoin,
          takerBalance: balances[bot.takerCoin] ?? 0,
          minTakerBalance: bot.minTakerBalance,
        });
        if (guard.autoPause) {
          await (prisma.makerTakerSimBot as any).update({
            where: { id: bot.id },
            data: { enabled: false },
          });
          console.warn(`[MakerTakerSimulatorAgent] bot ${bot.id} 자동 일시정지: ${guard.reason}`);
          return;
        }

        const makerOrderPrice = makerBook.bid + bot.bidOffsetKrw;
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

        if (preCheckOk) {
          // cross-exchange spread: takerBook.bid - makerBook.bid (MAKER_BUY_FIRST)
          const crossSpread = takerBook.bid - makerBook.bid;
          if (bot.minSpreadKrw > 0 && crossSpread < bot.minSpreadKrw) {
            console.log(`[MakerTakerSimulatorAgent] bot ${bot.id} spread gate: ${crossSpread} < ${bot.minSpreadKrw}`);
            preCheckOk = false;
          }
        }
      } else if (direction === 'TAKER_SELL_FIRST' && upbitClient && makerExchange === 'upbit') {
        let balances: Record<string, number>;
        try {
          balances = await upbitClient.cache.get();
        } catch (err: any) {
          console.error(`[MakerTakerSimulatorAgent] bot ${bot.id} balance fetch 실패:`, err.message);
          return;
        }

        const makerCoinBalance = balances[bot.makerCoin] ?? 0;
        if (makerCoinBalance < Number(bot.quantity)) {
          console.log(
            `[MakerTakerSimulatorAgent] bot ${bot.id} TAKER_SELL_FIRST pre-check: makerCoin 잔고 부족 (${makerCoinBalance} < ${bot.quantity})`,
          );
          preCheckOk = false;
        }

        if (preCheckOk) {
          const crossSpread = makerBook.bid - takerBook.bid;
          if (crossSpread < bot.minSpreadKrw) {
            console.log(`[MakerTakerSimulatorAgent] bot ${bot.id} TAKER_SELL_FIRST spread gate: ${crossSpread} < ${bot.minSpreadKrw}`);
            preCheckOk = false;
          }
        }
      } else if (needsBithumb && !needsUpbit && bithumbClient) {
        // Bithumb 전용 봇: 스프레드 게이트 (cross-coin 가격 차이)
        if (preCheckOk) {
          const spreadKrw = direction === 'MAKER_BUY_FIRST'
            ? takerBook.bid - makerBook.bid   // takerCoin이 더 비쌀 때만 MAKER_BUY_FIRST
            : makerBook.bid - takerBook.bid;  // makerCoin이 더 비쌀 때만 TAKER_SELL_FIRST
          if (spreadKrw < bot.minSpreadKrw) {
            console.log(
              `[MakerTakerSimulatorAgent] bot ${bot.id} Bithumb spread gate: ${spreadKrw.toFixed(2)} < ${bot.minSpreadKrw} (${bot.makerCoin}↔${bot.takerCoin})`,
            );
            preCheckOk = false;
          }
        }

        // Bithumb 전용 봇 잔고 사전 체크
        let bithumbAvail: Record<string, number> = {};
        if (preCheckOk) {
          try {
            bithumbAvail = await this.getBithumbAvailableBalances(bot.userId, bithumbClient);
          } catch (err: any) {
            console.error(`[MakerTakerSimulatorAgent] bot ${bot.id} Bithumb 잔고 fetch 실패:`, err.message);
            preCheckOk = false;
          }
        }

        if (preCheckOk) {
          if (direction === 'TAKER_SELL_FIRST') {
            const available = bithumbAvail[bot.makerCoin] ?? 0;
            if (available < Number(bot.quantity)) {
              console.log(
                `[MakerTakerSimulatorAgent] bot ${bot.id} Bithumb TAKER_SELL_FIRST 잔고 부족: ${bot.makerCoin} available=${available.toFixed(4)} < quantity=${bot.quantity}`,
              );
              preCheckOk = false;
            }
          } else {
            // MAKER_BUY_FIRST: CASE A에서 KRW로 makerCoin 매수
            const krwAvail = bithumbAvail['KRW'] ?? 0;
            const requiredKrw = makerBook.ask * Number(bot.quantity) * 1.01;
            if (krwAvail < requiredKrw) {
              console.log(
                `[MakerTakerSimulatorAgent] bot ${bot.id} Bithumb MAKER_BUY_FIRST KRW 부족: available=${krwAvail.toFixed(0)} < required=${requiredKrw.toFixed(0)}`,
              );
              preCheckOk = false;
            }
            // CASE B에서 takerCoin IOC 매도가 필요하므로 takerCoin도 사전 확인
            if (preCheckOk) {
              const takerCoinAvail = bithumbAvail[bot.takerCoin] ?? 0;
              if (takerCoinAvail < Number(bot.quantity)) {
                console.log(
                  `[MakerTakerSimulatorAgent] bot ${bot.id} Bithumb MAKER_BUY_FIRST takerCoin 잔고 부족: ${bot.takerCoin} available=${takerCoinAvail.toFixed(4)} < quantity=${bot.quantity}`,
                );
                preCheckOk = false;
              }
            }
          }
        }
      }
    }

    const liveBot: LiveBotInput = {
      id: bot.id,
      userId: bot.userId,
      makerCoin: bot.makerCoin,
      takerCoin: bot.takerCoin,
      makerExchange,
      takerExchange,
      bidOffsetKrw: bot.bidOffsetKrw,
      quantity: Number(bot.quantity),
      maxPendingMs: bot.maxPendingMs,
      killSwitch: bot.killSwitch,
      minSpreadKrw: bot.minSpreadKrw,
    };

    const result = await runLiveExecutor({
      bot: liveBot,
      pending: pendingInput,
      makerBook,
      takerBook,
      makerLeg,
      takerLeg,
      isLocked: () => tradingLock.isLocked(),
      preCheckOk,
    });

    if (
      (result.kind === 'placed' || result.kind === 'filled' || result.kind === 'partial_hold') &&
      upbitClient
    ) {
      upbitClient.cache.invalidate();
    }

    if (result.kind === 'placed' || result.kind === 'filled' || result.kind === 'partial_hold') {
      this.bithumbBalanceCaches.delete(bot.userId);
    }

    await this.persistLiveResult(bot, pending, result);
  }

  private async persistLiveResult(
    bot: any,
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
            notes:
              (pending?.notes ?? '') +
              ` | LIVE expired (cancelled at ${new Date().toISOString()})`,
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

  private async getUpbitClientFor(
    userId: number,
  ): Promise<{ upbit: UpbitService; cache: BalanceCache }> {
    const existing = this.upbitClients.get(userId);
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
    this.upbitClients.set(userId, client);
    return client;
  }

  private async getBithumbClientFor(userId: number): Promise<BithumbClient> {
    const existing = this.bithumbClients.get(userId);
    if (existing) return existing;

    const credential = await mainPrisma.credential.findFirst({
      where: { userId, exchange: 'bithumb' },
    });
    if (!credential) throw new Error(`Bithumb credential not found for userId=${userId}`);

    const client = new BithumbClient({
      accessKey: decrypt(credential.apiKey),
      secretKey: decrypt(credential.secretKey),
    });
    this.bithumbClients.set(userId, client);
    return client;
  }

  private async getBithumbAvailableBalances(
    userId: number,
    client: BithumbClient,
  ): Promise<Record<string, number>> {
    const TTL_MS = 5_000;
    const cached = this.bithumbBalanceCaches.get(userId);
    if (cached && Date.now() - cached.at < TTL_MS) return cached.data;

    const full = await client.getBalances();
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(full)) out[k] = v.available;
    this.bithumbBalanceCaches.set(userId, { data: out, at: Date.now() });
    return out;
  }
}
