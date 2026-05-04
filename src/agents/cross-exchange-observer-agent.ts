import { BaseAgent } from './base-agent';
import { getAllStablecoinOrderbooks, OrderbookTop } from '../services/upbit-price-manager';
import { fetchBithumbOrderbooks } from '../services/bithumb-price-manager';
import {
  subscribeBithumbStablecoinOrderbooks,
  unsubscribeBithumbStablecoinOrderbooks,
  getAllBithumbStablecoinOrderbooks,
} from '../services/bithumb-stablecoin-ws-manager';
import prisma from '../config/database';
import { stablecoinPrisma } from '../config/database';

/** 관찰 대상 스테이블코인 심볼 목록 */
const OBSERVATION_SYMBOLS = ['USDT', 'USDC', 'USDS', 'USD1', 'USDE'];

/** 폴링 간격 (10초) */
const CYCLE_INTERVAL_MS = 10_000;

/** 자동 봇 생성: N회 연속 감지 기준 (6회 = 60초) */
const AUTO_BOT_CONSECUTIVE_THRESHOLD = 6;

/** 자동 봇 생성 트리거 최소 스프레드 (bps) */
const AUTO_BOT_MIN_SPREAD_BPS = 10;

/** 자동 봇 생성 시 기본 수량 */
const AUTO_BOT_DEFAULT_QUANTITY = 20;

/** 자동 봇 생성 시 할당할 시스템 userId (관리자) */
const AUTO_BOT_SYSTEM_USER_ID = 1;

type BithumbBook = { bid: number; ask: number };

/**
 * Upbit-Bithumb 크로스-거래소 관찰 에이전트.
 *
 * 마트 가격 비교 앱에 비유하면: A마트(Upbit)와 B마트(Bithumb)에서
 * 5가지 상품(스테이블코인) 가격을 10초마다 비교하고,
 * 60초 이상 차익이 발생하는 조합이 있으면 자동으로 봇을 등록한다.
 *
 * - 동종 코인 5개: DB 스냅샷 저장 (기존 동작 유지)
 * - 이종 코인 50조합: 내부 계산만 (저장 없음). 임계치 초과 시 봇 자동 생성
 * - Bithumb 호가: WS 캐시 우선, 심볼별 REST fallback
 */
export class CrossExchangeObserverAgent extends BaseAgent {
  /** 연속 스프레드 카운터: "buyCoin→sellCoin:방향" → 연속 횟수 */
  private readonly consecutiveHits = new Map<string, number>();

  constructor() {
    super({
      id: 'cross-exchange-observer',
      name: 'CrossExchangeObserverAgent',
      description: 'Upbit-Bithumb 크로스-거래소 스테이블코인 호가 관찰 (10초 간격)',
      cycleIntervalMs: CYCLE_INTERVAL_MS,
    });
  }

  protected async onStart(): Promise<void> {
    subscribeBithumbStablecoinOrderbooks();
    console.log('[CrossExchangeObserver] 시작 — Bithumb WS 구독 + 10초 간격 관찰');
  }

  protected async onStop(): Promise<void> {
    unsubscribeBithumbStablecoinOrderbooks();
    this.consecutiveHits.clear();
    console.log('[CrossExchangeObserver] 정지 — Bithumb WS 구독 해제');
  }

  protected async onCycle(): Promise<void> {
    // Upbit WebSocket 캐시 조회
    const upbitBooks = getAllStablecoinOrderbooks();
    if (upbitBooks.size === 0) return;

    // Bithumb 호가 조회 (WS 캐시 우선, REST fallback)
    const bithumbBooks = await this.resolveBithumbBooks();
    if (bithumbBooks.size === 0) {
      console.warn('[CrossExchangeObserver] Bithumb 조회 전체 실패 — cycle skip');
      return;
    }

    const now = new Date();
    await this.saveSnapshots(upbitBooks, bithumbBooks, now);
    await this.checkAllCrossPairs(upbitBooks, bithumbBooks);
  }

  /**
   * Bithumb 호가 조회: WS 캐시 우선, 없는 심볼만 REST fallback.
   * 비유: 편의점 앱 재고를 먼저 확인하고, 없으면 직접 전화로 확인.
   */
  private async resolveBithumbBooks(): Promise<Map<string, BithumbBook>> {
    const result = new Map<string, BithumbBook>();
    const wsBooks = getAllBithumbStablecoinOrderbooks();
    const missingSymbols: string[] = [];

    for (const symbol of OBSERVATION_SYMBOLS) {
      const ws = wsBooks.get(symbol);
      if (ws) {
        result.set(symbol, { bid: ws.bid, ask: ws.ask });
      } else {
        missingSymbols.push(symbol);
      }
    }

    if (missingSymbols.length > 0) {
      const restBooks = await fetchBithumbOrderbooks(missingSymbols);
      for (const [symbol, book] of restBooks) {
        result.set(symbol, { bid: book.bid, ask: book.ask });
      }
    }

    return result;
  }

  /** 동종 코인 5개 스냅샷 저장 — 기존 동작 유지 */
  private async saveSnapshots(
    upbitBooks: ReadonlyMap<string, OrderbookTop>,
    bithumbBooks: Map<string, BithumbBook>,
    now: Date,
  ): Promise<void> {
    const rows: Array<{
      timestamp: Date;
      market: string;
      upbitBid: number;
      upbitAsk: number;
      bithumbBid: number;
      bithumbAsk: number;
      ubSpreadBps: number;
      buSpreadBps: number;
      maxSpreadBps: number;
    }> = [];

    for (const symbol of OBSERVATION_SYMBOLS) {
      const upbit = upbitBooks.get(`KRW-${symbol}`);
      const bithumb = bithumbBooks.get(symbol);
      if (!upbit || !bithumb) continue;

      const ubSpreadBps = Math.floor((upbit.bid.price / bithumb.ask - 1) * 10000);
      const buSpreadBps = Math.floor((bithumb.bid / upbit.ask.price - 1) * 10000);

      rows.push({
        timestamp: now,
        market: symbol,
        upbitBid: upbit.bid.price,
        upbitAsk: upbit.ask.price,
        bithumbBid: bithumb.bid,
        bithumbAsk: bithumb.ask,
        ubSpreadBps,
        buSpreadBps,
        maxSpreadBps: Math.max(ubSpreadBps, buSpreadBps),
      });
    }

    if (rows.length === 0) return;

    try {
      await prisma.crossExchangeSnapshot.createMany({ data: rows });
    } catch (err: any) {
      this.metrics.errors++;
      this.metrics.lastError = err.message;
      console.error('[CrossExchangeObserver] DB 저장 실패:', err.message);
    }
  }

  /**
   * 5×5×2 = 50가지 크로스-코인 조합 스프레드 계산.
   * AUTO_BOT_CONSECUTIVE_THRESHOLD 회 연속 스프레드 발생 시 봇 자동 생성.
   *
   * UB: Upbit에서 buyCoin 매수(ask) → Bithumb에서 sellCoin 매도(bid)
   *   spreadBps = (bithumbBid[sellCoin] / upbitAsk[buyCoin] - 1) * 10000
   *
   * BU: Bithumb에서 buyCoin 매수(ask) → Upbit에서 sellCoin 매도(bid)
   *   spreadBps = (upbitBid[sellCoin] / bithumbAsk[buyCoin] - 1) * 10000
   */
  private async checkAllCrossPairs(
    upbitBooks: ReadonlyMap<string, OrderbookTop>,
    bithumbBooks: Map<string, BithumbBook>,
  ): Promise<void> {
    for (const buyCoin of OBSERVATION_SYMBOLS) {
      for (const sellCoin of OBSERVATION_SYMBOLS) {
        for (const direction of ['UB', 'BU'] as const) {
          let spreadBps: number;

          if (direction === 'UB') {
            const upbit = upbitBooks.get(`KRW-${buyCoin}`);
            const bithumb = bithumbBooks.get(sellCoin);
            if (!upbit || !bithumb) continue;
            spreadBps = Math.floor((bithumb.bid / upbit.ask.price - 1) * 10000);
          } else {
            const bithumb = bithumbBooks.get(buyCoin);
            const upbit = upbitBooks.get(`KRW-${sellCoin}`);
            if (!upbit || !bithumb) continue;
            spreadBps = Math.floor((upbit.bid.price / bithumb.ask - 1) * 10000);
          }

          const key = `${buyCoin}→${sellCoin}:${direction}`;

          if (spreadBps >= AUTO_BOT_MIN_SPREAD_BPS) {
            const prev = this.consecutiveHits.get(key) ?? 0;
            // 임계치에 도달하면 cap하여 동일 streak에서 중복 생성 방지
            const count = Math.min(prev + 1, AUTO_BOT_CONSECUTIVE_THRESHOLD + 1);
            this.consecutiveHits.set(key, count);

            if (count === AUTO_BOT_CONSECUTIVE_THRESHOLD) {
              await this.autoCreateBot(buyCoin, sellCoin, direction, spreadBps);
            }
          } else {
            this.consecutiveHits.delete(key);
          }
        }
      }
    }
  }

  /** 중복 확인 후 봇 자동 생성 (enabled=false, 사용자가 수동 활성화) */
  private async autoCreateBot(
    buyCoin: string,
    sellCoin: string,
    direction: 'UB' | 'BU',
    spreadBps: number,
  ): Promise<void> {
    try {
      const existing = await stablecoinPrisma.crossExchangeArbBot.findMany({
        where: { targetDirection: direction },
        select: { coin: true, buyCoin: true, sellCoin: true },
      });

      const duplicate = existing.some(
        (bot) =>
          (bot.buyCoin ?? bot.coin) === buyCoin &&
          (bot.sellCoin ?? bot.coin) === sellCoin,
      );

      if (duplicate) return;

      await stablecoinPrisma.crossExchangeArbBot.create({
        data: {
          userId: AUTO_BOT_SYSTEM_USER_ID,
          coin: buyCoin,
          buyCoin,
          sellCoin,
          targetDirection: direction,
          quantity: AUTO_BOT_DEFAULT_QUANTITY,
          enabled: false,
        },
      });

      console.log(
        `[CrossExchangeObserver] 자동 봇 생성: ${buyCoin}→${sellCoin} ${direction}` +
        ` (스프레드 ${spreadBps}bps, ${AUTO_BOT_CONSECUTIVE_THRESHOLD}회 연속 감지)`,
      );
    } catch (err: any) {
      this.metrics.errors++;
      this.metrics.lastError = err.message;
      console.error('[CrossExchangeObserver] 자동 봇 생성 실패:', err.message);
    }
  }
}
