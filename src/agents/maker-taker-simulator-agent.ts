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
import { isMakerBookSpreadProfitable, isCrossSpreadProfitable, calcCrossSpreadBps } from '../services/maker-taker-spread-gate';

/** Upbit OrderbookTop → NormalizedBook */
function normalizeUpbit(book: OrderbookTop): NormalizedBook {
  return { bid: book.bid.price, ask: book.ask.price };
}

const MAX_STABLECOIN_PRICE_DIFF_RATIO = 0.10; // 두 스테이블코인 가격이 10% 이상 차이나면 데이터 이상

/** 가격 이상 감지 — 이상 시 true 반환 */
function isBookDataSuspect(makerBid: number, takerBid: number, botId: number): boolean {
  const diffRatio = Math.abs(makerBid - takerBid) / makerBid;
  if (diffRatio > MAX_STABLECOIN_PRICE_DIFF_RATIO) {
    console.warn(`[MakerTakerSim] bot#${botId} 가격 이상: maker=${makerBid} taker=${takerBid} diff=${(diffRatio * 100).toFixed(1)}% — skip`);
    return true;
  }
  return false;
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
    if (isBookDataSuspect(makerNorm.bid, takerNorm.bid, bot.id)) return;
    const now = new Date();

    const pending = await (prisma.makerTakerSimTrade as any).findFirst({
      where: { botId: bot.id, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });

    if (!pending) {
      const direction = decideLegOrder(makerNorm, takerNorm);

      if (direction === 'MAKER_BUY_FIRST') {
        const gate = isCrossSpreadProfitable(makerNorm, takerNorm, 'MAKER_BUY_FIRST', bot.minSpreadBps);
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
            notes: `생성[MAKER_BUY_FIRST]: makerBid=${makerNorm.bid}, offset=${bot.bidOffsetKrw}, spread=${gate.spreadBps}bp`,
          },
        });
      } else {
        const gate = isCrossSpreadProfitable(makerNorm, takerNorm, 'TAKER_SELL_FIRST', bot.minSpreadBps);
        if (!gate.ok) return;

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
            notes: `생성[TAKER_SELL_FIRST]: makerBid=${makerNorm.bid}, takerBid=${takerNorm.bid}, spread=${gate.spreadBps}bp`,
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

    if (isBookDataSuspect(makerBook.bid, takerBook.bid, bot.id)) return;

    const pending = await (prisma.makerTakerSimTrade as any).findFirst({
      where: { botId: bot.id, status: { in: ['PENDING', 'TAKER_PENDING'] }, live: true },
      orderBy: { createdAt: 'desc' },
    });

    const pendingInput: PendingTradeInput | null = pending
      ? {
          id: pending.id,
          status: pending.status,
          makerOrderUuid: pending.makerOrderUuid,
          makerOrderPrice: pending.makerOrderPrice,
          createdAt: pending.createdAt,
          makerFilledAt: pending.makerFilledAt ?? null,
          notes: pending.notes,
          legOrder: pending.legOrder ?? 'MAKER_BUY_FIRST',
          takerFirstCostKrw:
            pending.takerFirstCostKrw != null ? Number(pending.takerFirstCostKrw) : null,
          takerFirstFeeKrw:
            pending.takerFirstFeeKrw != null ? Number(pending.takerFirstFeeKrw) : null,
          takerOrderUuid: pending.takerOrderUuid ?? null,
          // TAKER_PENDING 상태에서 maker fill 데이터 (grossProfitKrw/feeKrw에 임시 저장)
          makerFilledGrossKrw:
            pending.status === 'TAKER_PENDING' && pending.grossProfitKrw != null
              ? Number(pending.grossProfitKrw)
              : null,
          makerFilledFeeKrw:
            pending.status === 'TAKER_PENDING' && pending.feeKrw != null
              ? Number(pending.feeKrw)
              : null,
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

      // 스프레드 게이트: 거래소 조합에 무관하게 항상 먼저 체크
      const gate = isCrossSpreadProfitable(makerBook, takerBook, direction, bot.minSpreadBps);
      if (!gate.ok) {
        console.log(
          `[MakerTakerSimulatorAgent] bot ${bot.id} spread gate fail: ${gate.spreadBps}bp < ${bot.minSpreadBps}bp (${makerExchange}→${takerExchange} ${bot.makerCoin}/${bot.takerCoin})`,
        );
        preCheckOk = false;
      }

      if (preCheckOk && direction === 'MAKER_BUY_FIRST' && upbitClient && makerExchange === 'upbit') {
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
      } else if (preCheckOk && direction === 'TAKER_SELL_FIRST' && upbitClient && makerExchange === 'upbit') {
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
      } else if (preCheckOk && needsBithumb && bithumbClient) {
        // Bithumb 관련 봇 (단독 또는 크로스 거래소) 잔고 사전 체크
        let bithumbAvail: Record<string, number> = {};
        try {
          bithumbAvail = await this.getBithumbAvailableBalances(bot.userId, bithumbClient);
        } catch (err: any) {
          console.error(`[MakerTakerSimulatorAgent] bot ${bot.id} Bithumb 잔고 fetch 실패:`, err.message);
          preCheckOk = false;
        }

        if (preCheckOk) {
          if (direction === 'TAKER_SELL_FIRST' && makerExchange === 'bithumb') {
            const available = bithumbAvail[bot.makerCoin] ?? 0;
            if (available < Number(bot.quantity)) {
              console.log(
                `[MakerTakerSimulatorAgent] bot ${bot.id} Bithumb TAKER_SELL_FIRST 잔고 부족: ${bot.makerCoin} available=${available.toFixed(4)} < quantity=${bot.quantity}`,
              );
              preCheckOk = false;
            }
          } else if (direction === 'MAKER_BUY_FIRST' && makerExchange === 'bithumb') {
            const krwAvail = bithumbAvail['KRW'] ?? 0;
            const requiredKrw = makerBook.ask * Number(bot.quantity) * 1.01;
            if (krwAvail < requiredKrw) {
              console.log(
                `[MakerTakerSimulatorAgent] bot ${bot.id} Bithumb MAKER_BUY_FIRST KRW 부족: available=${krwAvail.toFixed(0)} < required=${requiredKrw.toFixed(0)}`,
              );
              preCheckOk = false;
            }
            if (preCheckOk) {
              // takerCoin IOC 매도 사전 확인 (거래소별)
              const takerCoinAvail =
                takerExchange === 'bithumb' ? (bithumbAvail[bot.takerCoin] ?? 0) : 0;
              if (takerExchange === 'bithumb' && takerCoinAvail < Number(bot.quantity)) {
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
      minSpreadBps: bot.minSpreadBps,
      cancelBelowBps: (bot.makerFeeBps ?? 5) + (bot.takerFeeBps ?? 5),
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

    const invalidatesBalance =
      result.kind === 'placed' ||
      result.kind === 'filled' ||
      result.kind === 'instant_filled' ||
      result.kind === 'partial_hold' ||
      result.kind === 'taker_placed';
    if (invalidatesBalance && upbitClient) {
      upbitClient.cache.invalidate();
    }
    if (invalidatesBalance) {
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

      case 'spread_cancelled':
        await (prisma.makerTakerSimTrade as any).update({
          where: { id: result.pendingId },
          data: {
            status: 'CANCELLED',
            notes:
              (pending?.notes ?? '') +
              ` | LIVE spread_cancelled (maker cancelled at ${new Date().toISOString()})`,
          },
        });
        return;

      case 'taker_placed': {
        const now = new Date();
        await (prisma.makerTakerSimTrade as any).update({
          where: { id: result.pendingId },
          data: {
            status: 'TAKER_PENDING',
            takerOrderUuid: result.takerOrderUuid,
            makerFilledAt: now,
            makerFilledPrice: Math.round(result.makerGrossKrw / Math.max(result.makerFilledQty, 1e-9)),
            // grossProfitKrw/feeKrw에 maker fill 데이터 임시 저장 (TAKER_PENDING 동안 P&L 계산용)
            grossProfitKrw: +result.makerGrossKrw.toFixed(4),
            feeKrw: +result.makerFeeKrw.toFixed(4),
            notes:
              (pending?.notes ?? '') +
              ` | LIVE taker ASK placed (uuid=${result.takerOrderUuid} price=${Math.round(result.makerGrossKrw / Math.max(result.makerFilledQty, 1e-9))} qty=${result.makerFilledQty.toFixed(8)})`,
          },
        });
        return;
      }

      case 'taker_expired': {
        const partialNote = result.partialFillKrw
          ? ` partial_fill=${result.partialFillQty}@${result.partialFillKrw}krw`
          : '';
        const makerGrossKrw = pending?.makerFilledGrossKrw ?? 0;
        const partialNetKrw =
          result.partialFillKrw != null && makerGrossKrw > 0
            ? +(result.partialFillKrw - makerGrossKrw - (result.partialFeeKrw ?? 0)).toFixed(4)
            : null;
        await (prisma.makerTakerSimTrade as any).update({
          where: { id: result.pendingId },
          data: {
            status: 'TAKER_EXPIRED',
            takerExecutedAt: new Date(),
            ...(partialNetKrw != null ? {
              grossProfitKrw: +(result.partialFillKrw! - makerGrossKrw).toFixed(4),
              feeKrw: +(result.partialFeeKrw ?? 0).toFixed(4),
              netProfitKrw: partialNetKrw,
            } : {}),
            notes:
              (pending?.notes ?? '') +
              ` | LIVE taker_expired (taker ASK cancelled at ${new Date().toISOString()})${partialNote}`,
          },
        });
        return;
      }

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

        // TAKER_PENDING 에서 온 경우 makerFilledAt/Price 는 이미 설정됨 — 덮어쓰지 않음
        const fromTakerPending = pending?.status === 'TAKER_PENDING';

        await (prisma.makerTakerSimTrade as any).update({
          where: { id: result.pendingId },
          data: {
            status: 'FILLED',
            ...(fromTakerPending ? {} : {
              makerFilledAt: now,
              makerFilledPrice: pending?.makerOrderPrice ?? null,
            }),
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

      case 'instant_filled': {
        const now = new Date();
        const grossProfitKrw = +(result.sellGrossKrw - result.buyGrossKrw).toFixed(4);
        const feeKrw = +result.paidFeeKrw.toFixed(4);
        const netProfitKrw = +result.netProfitKrw.toFixed(4);
        const avgSellPrice = Math.round(result.sellGrossKrw / Math.max(result.filledQty, 1e-9));
        await (prisma.makerTakerSimTrade as any).create({
          data: {
            botId: bot.id,
            makerCoin: bot.makerCoin,
            takerCoin: bot.takerCoin,
            quantity: result.filledQty,
            makerOrderPrice: result.avgBuyPrice,
            status: 'FILLED',
            live: true,
            legOrder: 'TAKER_SELL_FIRST',
            takerFirstCostKrw: result.sellGrossKrw,
            takerFirstFeeKrw: result.sellFeeKrw,
            makerFilledAt: now,
            makerFilledPrice: result.avgBuyPrice,
            takerExecutedAt: now,
            takerMarketBid: avgSellPrice,
            grossProfitKrw,
            feeKrw,
            netProfitKrw,
            realizedSpreadBps: result.realizedSpreadBps,
            notes: `LIVE INSTANT FILLED [TAKER_SELL_FIRST] sell=${result.sellGrossKrw.toFixed(2)} buy=${result.buyGrossKrw.toFixed(2)} fees=${feeKrw} net=${netProfitKrw}`,
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
