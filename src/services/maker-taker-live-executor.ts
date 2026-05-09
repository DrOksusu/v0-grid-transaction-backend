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
 *      - MAKER_BUY_FIRST/PENDING: 스프레드 감시 → 취소 or maker 체결 → taker 지정가 ASK
 *      - MAKER_BUY_FIRST/TAKER_PENDING: taker ASK 폴링 → P&L 정산
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
  /** maker PENDING 중 스프레드가 이 값(bps) 미만이면 maker 주문 취소. 보통 makerFeeBps + takerFeeBps */
  cancelBelowBps: number;
};

/** 현재 PENDING 트레이드 스냅샷 */
export type PendingTradeInput = {
  id: bigint;
  status: string;
  makerOrderUuid: string | null;
  makerOrderPrice: number;
  createdAt: Date;
  /** maker 체결 시각 — TAKER_PENDING 타임아웃 기준. null이면 createdAt 사용 */
  makerFilledAt: Date | null;
  notes: string | null;
  legOrder: string;
  takerFirstCostKrw: number | null;
  takerFirstFeeKrw: number | null;
  /** TAKER_PENDING 상태: 체결된 taker ASK 주문 UUID */
  takerOrderUuid: string | null;
  /** TAKER_PENDING 상태: maker 체결 시 grossKrw (P&L 계산용) */
  makerFilledGrossKrw: number | null;
  /** TAKER_PENDING 상태: maker 체결 수수료 */
  makerFilledFeeKrw: number | null;
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
  | { kind: 'spread_cancelled'; pendingId: bigint }
  | {
      kind: 'taker_placed';
      pendingId: bigint;
      takerOrderUuid: string;
      makerFilledQty: number;
      makerGrossKrw: number;
      makerFeeKrw: number;
    }
  | { kind: 'taker_expired'; pendingId: bigint; partialFillKrw?: number; partialFillQty?: number; partialFeeKrw?: number }
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

    // 비정상 저가 체결만 abort — 부분체결(정상 단가)은 filledQty 기반 BID로 처리
    // 예) 10 units @ 886 KRW → 단가=886 < 1472*0.9=1325 → abort
    //     6 units @ 1472 KRW → 단가=1472 ≥ 1325 → 6 units BID로 처리
    const avgIocPrice = sellResult.grossKrw / sellResult.filledQty;
    if (avgIocPrice < makerBook.bid * 0.9) {
      console.error(
        `[LiveExecutor] bot ${bot.id} TAKER_SELL_FIRST: IOC 체결 단가 ${avgIocPrice.toFixed(0)} < 기대값 ${(makerBook.bid * 0.9).toFixed(0)} (makerBid=${makerBook.bid}, filledQty=${sellResult.filledQty}) — abort`,
      );
      return { kind: 'noop' };
    }

    const takerOrderPrice = takerBook.bid + bot.bidOffsetKrw;
    // IOC 부분체결 시 실제 체결된 수량으로 BID를 걸어 수량 정합성 유지
    const orderId = await takerLeg.placeMakerBid(bot.takerCoin, takerOrderPrice, sellResult.filledQty);
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

      // 부분체결 감지: 실제 BID 수량(IOC filledQty) 대비 90% 미만이면 partial_hold
      // takerFirstCostKrw ÷ makerOrderPrice ≈ IOC filledQty (수량 정합성 검증)
      // makerCoin은 이미 IOC 매도 완료 → takerCoin 불완전 체결은 스테이블 손실
      const expectedBidQty = (pending.takerFirstCostKrw ?? 0) / Math.max(pending.makerOrderPrice, 1);
      if (poll.filledQty < expectedBidQty * 0.9) {
        console.warn(
          `[LiveExecutor] bot ${bot.id} TAKER_SELL_FIRST: partial fill ${poll.filledQty.toFixed(4)}/${expectedBidQty.toFixed(4)} (${Math.round((poll.filledQty / Math.max(expectedBidQty, 1e-9)) * 100)}%) — partial_hold`,
        );
        return {
          kind: 'partial_hold',
          pendingId: pending.id,
          reason: `TAKER_SELL_FIRST partial fill: ${poll.filledQty.toFixed(4)}/${expectedBidQty.toFixed(4)} qty`,
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

  // MAKER_BUY_FIRST — 두 가지 하위 상태

  // 하위 상태 A: TAKER_PENDING — maker 체결 완료, taker ASK 대기 중
  if (pending.status === 'TAKER_PENDING' && pending.takerOrderUuid) {
    const takerPoll = await takerLeg.pollOrder(pending.takerOrderUuid);

    if (takerPoll.filled) {
      if (takerPoll.grossKrw === 0) {
        return {
          kind: 'partial_hold',
          pendingId: pending.id,
          reason: 'taker ASK filled but grossKrw = 0 (defensive)',
        };
      }

      // 부분체결 감지: 기대 수량의 90% 미만이면 partial_hold
      // maker는 이미 전량 체결됨 → taker ASK 불완전 체결은 스테이블 손실
      if (takerPoll.filledQty < bot.quantity * 0.9) {
        console.warn(
          `[LiveExecutor] bot ${bot.id} TAKER_PENDING: partial fill ${takerPoll.filledQty}/${bot.quantity} (${Math.round((takerPoll.filledQty / bot.quantity) * 100)}%) — partial_hold`,
        );
        return {
          kind: 'partial_hold',
          pendingId: pending.id,
          reason: `TAKER_PENDING partial fill: ${takerPoll.filledQty.toFixed(4)}/${bot.quantity} qty`,
        };
      }

      const makerGrossKrw = pending.makerFilledGrossKrw ?? 0;
      const makerFeeKrw = pending.makerFilledFeeKrw ?? 0;
      const paidFeeKrw = makerFeeKrw + takerPoll.feeKrw;
      const netProfitKrw = takerPoll.grossKrw - makerGrossKrw - paidFeeKrw;
      const realizedSpreadBps =
        makerGrossKrw > 0
          ? Math.floor((takerPoll.grossKrw / makerGrossKrw - 1) * 10000)
          : 0;

      return {
        kind: 'filled',
        pendingId: pending.id,
        filledQty: takerPoll.filledQty,
        filledMakerKrw: makerGrossKrw,
        filledSellKrw: takerPoll.grossKrw,
        paidFeeKrw,
        netProfitKrw,
        realizedSpreadBps,
      };
    }

    // TAKER_PENDING 타임아웃은 maker 체결 시각 기준 (createdAt이 아님)
    const takerElapsed = Date.now() - (pending.makerFilledAt ?? pending.createdAt).getTime();
    if (takerElapsed > bot.maxPendingMs) {
      try {
        await takerLeg.cancelOrder(pending.takerOrderUuid);
      } catch {
        // 취소 직전 체결됐거나 이미 취소된 주문일 수 있음
      }
      // 취소 후 부분체결 여부 확인 — 실제 수령한 KRW를 기록하기 위해
      const finalPoll = await takerLeg.pollOrder(pending.takerOrderUuid);
      if (finalPoll.filledQty > 0 && finalPoll.grossKrw > 0) {
        return {
          kind: 'taker_expired',
          pendingId: pending.id,
          partialFillKrw: finalPoll.grossKrw,
          partialFillQty: finalPoll.filledQty,
          partialFeeKrw: finalPoll.feeKrw,
        };
      }
      return { kind: 'taker_expired', pendingId: pending.id };
    }

    return { kind: 'waiting', pendingId: pending.id };
  }

  // 하위 상태 B: PENDING — maker BID 대기 중
  // 스프레드 감시: 현재 스프레드가 수수료 손익분기 미만이면 취소
  if (bot.cancelBelowBps > 0 && pending.makerOrderPrice > 0) {
    const currentSpreadBps = Math.floor((takerBook.bid / pending.makerOrderPrice - 1) * 10000);
    if (currentSpreadBps < bot.cancelBelowBps) {
      console.log(
        `[LiveExecutor] bot ${bot.id} spread_cancelled: currentSpread=${currentSpreadBps}bp < cancelBelow=${bot.cancelBelowBps}bp (takerBid=${takerBook.bid}, makerOrderPrice=${pending.makerOrderPrice})`,
      );
      try {
        await makerLeg.cancelOrder(pending.makerOrderUuid);
      } catch {
        // 취소 직전 체결됐을 수 있음 — 폴링으로 확인
      }
      const postCancelPoll = await makerLeg.pollOrder(pending.makerOrderUuid);
      if (postCancelPoll.filled && postCancelPoll.grossKrw > 0) {
        const takerOrderId = await takerLeg.placeMakerAsk(
          bot.takerCoin,
          takerBook.bid,
          postCancelPoll.filledQty,
        );
        if (!takerOrderId) {
          return {
            kind: 'partial_hold',
            pendingId: pending.id,
            reason: 'spread_cancel race: maker filled but taker placeMakerAsk failed',
          };
        }
        return {
          kind: 'taker_placed',
          pendingId: pending.id,
          takerOrderUuid: takerOrderId,
          makerFilledQty: postCancelPoll.filledQty,
          makerGrossKrw: postCancelPoll.grossKrw,
          makerFeeKrw: postCancelPoll.feeKrw,
        };
      }
      return { kind: 'spread_cancelled', pendingId: pending.id };
    }
  }

  // maker 주문 폴링
  const poll = await makerLeg.pollOrder(pending.makerOrderUuid);

  if (poll.filled) {
    if (poll.grossKrw === 0) {
      return {
        kind: 'partial_hold',
        pendingId: pending.id,
        reason: 'maker filled but grossKrw = 0 (defensive)',
      };
    }

    // taker 지정가 ASK 주문 (현재 takerBook.bid 가격)
    const takerOrderId = await takerLeg.placeMakerAsk(bot.takerCoin, takerBook.bid, poll.filledQty);
    if (!takerOrderId) {
      return {
        kind: 'partial_hold',
        pendingId: pending.id,
        reason: 'taker placeMakerAsk failed, holding makerCoin',
      };
    }

    return {
      kind: 'taker_placed',
      pendingId: pending.id,
      takerOrderUuid: takerOrderId,
      makerFilledQty: poll.filledQty,
      makerGrossKrw: poll.grossKrw,
      makerFeeKrw: poll.feeKrw,
    };
  }

  if (elapsed > bot.maxPendingMs) {
    try {
      await makerLeg.cancelOrder(pending.makerOrderUuid);
    } catch {
      // 취소 직전 체결됐을 수 있음 — 폴링으로 확인
    }
    const postCancelPoll = await makerLeg.pollOrder(pending.makerOrderUuid);
    if (postCancelPoll.filled && postCancelPoll.grossKrw > 0) {
      const takerOrderId = await takerLeg.placeMakerAsk(
        bot.takerCoin,
        takerBook.bid,
        postCancelPoll.filledQty,
      );
      if (!takerOrderId) {
        return {
          kind: 'partial_hold',
          pendingId: pending.id,
          reason: 'expired race: maker filled but taker placeMakerAsk failed',
        };
      }
      return {
        kind: 'taker_placed',
        pendingId: pending.id,
        takerOrderUuid: takerOrderId,
        makerFilledQty: postCancelPoll.filledQty,
        makerGrossKrw: postCancelPoll.grossKrw,
        makerFeeKrw: postCancelPoll.feeKrw,
      };
    }
    return { kind: 'expired', pendingId: pending.id };
  }

  return { kind: 'waiting', pendingId: pending.id };
}
