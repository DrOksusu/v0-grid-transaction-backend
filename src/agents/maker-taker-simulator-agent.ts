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
  getBithumbOrderbookForTrading,
} from '../services/bithumb-stablecoin-ws-manager';
import { stablecoinPrisma as prisma } from '../config/database';
import mainPrisma from '../config/database';
import {
  shouldFill,
  shouldFillAsk,
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
  return { bid: book.bid.price, bidQty: book.bid.size, ask: book.ask.price, askQty: book.ask.size };
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

/** 동일 봇 연속 재발화 방지 쿨다운 (ms) */
const INSTANT_FILL_COOLDOWN_MS = 10_000;

export class MakerTakerSimulatorAgent extends BaseAgent {
  private unsubscribe: (() => void) | null = null;
  private evaluateInFlight = false;
  private upbitClients = new Map<number, { upbit: UpbitService; cache: BalanceCache }>();
  private bithumbClients = new Map<number, BithumbClient>();
  private bithumbBalanceCaches = new Map<number, { data: Record<string, number>; at: number }>();
  /** 연속 재발화 방지: botId → 마지막 발화 시각(ms) */
  private recentlyFiredBots = new Map<number, number>();

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

      // live 봇: 매수 잔고 오름차순 정렬 (잔고 가장 적은 코인 우선 매수)
      const sortedBots = [
        ...bots.filter((b: any) => b.live).sort((a: any, b: any) =>
          this.getBuyBalance(a, upbitBooks) - this.getBuyBalance(b, upbitBooks),
        ),
        ...bots.filter((b: any) => !b.live),
      ];

      for (const bot of sortedBots) {
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
      const direction = decideLegOrder(makerNorm, takerNorm, bot.sellStrategy ?? 'TAKER_SELL_FIRST');

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
      } else if (direction === 'MAKER_SELL_FIRST') {
        const gate = isCrossSpreadProfitable(makerNorm, takerNorm, 'MAKER_SELL_FIRST', bot.minSpreadBps, bot.bidOffsetKrw);
        if (!gate.ok) return;

        const makerOrderPrice = makerNorm.ask - bot.bidOffsetKrw;
        await (prisma.makerTakerSimTrade as any).create({
          data: {
            botId: bot.id,
            makerCoin: bot.makerCoin,
            takerCoin: bot.takerCoin,
            makerOrderPrice,
            quantity: bot.quantity,
            status: 'PENDING',
            legOrder: 'MAKER_SELL_FIRST',
            notes: `생성[MAKER_SELL_FIRST]: makerAsk=${makerNorm.ask}, takerAsk=${takerNorm.ask}, spread=${gate.spreadBps}bp`,
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
    const orderParams = {
      makerOrderPrice: pending.makerOrderPrice,
      createdAt: pending.createdAt,
      maxPendingMs: bot.maxPendingMs,
    };
    let decision: ReturnType<typeof shouldFill>;
    if (legOrder === 'MAKER_SELL_FIRST') {
      decision = shouldFillAsk(orderParams, makerBook, now);
    } else {
      const bookForFill = legOrder === 'TAKER_SELL_FIRST' ? takerBook : makerBook;
      decision = shouldFill(orderParams, bookForFill, now);
    }

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

    if (legOrder === 'MAKER_SELL_FIRST') {
      // makerCoin ASK 체결가(makerOrderPrice)로 받은 KRW → takerCoin 현재 ask로 매수
      const qty = Number(bot.quantity);
      const makerSellKrw = pending.makerOrderPrice * qty;
      const makerFee = (makerSellKrw * bot.makerFeeBps) / 10000;
      const takerBuyPrice = takerNorm.ask;
      const takerBuyKrw = takerBuyPrice * qty;
      const takerFee = (takerBuyKrw * bot.takerFeeBps) / 10000;
      const feeKrw = makerFee + takerFee;
      const grossProfitKrw = makerSellKrw - takerBuyKrw;
      const netProfitKrw = grossProfitKrw - feeKrw;
      const realizedSpreadBps =
        takerBuyKrw > 0
          ? Math.floor(((makerSellKrw - takerBuyKrw) / takerBuyKrw) * 10000)
          : 0;

      await (prisma.makerTakerSimTrade as any).update({
        where: { id: pending.id },
        data: {
          status: 'FILLED',
          makerFilledAt: now,
          makerFilledPrice: pending.makerOrderPrice,
          takerExecutedAt: now,
          takerMarketBid: Math.round(takerBuyKrw / Math.max(qty, 1e-9)),
          grossProfitKrw,
          feeKrw,
          netProfitKrw,
          realizedSpreadBps,
          notes:
            (pending.notes ?? '') +
            ` | FILLED[MAKER_SELL_FIRST] makerSell=${makerSellKrw.toFixed(2)} takerBuy=${takerBuyKrw.toFixed(2)} net=${netProfitKrw.toFixed(2)}`,
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
   * 이번 사이클에 이 봇이 매수할 코인의 현재 잔고를 캐시에서 동기로 조회.
   * 잔고가 작을수록 먼저 처리해 포트폴리오 자동 리밸런싱.
   * 캐시 없으면 Infinity 반환(우선순위 후순위).
   */
  private getBuyBalance(bot: any, upbitBooks: ReadonlyMap<string, OrderbookTop>): number {
    const makerExchange: string = bot.makerExchange ?? 'upbit';
    const takerExchange: string = bot.takerExchange ?? 'upbit';

    const makerBookRaw = makerExchange === 'bithumb'
      ? getBithumbStablecoinOrderbook(bot.makerCoin)
      : upbitBooks.get(`KRW-${bot.makerCoin}`);
    const takerBookRaw = takerExchange === 'bithumb'
      ? getBithumbStablecoinOrderbook(bot.takerCoin)
      : upbitBooks.get(`KRW-${bot.takerCoin}`);

    if (!makerBookRaw || !takerBookRaw) return Infinity;

    const makerBid = makerExchange === 'bithumb'
      ? (makerBookRaw as any).bid
      : (makerBookRaw as OrderbookTop).bid.price;
    const makerAsk = makerExchange === 'bithumb'
      ? (makerBookRaw as any).ask
      : (makerBookRaw as OrderbookTop).ask.price;
    const takerBid = takerExchange === 'bithumb'
      ? (takerBookRaw as any).bid
      : (takerBookRaw as OrderbookTop).bid.price;
    const takerAsk = takerExchange === 'bithumb'
      ? (takerBookRaw as any).ask
      : (takerBookRaw as OrderbookTop).ask.price;

    const direction = decideLegOrder(
      { bid: makerBid, ask: makerAsk },
      { bid: takerBid, ask: takerAsk },
      bot.sellStrategy ?? 'TAKER_SELL_FIRST',
    );

    // TAKER_SELL_FIRST / MAKER_SELL_FIRST → takerCoin 매수
    // MAKER_BUY_FIRST → makerCoin 매수
    const [buyCoin, buyExchange] = direction === 'MAKER_BUY_FIRST'
      ? [bot.makerCoin as string, makerExchange]
      : [bot.takerCoin as string, takerExchange];

    if (buyExchange === 'upbit') {
      return this.upbitClients.get(bot.userId)?.cache.peek()?.[buyCoin] ?? Infinity;
    } else {
      const cache = this.bithumbBalanceCaches.get(bot.userId);
      if (!cache) return Infinity;
      return cache.data[buyCoin] ?? 0;
    }
  }

  /**
   * live=true 봇 처리. 크로스 거래소 지원.
   */
  private async handleLiveBot(
    bot: any,
    upbitBooks: ReadonlyMap<string, OrderbookTop>,
  ): Promise<void> {
    if (bot.killSwitch) return;

    // 10초 쿨다운 — WS 이벤트 연속 발화로 인한 중복 진입 방지
    const lastFired = this.recentlyFiredBots.get(bot.id);
    if (lastFired && Date.now() - lastFired < INSTANT_FILL_COOLDOWN_MS) return;
    // async 시작 전 즉시 등록 — await 중 다른 WS 이벤트가 쿨다운을 우회하는 race condition 방지
    this.recentlyFiredBots.set(bot.id, Date.now());

    const makerExchange: string = bot.makerExchange ?? 'upbit';
    const takerExchange: string = bot.takerExchange ?? 'upbit';

    // 거래 결정용 호가 조회: Bithumb은 10초 freshness 임계 적용 (stale 데이터로 게이트 우회 방지)
    const makerBookRaw =
      makerExchange === 'bithumb'
        ? getBithumbOrderbookForTrading(bot.makerCoin)
        : upbitBooks.get(`KRW-${bot.makerCoin}`);
    const takerBookRaw =
      takerExchange === 'bithumb'
        ? getBithumbOrderbookForTrading(bot.takerCoin)
        : upbitBooks.get(`KRW-${bot.takerCoin}`);

    if (!makerBookRaw || !takerBookRaw) {
      if (!makerBookRaw) console.log(`[MakerTakerSimulatorAgent] bot ${bot.id} ${makerExchange} ${bot.makerCoin} 호가 stale — 스킵`);
      if (!takerBookRaw) console.log(`[MakerTakerSimulatorAgent] bot ${bot.id} ${takerExchange} ${bot.takerCoin} 호가 stale — 스킵`);
      // 호가 stale이어도 만료된 pending trade는 강제 처리 (주문 취소 + EXPIRED 전환)
      await this.forceExpireOverduePending(bot);
      return;
    }

    const makerBook: NormalizedBook =
      makerExchange === 'bithumb'
        ? { bid: (makerBookRaw as any).bid, bidQty: (makerBookRaw as any).bidQty, ask: (makerBookRaw as any).ask, askQty: (makerBookRaw as any).askQty }
        : normalizeUpbit(makerBookRaw as OrderbookTop);
    const takerBook: NormalizedBook =
      takerExchange === 'bithumb'
        ? { bid: (takerBookRaw as any).bid, ask: (takerBookRaw as any).ask, askQty: (takerBookRaw as any).askQty }
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
          // TAKER_PENDING 재주문용 — takerMarketBid에 임시 저장된 목표 ASK가
          takerAskPrice:
            pending.status === 'TAKER_PENDING' && pending.takerMarketBid != null
              ? Number(pending.takerMarketBid)
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
      const direction = decideLegOrder(makerBook, takerBook, bot.sellStrategy ?? 'TAKER_SELL_FIRST');

      // 스프레드 게이트: 거래소 조합에 무관하게 항상 먼저 체크
      const gate = isCrossSpreadProfitable(makerBook, takerBook, direction, bot.minSpreadBps, direction === 'MAKER_SELL_FIRST' ? bot.bidOffsetKrw : 0);
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
      } else if (preCheckOk && (direction === 'TAKER_SELL_FIRST' || direction === 'MAKER_SELL_FIRST') && upbitClient && makerExchange === 'upbit') {
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
            `[MakerTakerSimulatorAgent] bot ${bot.id} ${direction} pre-check: makerCoin 잔고 부족 (${makerCoinBalance} < ${bot.quantity})`,
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
          if ((direction === 'TAKER_SELL_FIRST' || direction === 'MAKER_SELL_FIRST') && makerExchange === 'bithumb') {
            const available = bithumbAvail[bot.makerCoin] ?? 0;
            if (available < Number(bot.quantity)) {
              console.log(
                `[MakerTakerSimulatorAgent] bot ${bot.id} Bithumb ${direction} 잔고 부족: ${bot.makerCoin} available=${available.toFixed(4)} < quantity=${bot.quantity}`,
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
      takerFeeBps: bot.takerFeeBps ?? 5,
      sellStrategy: bot.sellStrategy ?? 'TAKER_SELL_FIRST',
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
      result.kind === 'partial_hold' ||
      result.kind === 'taker_placed';
    if (invalidatesBalance && upbitClient) {
      upbitClient.cache.invalidate();
    }
    if (invalidatesBalance) {
      this.bithumbBalanceCaches.delete(bot.userId);
    }

    await this.persistLiveResult(bot, pending, result);

    // 쿨다운 등록은 async 시작 전(line 377)에서 처리 — 여기서 중복 등록 불필요
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
            // TAKER_PENDING 중 taker ASK 주문가 임시 저장 — FILLED 시 실제 체결가로 덮어씌워짐
            takerMarketBid: result.takerAskPrice,
            // grossProfitKrw/feeKrw에 maker fill 데이터 임시 저장 (TAKER_PENDING 동안 P&L 계산용)
            grossProfitKrw: +result.makerGrossKrw.toFixed(4),
            feeKrw: +result.makerFeeKrw.toFixed(4),
            notes:
              (pending?.notes ?? '') +
              (result.legOrder === 'MAKER_SELL_FIRST'
                ? ` | LIVE MAKER_SELL_FIRST Leg2 BID placed (uuid=${result.takerOrderUuid} bid=${result.takerAskPrice} sell=${Math.round(result.makerGrossKrw / Math.max(result.makerFilledQty, 1e-9))} qty=${result.makerFilledQty.toFixed(8)})`
                : ` | LIVE taker ASK placed (uuid=${result.takerOrderUuid} price=${Math.round(result.makerGrossKrw / Math.max(result.makerFilledQty, 1e-9))} qty=${result.makerFilledQty.toFixed(8)})`),
          },
        });
        return;
      }

      case 'taker_requeued': {
        await (prisma.makerTakerSimTrade as any).update({
          where: { id: result.pendingId },
          data: {
            takerOrderUuid: result.newTakerOrderUuid,
            makerFilledAt: new Date(), // 타이머 리셋 — 새 maxPendingMs 카운트다운 시작
            notes:
              (pending?.notes ?? '') +
              ` | taker_requeued(ask=${result.takerAskPrice}) at ${new Date().toISOString()}`,
          },
        });
        console.log(
          `[MakerTakerSimulatorAgent] bot ${bot.id} #${result.pendingId} TAKER_PENDING 재주문 (uuid=${result.newTakerOrderUuid} ask=${result.takerAskPrice})`,
        );
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
              // makerFilledPrice = "매수가" (UI buyPriceKrw)
              // TAKER_SELL_FIRST:  takerCoin BID 체결 단가 (filledMakerKrw ÷ filledQty)
              // MAKER_SELL_FIRST:  takerCoin IOC 매수 단가 (filledMakerKrw ÷ buyFilledQty) — 실제 매수 수량 기준
              // MAKER_BUY_FIRST:   makerCoin BID 주문가 (makerOrderPrice)
              makerFilledPrice: legOrder === 'MAKER_SELL_FIRST'
                ? Math.round(result.filledMakerKrw / Math.max(result.buyFilledQty ?? result.filledQty, 1e-9))
                : legOrder === 'TAKER_SELL_FIRST'
                  ? Math.round(result.filledMakerKrw / Math.max(result.filledQty, 1e-9))
                  : (pending?.makerOrderPrice ?? null),
            }),
            takerExecutedAt: now,
            // takerMarketBid = "매도가" (UI sellPriceKrw)
            // TAKER_SELL_FIRST:  makerCoin IOC 매도가 (filledSellKrw ÷ qty)
            // MAKER_SELL_FIRST:  makerCoin ASK 체결가 (filledSellKrw ÷ qty)
            // MAKER_BUY_FIRST:   takerCoin ASK 체결가 (filledSellKrw ÷ qty)
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

  /**
   * 호가 stale 등으로 정상 경로가 막혔을 때 만료된 pending trade를 강제 EXPIRED로 전환.
   * 주문 취소 후 DB 업데이트. 체결 race condition은 무시 (stale 상황이므로 안전 우선).
   */
  private async forceExpireOverduePending(bot: any): Promise<void> {
    const pending = await (prisma.makerTakerSimTrade as any).findFirst({
      where: { botId: bot.id, status: { in: ['PENDING', 'TAKER_PENDING'] }, live: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!pending) return;

    const elapsed = Date.now() - pending.createdAt.getTime();
    if (elapsed <= bot.maxPendingMs) return;

    const elapsedMin = Math.floor(elapsed / 60_000);
    console.log(`[MakerTakerSimulatorAgent] bot ${bot.id} 호가 stale 중 overdue pending #${pending.id} (${elapsedMin}min) → force-expire`);

    // 주문 취소 시도 (이미 만료/취소됐을 수 있으므로 오류 무시)
    try {
      const makerExchange: string = bot.makerExchange ?? 'upbit';
      const takerExchange: string = bot.takerExchange ?? 'upbit';
      const legOrder: string = pending.legOrder ?? 'MAKER_BUY_FIRST';
      // TAKER_SELL_FIRST pending: 주문이 takerLeg에 있음
      const cancelOnExchange = legOrder === 'TAKER_SELL_FIRST' ? takerExchange : makerExchange;
      if (cancelOnExchange === 'upbit') {
        const c = await this.getUpbitClientFor(bot.userId);
        await c.upbit.cancelOrder(pending.makerOrderUuid);
      } else {
        const c = await this.getBithumbClientFor(bot.userId);
        await c.cancelOrder(pending.makerOrderUuid);
      }
    } catch {
      // 이미 취소됐거나 체결 — 무시
    }

    await (prisma.makerTakerSimTrade as any).update({
      where: { id: pending.id },
      data: {
        status: 'EXPIRED',
        notes: (pending.notes ?? '') + ` | force-expired: stale orderbook after ${Math.floor(elapsed / 60_000)}min`,
      },
    });
  }
}
