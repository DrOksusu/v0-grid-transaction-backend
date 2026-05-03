// 빗썸 단일 거래소 스테이블코인 차익거래 서비스
// 같은 거래소 내 두 스테이블코인 가격차를 taker-taker로 포착
//
// 전략:
//   coinSell/KRW 시장가 매도 → 받은 KRW로 coinBuy/KRW 시장가 매수
//   수수료: taker 0.04% × 2 = 0.08% → BEP ≈ price × 0.08%
//
// Leg B 수량 결정 방식 (v1):
//   qty 코인 단위로 통일 (Leg A와 동일 수량 매수 시도).
//   실제 Leg A 미수 수량/슬리피지는 DB에 기록되므로 운영자가 추적 가능.
//   향후 v2에서 Leg A 수취 KRW 기반으로 수량 동적 산정 검토.

import { BithumbClient } from './exchange/bithumb-client';
import {
  fetchBithumbOrderbooks,
  BithumbOrderbookTop,
} from './bithumb-price-manager';

/** 빗썸 taker 수수료율 (0.04%) */
const TAKER_FEE_RATE = 0.0004;

/** 주문 체결 상태 polling 간격 (ms) */
const POLL_INTERVAL_MS = 500;

/** 최대 polling 횟수 (10초 = 500ms × 20) */
const MAX_POLL_ATTEMPTS = 20;

/** 차익거래 기회 정보 */
export interface BithumbArbOpportunity {
  /** 매도 코인 심볼 (예: "USDT") */
  coinSell: string;
  /** 매수 코인 심볼 (예: "USDC") */
  coinBuy: string;
  /** 스프레드 (bps 단위, 1bps = 0.01%) */
  spreadBps: number;
  /** 스프레드 절대값 (KRW) */
  spreadKrw: number;
  /** coinSell 최우선 매수호가 (KRW) */
  sellBid: number;
  /** coinBuy 최우선 매도호가 (KRW) */
  buyAsk: number;
}

/**
 * 호가 맵에서 가장 수익성 높은 차익 기회를 탐색한다.
 *
 * @param books 코인 심볼 → 호가 맵
 * @param minSpreadBps 최소 스프레드 임계값 (bps)
 * @returns 최적 기회. 없으면 null.
 */
export function findBestOpportunity(
  books: Map<string, BithumbOrderbookTop>,
  minSpreadBps: number,
): BithumbArbOpportunity | null {
  const coins = Array.from(books.keys());
  let best: BithumbArbOpportunity | null = null;

  for (const coinSell of coins) {
    for (const coinBuy of coins) {
      if (coinSell === coinBuy) continue;

      const sellBook = books.get(coinSell)!;
      const buyBook = books.get(coinBuy)!;

      const sellBid = sellBook.bid;
      const buyAsk = buyBook.ask;

      // 스프레드 = 매도호가 - 매수호가. 양수여야 수익 가능성 존재.
      const spreadKrw = sellBid - buyAsk;

      // BEP = 중간가 × (taker 수수료 × 2)
      const midPrice = (sellBid + buyAsk) / 2;
      const bepKrw = midPrice * TAKER_FEE_RATE * 2;

      if (spreadKrw <= bepKrw) continue;

      const spreadBps = Math.round((spreadKrw / midPrice) * 10000);
      if (spreadBps < minSpreadBps) continue;

      if (!best || spreadBps > best.spreadBps) {
        best = { coinSell, coinBuy, spreadBps, spreadKrw, sellBid, buyAsk };
      }
    }
  }

  return best;
}

/** 주문 체결 polling 결과 타입 */
interface FilledResult {
  filledQty: number;
  avgPrice: number;
  feeKrw: number;
}

/**
 * 주문이 체결될 때까지 polling 한다.
 * 최대 MAX_POLL_ATTEMPTS × POLL_INTERVAL_MS 동안 대기.
 *
 * @param client BithumbClient 인스턴스
 * @param orderId 주문 UUID
 * @throws 체결 타임아웃 또는 취소/실패 상태 시
 */
async function pollUntilFilled(
  client: BithumbClient,
  orderId: string,
): Promise<FilledResult> {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    const order = await client.getOrder(orderId);

    if (order.status === 'filled') {
      return {
        filledQty: order.filledQty,
        avgPrice: order.avgFillPrice,
        feeKrw: order.totalFeeKrw,
      };
    }

    if (order.status === 'cancelled' || order.status === 'failed') {
      throw new Error(`주문 ${orderId} 상태: ${order.status}`);
    }

    // pending 상태: 다음 polling까지 대기
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(`주문 ${orderId} 체결 대기 시간 초과 (${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS}ms)`);
}

/** 차익거래 실행 결과 */
export interface ArbExecuteResult {
  /** 실행 상태 */
  status: 'FILLED' | 'LEG_A_FAILED' | 'LEG_B_FAILED';
  legASellOrderId?: string;
  legAFilledQty?: number;
  legAAvgPriceKrw?: number;
  legAFeeKrw?: number;
  /** Leg A 수취 KRW = filledQty × avgPrice - feeKrw */
  legAReceivedKrw?: number;
  legBBuyOrderId?: string;
  legBFilledQty?: number;
  legBAvgPriceKrw?: number;
  legBFeeKrw?: number;
  /** Leg B 지출 KRW = filledQty × avgPrice + feeKrw */
  legBSpentKrw?: number;
  /** 수익 = legAReceivedKrw - legBSpentKrw */
  profitKrw?: number;
  failureReason?: string;
}

/**
 * 빗썸 단일 거래소 차익거래를 실행한다.
 *
 * 실행 흐름:
 *   Leg A: coinSell 시장가 매도 → 체결 polling → KRW 수취
 *   Leg B: coinBuy 시장가 매수 (qty 코인 기준) → 체결 polling → KRW 지출
 *
 * Leg B 수량: qty 코인 단위 고정 (v1).
 * Leg A 수취 KRW ÷ buyAsk 기반 동적 수량은 v2 검토.
 *
 * @param client BithumbClient 인스턴스
 * @param opp 차익 기회 정보
 * @param qty 거래 수량 (코인 단위)
 */
export async function executeArb(
  client: BithumbClient,
  opp: BithumbArbOpportunity,
  qty: number,
): Promise<ArbExecuteResult> {
  // === Leg A: coinSell 시장가 매도 ===
  let legAOrderId: string;
  try {
    const legA = await client.placeMarketOrder('sell', opp.coinSell, qty);
    legAOrderId = legA.orderId;
  } catch (err: any) {
    return {
      status: 'LEG_A_FAILED',
      failureReason: `Leg A 주문 실패: ${err.message}`,
    };
  }

  let legAResult: FilledResult;
  try {
    legAResult = await pollUntilFilled(client, legAOrderId);
  } catch (err: any) {
    return {
      status: 'LEG_A_FAILED',
      legASellOrderId: legAOrderId,
      failureReason: `Leg A 체결 대기 실패: ${err.message}`,
    };
  }

  const legAReceivedKrw =
    legAResult.filledQty * legAResult.avgPrice - legAResult.feeKrw;

  // === Leg B: coinBuy 시장가 매수 ===
  // placeMarketOrder('buy', ...) 는 KRW 금액 기준 주문 (bithumb-client.ts 참조):
  //   body.price = ceil(quantity × krwPerUnit × 1.02)
  //
  // 1.02 버퍼 상쇄: quantity에 qty/1.02를 전달 → 실제 KRW 예산 = qty × buyAsk × (1/1.02) × 1.02 ≈ qty × buyAsk
  // 결과: legBFilledQty ≈ qty, coinSell/coinBuy 잔고 균형 유지.
  const legBQtyArg = qty / 1.02;
  let legBOrderId: string;
  try {
    const legB = await client.placeMarketOrder(
      'buy',
      opp.coinBuy,
      legBQtyArg,
      opp.buyAsk,
    );
    legBOrderId = legB.orderId;
  } catch (err: any) {
    return {
      status: 'LEG_B_FAILED',
      legASellOrderId: legAOrderId,
      legAFilledQty: legAResult.filledQty,
      legAAvgPriceKrw: legAResult.avgPrice,
      legAFeeKrw: legAResult.feeKrw,
      legAReceivedKrw,
      failureReason: `Leg B 주문 실패: ${err.message}`,
    };
  }

  let legBResult: FilledResult;
  try {
    legBResult = await pollUntilFilled(client, legBOrderId);
  } catch (err: any) {
    return {
      status: 'LEG_B_FAILED',
      legASellOrderId: legAOrderId,
      legAFilledQty: legAResult.filledQty,
      legAAvgPriceKrw: legAResult.avgPrice,
      legAFeeKrw: legAResult.feeKrw,
      legAReceivedKrw,
      legBBuyOrderId: legBOrderId,
      failureReason: `Leg B 체결 대기 실패: ${err.message}`,
    };
  }

  const legBSpentKrw =
    legBResult.filledQty * legBResult.avgPrice + legBResult.feeKrw;
  const profitKrw = legAReceivedKrw - legBSpentKrw;

  return {
    status: 'FILLED',
    legASellOrderId: legAOrderId,
    legAFilledQty: legAResult.filledQty,
    legAAvgPriceKrw: legAResult.avgPrice,
    legAFeeKrw: legAResult.feeKrw,
    legAReceivedKrw,
    legBBuyOrderId: legBOrderId,
    legBFilledQty: legBResult.filledQty,
    legBAvgPriceKrw: legBResult.avgPrice,
    legBFeeKrw: legBResult.feeKrw,
    legBSpentKrw,
    profitKrw,
  };
}
