import { BaseAgent } from './base-agent';
import { getAllStablecoinOrderbooks } from '../services/upbit-price-manager';
import { fetchBithumbOrderbooks } from '../services/bithumb-price-manager';
import prisma from '../config/database';

/** 관찰 대상 스테이블코인 심볼 목록 */
const OBSERVATION_SYMBOLS = ['USDT', 'USDC', 'USDS', 'USD1', 'USDE'];

/** 폴링 간격 (10초) */
const CYCLE_INTERVAL_MS = 10_000;

/**
 * Upbit-Bithumb 크로스-거래소 관찰 에이전트.
 *
 * 식당에 비유하면: 두 식당(Upbit, Bithumb)의 메뉴판 가격을
 * 10초마다 사진 찍어 기록하는 관찰자 역할.
 *
 * 기술적으로는 10초마다 양 거래소의 5종 스테이블코인 호가 스냅샷을
 * CrossExchangeSnapshot 테이블에 저장한다.
 * 주문 없음 — 순수 관찰·기록 전용.
 */
export class CrossExchangeObserverAgent extends BaseAgent {
  constructor() {
    super({
      id: 'cross-exchange-observer',
      name: 'CrossExchangeObserverAgent',
      description: 'Upbit-Bithumb 크로스-거래소 스테이블코인 호가 관찰 (10초 간격)',
      cycleIntervalMs: CYCLE_INTERVAL_MS,
    });
  }

  protected async onStart(): Promise<void> {
    console.log('[CrossExchangeObserver] 시작 — 10초마다 Upbit+Bithumb 호가 비교');
  }

  protected async onStop(): Promise<void> {
    console.log('[CrossExchangeObserver] 정지');
  }

  /**
   * 매 사이클(10초)마다 실행:
   * 1. Upbit 호가 캐시 조회 (WebSocket에서 수신한 메모리 캐시)
   * 2. Bithumb 호가 REST 조회
   * 3. 스프레드(bps) 계산 후 DB 저장
   *
   * ubSpreadBps: Upbit에서 팔고(bid) Bithumb에서 사는(ask) 경우 이익 정도
   *   = (upbit_bid / bithumb_ask - 1) * 10000
   * buSpreadBps: Bithumb에서 팔고(bid) Upbit에서 사는(ask) 경우 이익 정도
   *   = (bithumb_bid / upbit_ask - 1) * 10000
   */
  protected async onCycle(): Promise<void> {
    // Upbit WebSocket 캐시 조회 (StablecoinArbAgent가 WS 구독 중이면 최신값)
    const upbitBooks = getAllStablecoinOrderbooks();

    if (upbitBooks.size === 0) {
      // WebSocket 연결 전 초기 상태 — 데이터 없으면 스킵
      return;
    }

    // Bithumb REST 순차 조회
    const bithumbBooks = await fetchBithumbOrderbooks(OBSERVATION_SYMBOLS);

    if (bithumbBooks.size === 0) {
      console.warn('[CrossExchangeObserver] Bithumb 조회 전체 실패 — cycle skip');
      return;
    }

    const now = new Date();

    // 각 심볼별 스냅샷 행 생성
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

      // 어느 한쪽이라도 데이터 없으면 해당 심볼 스킵 (에러 격리)
      if (!upbit || !bithumb) continue;

      // 스프레드 계산 (bps = basis points, 1bp = 0.01%)
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
      // createMany — 한 사이클 전체를 원자적으로 저장
      await prisma.crossExchangeSnapshot.createMany({ data: rows });
    } catch (err: any) {
      this.metrics.errors++;
      this.metrics.lastError = err.message;
      console.error('[CrossExchangeObserver] DB 저장 실패:', err.message);
    }
  }
}
