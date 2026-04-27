/**
 * Maker-Taker Live Executor (PR C 메인 모듈)
 *
 * 한 봇에 대한 한 사이클을 처리하는 순수 함수 (DB I/O 없음 — 호출자가 담당).
 *
 * 동작 개요:
 *  - CASE A (PENDING 트레이드 없음): 신규 maker bid limit 주문 (post_only)
 *  - CASE B (PENDING 존재): 주문 상태 폴링 후 분기
 *      - 미체결 + 만료 전 → waiting
 *      - 미체결 + 만료 → cancelOrder + expired
 *      - 체결 → 2단계 taker 실행 (X 매도 → Y 매수)
 *          - 양쪽 성공 → filled (P&L 계산)
 *          - X 매도 실패 → partial_hold (X 그대로 보유)
 *          - Y 매수 실패 → fallback X 재매수 → rolled_back
 *
 * 설계 원칙:
 *  - DB 접근 일절 없음 (순수 입력→출력)
 *  - OrderClient DI로 mock 가능 (PR B IocClient 패턴 차용)
 *  - bot.killSwitch 검사는 호출자(에이전트) 책임
 *  - 모든 결과는 7개 kind discriminated union으로 표현
 */

import type { OrderbookTop } from './upbit-price-manager';

/** Upbit 주문 응답 — executor가 읽는 필드만 추림. UpbitOrderResponse보다 좁다. */
export interface UpbitOrderResp {
  uuid: string;
  state?: string;
  executed_volume?: string;
  paid_fee?: string;
  trades?: Array<{ funds: string; price: string; volume: string }>;
}

/**
 * 주문 클라이언트 인터페이스 (DI). Task 4에서 UpbitService 메서드를 어댑터로 감싼다.
 * mock 단순화를 위해 의도적으로 좁은 시그니처.
 */
export interface OrderClient {
  placeLimit(
    market: string,
    side: 'bid' | 'ask',
    params: { price?: string; volume?: string; postOnly?: boolean },
  ): Promise<UpbitOrderResp>;
  placeBestIoc(
    market: string,
    side: 'bid' | 'ask',
    params: { price?: string; volume?: string },
  ): Promise<UpbitOrderResp>;
  getOrder(uuid: string): Promise<UpbitOrderResp>;
  cancelOrder(uuid: string): Promise<unknown>;
}

/** 봇 입력 (DB 모델의 일부) */
export type LiveBotInput = {
  id: number;
  userId: number;
  makerCoin: string;
  takerCoin: string;
  bidOffsetKrw: number;
  quantity: number;
  maxPendingMs: number;
  killSwitch: boolean;
};

/** 현재 PENDING 트레이드 스냅샷 (DB 모델의 일부) */
export type PendingTradeInput = {
  id: bigint;
  status: string;
  makerOrderUuid: string | null;
  makerOrderPrice: number;
  createdAt: Date;
  notes: string | null;
};

/** 결과 — discriminated union (7 kinds) */
export type LiveExecutorResult =
  | { kind: 'noop' }
  | { kind: 'placed'; makerOrderUuid: string; makerOrderPrice: number }
  | { kind: 'waiting'; pendingId: bigint }
  | { kind: 'expired'; pendingId: bigint }
  | {
      kind: 'filled';
      pendingId: bigint;
      filledQty: number;
      filledMakerKrw: number;
      filledSellKrw: number;
      filledBuyKrw: number;
      paidFeeKrw: number;
      netProfitKrw: number;
      realizedSpreadBps: number;
    }
  | { kind: 'partial_hold'; pendingId: bigint; reason: string }
  | { kind: 'rolled_back'; pendingId: bigint; reason: string };

export type ProcessLiveInput = {
  bot: LiveBotInput;
  pending: PendingTradeInput | null;
  books: ReadonlyMap<string, OrderbookTop>;
  client: OrderClient;
  isLocked: () => boolean;
  preCheckOk: boolean;
};

/** trades 배열의 funds 합산 */
function sumFunds(trades: UpbitOrderResp['trades']): number {
  return (trades || []).reduce((s, t) => s + parseFloat(t.funds), 0);
}

/**
 * 한 사이클 처리.
 * 사전 조건 (호출자 보장):
 *  - bot.killSwitch === false (호출자가 필터)
 *  - books는 upbit-price-manager에서 받은 최신 스냅샷
 *  - pending은 DB에서 조회한 현재 PENDING 트레이드 (없으면 null)
 */
export async function processLiveBot(
  input: ProcessLiveInput,
): Promise<LiveExecutorResult> {
  const { bot, pending, books, client, isLocked, preCheckOk } = input;

  // ===== CASE A: PENDING 없음 → 신규 maker bid limit 주문 =====
  if (pending === null) {
    if (isLocked()) return { kind: 'noop' };
    if (!preCheckOk) return { kind: 'noop' };

    const makerMarket = `KRW-${bot.makerCoin}`;
    const makerBook = books.get(makerMarket);
    if (!makerBook) return { kind: 'noop' };

    const makerOrderPrice = makerBook.bid.price + bot.bidOffsetKrw;

    const resp = await client.placeLimit(makerMarket, 'bid', {
      price: String(makerOrderPrice),
      volume: String(bot.quantity),
      postOnly: true,
    });

    if (!resp.uuid) return { kind: 'noop' };

    return {
      kind: 'placed',
      makerOrderUuid: resp.uuid,
      makerOrderPrice,
    };
  }

  // ===== CASE B: PENDING 존재 → 주문 폴링 후 분기 =====
  if (pending.makerOrderUuid === null) {
    // 방어: live PENDING은 항상 uuid를 가져야 함
    return { kind: 'waiting', pendingId: pending.id };
  }

  const status = await client.getOrder(pending.makerOrderUuid);
  const filledQty = parseFloat(status.executed_volume || '0');
  const elapsed = Date.now() - pending.createdAt.getTime();

  // ----- 체결됨 (full or partial) → 2단계 taker -----
  if (filledQty > 0) {
    const filledMakerKrw = sumFunds(status.trades);
    const paidFeeMaker = parseFloat(status.paid_fee || '0');

    // 방어: executed_volume>0인데 trades funds 합이 0인 비정상 응답.
    // 이대로 P&L 진입하면 realizedSpreadBps에서 0 분모 → Infinity 발생.
    // Task 4 DB persist 시 DECIMAL/INT 컬럼이 거부하므로 사전에 차단.
    if (filledMakerKrw === 0) {
      return {
        kind: 'partial_hold',
        pendingId: pending.id,
        reason: 'maker filled but trades funds = 0 (defensive)',
      };
    }

    // Stage 1: maker 코인을 즉시 시장가로 매도 (X 매도)
    const sellResp = await client.placeBestIoc(
      `KRW-${bot.makerCoin}`,
      'ask',
      { volume: String(filledQty) },
    );
    const filledSellQty = parseFloat(sellResp.executed_volume || '0');
    if (filledSellQty === 0) {
      return {
        kind: 'partial_hold',
        pendingId: pending.id,
        reason: 'maker filled, taker sell failed, holding X',
      };
    }
    const filledSellKrw = sumFunds(sellResp.trades);
    const paidFeeSell = parseFloat(sellResp.paid_fee || '0');

    // Stage 2: 받은 KRW로 taker 코인 매수 (Y 매수)
    const buyKrw = filledSellKrw - paidFeeSell;
    const buyResp = await client.placeBestIoc(
      `KRW-${bot.takerCoin}`,
      'bid',
      { price: String(Math.floor(buyKrw)) },
    );
    const filledBuyQty = parseFloat(buyResp.executed_volume || '0');
    if (filledBuyQty === 0) {
      // Stage 3 (fallback): 받은 KRW로 X 재매수 (best-effort 복구)
      await client.placeBestIoc(
        `KRW-${bot.makerCoin}`,
        'bid',
        { price: String(Math.floor(buyKrw)) },
      );
      return {
        kind: 'rolled_back',
        pendingId: pending.id,
        reason: 'taker buy failed, recovered to X',
      };
    }
    const filledBuyKrw = sumFunds(buyResp.trades);
    const paidFeeBuy = parseFloat(buyResp.paid_fee || '0');

    // P&L 계산
    const paidFeeKrw = paidFeeMaker + paidFeeSell + paidFeeBuy;
    const netProfitKrw = filledSellKrw - filledMakerKrw - paidFeeKrw;
    const realizedSpreadBps = Math.floor(
      (filledSellKrw / filledMakerKrw - 1) * 10000,
    );

    return {
      kind: 'filled',
      pendingId: pending.id,
      filledQty,
      filledMakerKrw,
      filledSellKrw,
      filledBuyKrw,
      paidFeeKrw,
      netProfitKrw,
      realizedSpreadBps,
    };
  }

  // ----- 미체결: 만료 여부에 따라 expired or waiting -----
  if (elapsed > bot.maxPendingMs) {
    await client.cancelOrder(pending.makerOrderUuid);
    return { kind: 'expired', pendingId: pending.id };
  }

  return { kind: 'waiting', pendingId: pending.id };
}
