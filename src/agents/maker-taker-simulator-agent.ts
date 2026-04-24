import { BaseAgent } from './base-agent';
import {
  subscribeStablecoinOrderbooks,
  unsubscribeStablecoinOrderbooks,
  getAllStablecoinOrderbooks,
  onStablecoinOrderbookUpdate,
  type OrderbookTop,
} from '../services/upbit-price-manager';
import { stablecoinPrisma as prisma } from '../config/database';
import {
  shouldFill,
  simulateTakerLeg,
  isAbort,
} from '../services/maker-taker-simulator.service';

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
          notes: `생성: makerBid=${makerBook.bid.price}, offset=${bot.bidOffsetKrw}`,
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
}
