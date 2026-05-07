/**
 * Maker-Taker Live Executor
 *
 * 한 봇에 대한 한 사이클을 처리하는 순수 함수 (DB I/O 없음).
 * ExchangeLeg 추상 인터페이스를 통해 거래소에 무관하게 동작.
 *
 * 동작 개요:
 *  - CASE A (PENDING 없음): legOrder 결정 후 분기
 *      - MAKER_BUY_FIRST: makerCoin maker BID (makerLeg)
 *      - TAKER_SELL_FIRST: makerCoin IOC 매도 (makerLeg) → takerCoin maker BID (takerLeg)
 *  - CASE B (PENDING 존재): 주문 폴링 후 분기
 *      - MAKER_BUY_FIRST: makerCoin BID 체결 → takerCoin IOC 매도 (takerLeg)
 *      - TAKER_SELL_FIRST: takerCoin BID 체결 → P&L 정산
 */

import type { ExchangeLeg } from './exchange-leg';

/** 거래소 중립 호가 스냅샷 */
export type NormalizedBook = { bid: number; ask: number };

/** 봇 입력 */
export type LiveBotInput = {
  id: number;
  userId: number;
  makerCoin: string;
  takerCoin: string;
  makerExchange: string;
  takerExchange: string;
  bidOffsetKrw: number;
  quantity: number;
  maxPendingMs: number;
  killSwitch: boolean;
  minSpreadBps: number;
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
  makerBook: NormalizedBook;
  takerBook: NormalizedBook;
  makerLeg: ExchangeLeg;
  takerLeg: ExchangeLeg;
  isLocked: () => boolean;
  preCheckOk: boolean;
};

/** makerBook vs takerBook bid 비교로 최적 레그 순서 결정 */
export function decideLegOrder(
  makerBook: NormalizedBook,
  takerBook: NormalizedBook,
): 'MAKER_BUY_FIRST' | 'TAKER_SELL_FIRST' {
  return makerBook.bid > takerBook.bid ? 'TAKER_SELL_FIRST' : 'MAKER_BUY_FIRST';
}

export async function processLiveBot(input: ProcessLiveInput): Promise<LiveExecutorResult> {
  const { bot, pending, makerBook, takerBook, makerLeg, takerLeg, isLocked, preCheckOk } = input;

  // ===== CASE A: PENDING 없음 =====
  if (pending === null) {
    if (isLocked()) return { kind: 'noop' };
    if (!preCheckOk) return { kind: 'noop' };

    const direction = decideLegOrder(makerBook, takerBook);

    if (direction === 'MAKER_BUY_FIRST') {
      const makerOrderPrice = makerBook.bid + bot.bidOffsetKrw;
      const orderId = await makerLeg.placeMakerBid(bot.makerCoin, makerOrderPrice, bot.quantity);
      if (!orderId) return { kind: 'noop' };
      return { kind: 'placed', makerOrderUuid: orderId, makerOrderPrice, legOrder: 'MAKER_BUY_FIRST' };
    }

    // TAKER_SELL_FIRST: makerCoin IOC 매도 → takerCoin maker BID
    const sellResult = await makerLeg.sellIoc(bot.makerCoin, bot.quantity);
    if (!sellResult) return { kind: 'noop' };

    const takerOrderPrice = takerBook.bid + bot.bidOffsetKrw;
    const orderId = await takerLeg.placeMakerBid(bot.takerCoin, takerOrderPrice, bot.quantity);
    if (!orderId) {
      console.error(
        `[LiveExecutor] bot ${bot.id} TAKER_SELL_FIRST: makerCoin 매도 후 takerCoin BID 실패`,
      );
      return { kind: 'noop' };
    }

    return {
      kind: 'placed',
      makerOrderUuid: orderId,
      makerOrderPrice: takerOrderPrice,
      legOrder: 'TAKER_SELL_FIRST',
      takerFirstCostKrw: sellResult.grossKrw,
      takerFirstFeeKrw: sellResult.feeKrw,
    };
  }

  // ===== CASE B: PENDING 존재 =====
  if (pending.makerOrderUuid === null) {
    return { kind: 'waiting', pendingId: pending.id };
  }

  const elapsed = Date.now() - pending.createdAt.getTime();

  // TAKER_SELL_FIRST: pending 주문 = takerCoin BID on takerLeg
  if (pending.legOrder === 'TAKER_SELL_FIRST') {
    const poll = await takerLeg.pollOrder(pending.makerOrderUuid);

    if (poll.filled) {
      if (poll.grossKrw === 0) {
        return {
          kind: 'partial_hold',
          pendingId: pending.id,
          reason: 'takerCoin bid filled but grossKrw = 0 (defensive)',
        };
      }

      const takerFirstCostKrw = pending.takerFirstCostKrw ?? 0;
      const takerFirstFeeKrw = pending.takerFirstFeeKrw ?? 0;
      const paidFeeKrw = takerFirstFeeKrw + poll.feeKrw;
      const netProfitKrw = takerFirstCostKrw - poll.grossKrw - paidFeeKrw;
      const realizedSpreadBps =
        poll.grossKrw > 0
          ? Math.floor((takerFirstCostKrw / poll.grossKrw - 1) * 10000)
          : 0;

      return {
        kind: 'filled',
        pendingId: pending.id,
        filledQty: poll.filledQty,
        filledMakerKrw: poll.grossKrw,
        filledSellKrw: takerFirstCostKrw,
        paidFeeKrw,
        netProfitKrw,
        realizedSpreadBps,
      };
    }

    if (elapsed > bot.maxPendingMs) {
      await takerLeg.cancelOrder(pending.makerOrderUuid);
      return { kind: 'expired', pendingId: pending.id };
    }

    return { kind: 'waiting', pendingId: pending.id };
  }

  // MAKER_BUY_FIRST: pending 주문 = makerCoin BID on makerLeg
  const poll = await makerLeg.pollOrder(pending.makerOrderUuid);

  if (poll.filled) {
    if (poll.grossKrw === 0) {
      return {
        kind: 'partial_hold',
        pendingId: pending.id,
        reason: 'maker filled but grossKrw = 0 (defensive)',
      };
    }

    // takerCoin IOC 매도
    const sellResult = await takerLeg.sellIoc(bot.takerCoin, poll.filledQty);
    if (!sellResult) {
      return {
        kind: 'partial_hold',
        pendingId: pending.id,
        reason: 'taker sell IOC failed, holding makerCoin',
      };
    }

    const paidFeeKrw = poll.feeKrw + sellResult.feeKrw;
    const netProfitKrw = sellResult.grossKrw - poll.grossKrw - paidFeeKrw;
    const realizedSpreadBps = Math.floor((sellResult.grossKrw / poll.grossKrw - 1) * 10000);

    return {
      kind: 'filled',
      pendingId: pending.id,
      filledQty: poll.filledQty,
      filledMakerKrw: poll.grossKrw,
      filledSellKrw: sellResult.grossKrw,
      paidFeeKrw,
      netProfitKrw,
      realizedSpreadBps,
    };
  }

  if (elapsed > bot.maxPendingMs) {
    await makerLeg.cancelOrder(pending.makerOrderUuid);
    return { kind: 'expired', pendingId: pending.id };
  }

  return { kind: 'waiting', pendingId: pending.id };
}
