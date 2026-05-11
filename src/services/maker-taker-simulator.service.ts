// Maker-Taker 시뮬레이터 순수 함수 서비스
// 설계: docs/superpowers/specs/2026-04-24-maker-taker-simulator-design.md
//
// 외부 부작용(DB, 네트워크, 시간) 주입 방식으로 테스트 가능하게 설계.

import type { OrderbookTop } from './upbit-price-manager';

export interface PendingMakerOrder {
  makerOrderPrice: number;
  createdAt: Date;
  maxPendingMs: number;
}

export type FillDecision = 'fill' | 'expire' | 'wait';

/**
 * 체결 판단 (방식 A: best bid가 내 지정가 이하로 한 번이라도 내려오면 체결 간주)
 *
 * 설계 §4 — MVP 체결 판단.
 *  - bid.price ≤ makerOrderPrice: 체결
 *  - elapsed > maxPendingMs: 만료
 *  - 그 외: 대기
 *
 * expire 판정이 fill보다 우선 (만료된 주문은 체결 불가).
 */
export function shouldFill(
  order: PendingMakerOrder,
  currentMakerOrderbook: OrderbookTop,
  now: Date,
): FillDecision {
  const elapsed = now.getTime() - order.createdAt.getTime();
  if (elapsed > order.maxPendingMs) return 'expire';
  if (currentMakerOrderbook.bid.price <= order.makerOrderPrice) return 'fill';
  return 'wait';
}

/**
 * MAKER_SELL_FIRST 체결 판단
 *
 * 지정가 ASK를 orderbook ask 가격으로 등록한 경우,
 * 시장 ask가 우리 주문가 이상으로 오르면 우리가 최우선 매도자 → 체결 간주.
 */
export function shouldFillAsk(
  order: PendingMakerOrder,
  currentMakerOrderbook: OrderbookTop,
  now: Date,
): FillDecision {
  const elapsed = now.getTime() - order.createdAt.getTime();
  if (elapsed > order.maxPendingMs) return 'expire';
  if (currentMakerOrderbook.ask.price >= order.makerOrderPrice) return 'fill';
  return 'wait';
}

export interface TakerLegResult {
  takerPrice: number;
  grossProfitKrw: number;
  feeKrw: number;
  netProfitKrw: number;
  realizedSpreadBps: number;
  slippageBps: number;
}

export interface TakerLegAbort {
  abort: true;
  reason: string;
}

export interface SimulateTakerLegArgs {
  makerFilledPrice: number;
  takerOrderbook: OrderbookTop;
  quantity: number;
  feeBpsMaker: number;
  feeBpsTaker: number;
  minTakerBidKrw?: number;
}

/**
 * Taker leg 시뮬레이션 + P&L 계산
 *
 * 설계 §4, §6 — 방식 A에서는 taker를 현재 best bid 가격 그대로 체결로 가정
 * (슬리피지 0). 추후 orderbook depth 기반 슬리피지 모델 업그레이드 예정.
 *
 * P&L 공식 (코인 수량 q, maker 체결가 M, taker 체결가 T):
 *   gross = (T - M) * q
 *   makerFee = M * q * makerFeeBps / 10000
 *   takerFee = T * q * takerFeeBps / 10000
 *   net = gross - makerFee - takerFee
 *   realizedSpreadBps = floor((T - M) / M * 10000)  // 수수료 전 스프레드
 *
 * minTakerBidKrw 미달 시 abort.
 */
export function simulateTakerLeg(
  args: SimulateTakerLegArgs,
): TakerLegResult | TakerLegAbort {
  const { makerFilledPrice, takerOrderbook, quantity, feeBpsMaker, feeBpsTaker, minTakerBidKrw } = args;
  const takerPrice = takerOrderbook.bid.price;

  if (minTakerBidKrw !== undefined && takerPrice < minTakerBidKrw) {
    return { abort: true, reason: `takerBid ${takerPrice} < minTakerBidKrw ${minTakerBidKrw}` };
  }

  const grossProfitKrw = (takerPrice - makerFilledPrice) * quantity;
  const makerFee = (makerFilledPrice * quantity * feeBpsMaker) / 10000;
  const takerFee = (takerPrice * quantity * feeBpsTaker) / 10000;
  const feeKrw = makerFee + takerFee;
  const netProfitKrw = grossProfitKrw - feeKrw;
  const realizedSpreadBps = makerFilledPrice > 0
    ? Math.floor(((takerPrice - makerFilledPrice) / makerFilledPrice) * 10000)
    : 0;

  return {
    takerPrice,
    grossProfitKrw,
    feeKrw,
    netProfitKrw,
    realizedSpreadBps,
    slippageBps: 0,
  };
}

export function isAbort(result: TakerLegResult | TakerLegAbort): result is TakerLegAbort {
  return (result as TakerLegAbort).abort === true;
}
