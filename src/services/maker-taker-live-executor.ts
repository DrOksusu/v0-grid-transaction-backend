/**
 * Maker-Taker Live Executor (PR C 메인 모듈, PR E2에서 spec § 2 정합 재구현)
 *
 * 한 봇에 대한 한 사이클을 처리하는 순수 함수 (DB I/O 없음 — 호출자가 담당).
 *
 * 동작 개요 (spec § 2 "전략 핵심"):
 *  - CASE A (PENDING 트레이드 없음): 신규 maker bid limit 주문 (post_only) — X(저유동성) 매수
 *  - CASE B (PENDING 존재): 주문 상태 폴링 후 분기
 *      - 미체결 + 만료 전 → waiting
 *      - 미체결 + 만료 → cancelOrder + expired
 *      - 체결 → taker leg 단일 단계: Y(고유동성) 시장가 매도
 *          - 즉시 체결 → filled (P&L 계산: (T_received − M_paid) × q − fees)
 *          - 즉시 0 응답 → 1.5초 후 재폴링 1회 (PR D leg-2 false positive 방어)
 *          - 재폴링도 0 → partial_hold (X 그대로 보유, 수동 unwind 필요)
 *
 * Fallback 정책: Option A (no fallback). 근거:
 *  - simulator는 fallback 없음 → live가 가지면 sim/live P&L 메커니즘 어긋남(PR D 재발)
 *  - spec § 2가 cross-coin direct swap이고 그 외 동작 미정의
 *  - PR E1 minTakerBalance 자동 일시정지가 인벤토리 누적 위험 보완
 *
 * 설계 원칙:
 *  - DB 접근 일절 없음 (순수 입력→출력)
 *  - OrderClient DI로 mock 가능 (PR B IocClient 패턴 차용)
 *  - bot.killSwitch 검사는 호출자(에이전트) 책임
 *  - 모든 결과는 6개 kind discriminated union으로 표현
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

/** 결과 — discriminated union (6 kinds, PR E2에서 rolled_back 제거) */
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
      paidFeeKrw: number;
      netProfitKrw: number;
      realizedSpreadBps: number;
    }
  | { kind: 'partial_hold'; pendingId: bigint; reason: string };

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

  // ----- 체결됨 (full or partial) → taker leg (Y 시장가 매도, spec § 2) -----
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

    // Taker leg (spec § 2): 고유동성 코인 Y(takerCoin)을 즉시 시장가로 매도
    // PR D 사고에서 발견된 KRW 우회 패턴(USDS 매도 → KRW로 USDT 매수) 제거.
    // sim/live P&L 정합성 — simulator의 (takerPrice − makerFilledPrice) × q와 일치하도록.
    const sellResp = await client.placeBestIoc(
      `KRW-${bot.takerCoin}`,
      'ask',
      { volume: String(filledQty) },
    );
    let filledSellQty = parseFloat(sellResp.executed_volume || '0');
    let effectiveSellResp: UpbitOrderResp = sellResp;

    // Leg-2 IOC false positive 방어 (PR D 사례 uuid b04515ce):
    // IOC 즉시 응답이 executed_volume=0이지만 ~2분 후 실제 체결되는 경우가 관측됨.
    // takerCoin은 고유동성(USDT)이라 false positive 위험은 낮지만 안전망으로 1.5초 후 1회 재조회.
    // 두 번째 재조회 도입은 PR E2 운영 중 실제 false positive 재발 시 PR E3에서 검토.
    if (filledSellQty === 0 && sellResp.uuid) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const recheck = await client.getOrder(sellResp.uuid);
      const recheckQty = parseFloat(recheck.executed_volume || '0');
      if (recheckQty > 0) {
        filledSellQty = recheckQty;
        effectiveSellResp = recheck;
      }
    }

    if (filledSellQty === 0) {
      // taker leg 미체결 → maker leg(X=USDS) 그대로 보유. 수동 unwind 필요.
      // Option A "no fallback" 결정 — 자동 회수는 sim/live 정합성을 깬다.
      return {
        kind: 'partial_hold',
        pendingId: pending.id,
        reason: 'taker(Y) sell failed after IOC + recheck, holding X',
      };
    }

    const filledSellKrw = sumFunds(effectiveSellResp.trades);
    const paidFeeSell = parseFloat(effectiveSellResp.paid_fee || '0');

    // P&L 계산 — simulator와 동일 공식: (T_received − M_paid) × q − fees
    //   filledSellKrw  = takerCoin 매도로 받은 KRW (taker 체결가 × q)
    //   filledMakerKrw = makerCoin 매수에 지불한 KRW (maker 체결가 × q)
    const paidFeeKrw = paidFeeMaker + paidFeeSell;
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
