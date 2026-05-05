/**
 * Maker-Taker Live Executor (PR C 메인 모듈, PR E2에서 spec § 2 정합 재구현)
 *
 * 한 봇에 대한 한 사이클을 처리하는 순수 함수 (DB I/O 없음 — 호출자가 담당).
 *
 * 동작 개요 (spec § 2 "전략 핵심"):
 *  - CASE A (PENDING 트레이드 없음): legOrder 결정 후 분기
 *      - MAKER_BUY_FIRST: makerCoin 매수 maker limit bid (기존 방식)
 *      - TAKER_SELL_FIRST: makerCoin IOC 매도 → takerCoin maker limit bid (PR I 신규)
 *  - CASE B (PENDING 존재): 주문 상태 폴링 후 분기 (pending.legOrder 기준)
 *      - MAKER_BUY_FIRST: makerCoin bid 체결 → takerCoin IOC ask 매도
 *      - TAKER_SELL_FIRST: takerCoin bid 체결 → P&L 정산 (추가 실행 없음)
 *
 * legOrder 결정 (decideLegOrder):
 *  - takerCoin.bid > makerCoin.bid → MAKER_BUY_FIRST (makerCoin이 더 저렴)
 *  - makerCoin.bid > takerCoin.bid → TAKER_SELL_FIRST (makerCoin이 더 비쌈)
 *
 * Fallback 정책: Option A (no fallback).
 */

import type { OrderbookTop } from './upbit-price-manager';

/** Upbit 주문 응답 — executor가 읽는 필드만 추림. */
export interface UpbitOrderResp {
  uuid: string;
  state?: string;
  executed_volume?: string;
  paid_fee?: string;
  trades?: Array<{ funds: string; price: string; volume: string }>;
}

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
  minSpreadKrw: number;
};

/** 현재 PENDING 트레이드 스냅샷 */
export type PendingTradeInput = {
  id: bigint;
  status: string;
  makerOrderUuid: string | null;
  makerOrderPrice: number;
  createdAt: Date;
  notes: string | null;
  legOrder: string;
  takerFirstCostKrw: number | null;
  takerFirstFeeKrw: number | null;
};

/** 결과 — discriminated union */
export type LiveExecutorResult =
  | { kind: 'noop' }
  | {
      kind: 'placed';
      makerOrderUuid: string;
      makerOrderPrice: number;
      legOrder: string;
      takerFirstCostKrw?: number;
      takerFirstFeeKrw?: number;
    }
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

/** makerBook vs takerBook bid 비교로 최적 레그 순서 결정 */
export function decideLegOrder(
  makerBook: OrderbookTop,
  takerBook: OrderbookTop,
): 'MAKER_BUY_FIRST' | 'TAKER_SELL_FIRST' {
  // makerCoin.bid > takerCoin.bid → makerCoin이 비쌈 → makerCoin을 먼저 IOC 매도
  return makerBook.bid.price > takerBook.bid.price ? 'TAKER_SELL_FIRST' : 'MAKER_BUY_FIRST';
}

/** trades 배열의 funds 합산 */
function sumFunds(trades: UpbitOrderResp['trades']): number {
  return (trades || []).reduce((s, t) => s + parseFloat(t.funds), 0);
}

export async function processLiveBot(
  input: ProcessLiveInput,
): Promise<LiveExecutorResult> {
  const { bot, pending, books, client, isLocked, preCheckOk } = input;

  const makerMarket = `KRW-${bot.makerCoin}`;
  const takerMarket = `KRW-${bot.takerCoin}`;
  const makerBook = books.get(makerMarket);
  const takerBook = books.get(takerMarket);

  // ===== CASE A: PENDING 없음 =====
  if (pending === null) {
    if (isLocked()) return { kind: 'noop' };
    if (!preCheckOk) return { kind: 'noop' };
    if (!makerBook || !takerBook) return { kind: 'noop' };

    const direction = decideLegOrder(makerBook, takerBook);

    if (direction === 'MAKER_BUY_FIRST') {
      // 기존: makerCoin maker BID
      const makerOrderPrice = makerBook.bid.price + bot.bidOffsetKrw;
      const resp = await client.placeLimit(makerMarket, 'bid', {
        price: String(makerOrderPrice),
        volume: String(bot.quantity),
        postOnly: true,
      });
      if (!resp.uuid) return { kind: 'noop' };
      return { kind: 'placed', makerOrderUuid: resp.uuid, makerOrderPrice, legOrder: 'MAKER_BUY_FIRST' };
    }

    // TAKER_SELL_FIRST: makerCoin IOC 매도 → takerCoin maker BID
    const sellResp = await client.placeBestIoc(makerMarket, 'ask', {
      volume: String(bot.quantity),
    });
    const filledSellQty = parseFloat(sellResp.executed_volume || '0');
    if (filledSellQty === 0) return { kind: 'noop' };

    const takerFirstCostKrw = sumFunds(sellResp.trades);
    const takerFirstFeeKrw = parseFloat(sellResp.paid_fee || '0');

    // makerCoin 매도 성공 → takerCoin maker BID
    const takerOrderPrice = takerBook.bid.price + bot.bidOffsetKrw;
    const bidResp = await client.placeLimit(takerMarket, 'bid', {
      price: String(takerOrderPrice),
      volume: String(bot.quantity),
      postOnly: true,
    });
    if (!bidResp.uuid) {
      // 매도는 완료됐으나 매수 주문 실패 — KRW 잔고 증가, 수동 처리 필요
      console.error(
        `[LiveExecutor] bot ${bot.id} TAKER_SELL_FIRST: makerCoin 매도 후 takerCoin BID 실패 (uuid 없음)`,
      );
      return { kind: 'noop' };
    }

    return {
      kind: 'placed',
      makerOrderUuid: bidResp.uuid,
      makerOrderPrice: takerOrderPrice,
      legOrder: 'TAKER_SELL_FIRST',
      takerFirstCostKrw,
      takerFirstFeeKrw,
    };
  }

  // ===== CASE B: PENDING 존재 =====
  if (pending.makerOrderUuid === null) {
    return { kind: 'waiting', pendingId: pending.id };
  }

  const status = await client.getOrder(pending.makerOrderUuid);
  const filledQty = parseFloat(status.executed_volume || '0');
  const elapsed = Date.now() - pending.createdAt.getTime();

  // ----- TAKER_SELL_FIRST: takerCoin BID 체결 판정 -----
  if (pending.legOrder === 'TAKER_SELL_FIRST') {
    if (filledQty > 0) {
      const filledMakerKrw = sumFunds(status.trades); // takerCoin 매수에 지불한 KRW
      const paidFeeMaker = parseFloat(status.paid_fee || '0');

      if (filledMakerKrw === 0) {
        return { kind: 'partial_hold', pendingId: pending.id, reason: 'takerCoin bid filled but trades funds = 0 (defensive)' };
      }

      const takerFirstCostKrw = pending.takerFirstCostKrw ?? 0;
      const takerFirstFeeKrw = pending.takerFirstFeeKrw ?? 0;
      const paidFeeKrw = takerFirstFeeKrw + paidFeeMaker;
      const netProfitKrw = takerFirstCostKrw - filledMakerKrw - paidFeeKrw;
      const realizedSpreadBps = filledMakerKrw > 0
        ? Math.floor((takerFirstCostKrw / filledMakerKrw - 1) * 10000)
        : 0;

      return {
        kind: 'filled',
        pendingId: pending.id,
        filledQty,
        filledMakerKrw,
        filledSellKrw: takerFirstCostKrw,
        paidFeeKrw,
        netProfitKrw,
        realizedSpreadBps,
      };
    }

    if (elapsed > bot.maxPendingMs) {
      await client.cancelOrder(pending.makerOrderUuid);
      return { kind: 'expired', pendingId: pending.id };
    }

    return { kind: 'waiting', pendingId: pending.id };
  }

  // ----- MAKER_BUY_FIRST: makerCoin BID 체결 판정 (기존 로직) -----
  if (filledQty > 0) {
    const filledMakerKrw = sumFunds(status.trades);
    const paidFeeMaker = parseFloat(status.paid_fee || '0');

    if (filledMakerKrw === 0) {
      return { kind: 'partial_hold', pendingId: pending.id, reason: 'maker filled but trades funds = 0 (defensive)' };
    }

    const sellResp = await client.placeBestIoc(takerMarket, 'ask', { volume: String(filledQty) });
    let filledSellQty = parseFloat(sellResp.executed_volume || '0');
    let effectiveSellResp: UpbitOrderResp = sellResp;

    // Leg-2 IOC false positive 방어 (PR D 사례)
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
      return { kind: 'partial_hold', pendingId: pending.id, reason: 'taker(Y) sell failed after IOC + recheck, holding X' };
    }

    const filledSellKrw = sumFunds(effectiveSellResp.trades);
    const paidFeeSell = parseFloat(effectiveSellResp.paid_fee || '0');
    const paidFeeKrw = paidFeeMaker + paidFeeSell;
    const netProfitKrw = filledSellKrw - filledMakerKrw - paidFeeKrw;
    const realizedSpreadBps = Math.floor((filledSellKrw / filledMakerKrw - 1) * 10000);

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

  if (elapsed > bot.maxPendingMs) {
    await client.cancelOrder(pending.makerOrderUuid);
    return { kind: 'expired', pendingId: pending.id };
  }

  return { kind: 'waiting', pendingId: pending.id };
}
