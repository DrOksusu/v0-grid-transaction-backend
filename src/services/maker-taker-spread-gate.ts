/**
 * 수익성 gating — cross 스프레드(bp 기준)가 임계값 이상일 때만 maker 주문 허용.
 * bp = (higherBid / lowerBid - 1) * 10000
 */
import type { OrderbookTop } from './upbit-price-manager';
import type { NormalizedBook } from './maker-taker-live-executor';

export interface SpreadGateResult {
  ok: boolean;
  spreadBps: number;
  reason?: string;
}

/**
 * 크로스 스프레드를 bp로 계산해 minSpreadBps와 비교하는 순수 함수.
 *
 * @param makerBid  maker 코인 최우선 매수 호가
 * @param takerBid  taker 코인 최우선 매수 호가
 * @param direction 'MAKER_BUY_FIRST' | 'TAKER_SELL_FIRST'
 * @param minSpreadBps 최소 수익성 스프레드 (bp). 0이면 게이팅 비활성.
 */
export function isCrossSpreadProfitable(
  makerBid: number,
  takerBid: number,
  direction: 'MAKER_BUY_FIRST' | 'TAKER_SELL_FIRST',
  minSpreadBps: number,
): SpreadGateResult {
  const numerator   = direction === 'MAKER_BUY_FIRST' ? takerBid : makerBid;
  const denominator = direction === 'MAKER_BUY_FIRST' ? makerBid : takerBid;

  if (!denominator || denominator <= 0) {
    return { ok: false, spreadBps: 0, reason: 'invalid orderbook (denominator=0)' };
  }

  const spreadBps = Math.floor((numerator / denominator - 1) * 10000);

  if (minSpreadBps === 0) return { ok: true, spreadBps };

  if (spreadBps < minSpreadBps) {
    return {
      ok: false,
      spreadBps,
      reason: `spread ${spreadBps}bp < min ${minSpreadBps}bp`,
    };
  }
  return { ok: true, spreadBps };
}

/** 단일 거래소 시뮬 경로 호환용 — makerBook ask/bid 스프레드 bp 계산 */
export function isMakerBookSpreadProfitable(
  makerBook: OrderbookTop,
  minSpreadBps: number,
): SpreadGateResult {
  const bid = makerBook.bid.price;
  const ask = makerBook.ask.price;
  if (!bid || bid <= 0) return { ok: false, spreadBps: 0, reason: 'invalid makerBook' };
  const spreadBps = Math.floor((ask / bid - 1) * 10000);
  if (minSpreadBps === 0) return { ok: true, spreadBps };
  if (spreadBps < minSpreadBps) {
    return { ok: false, spreadBps, reason: `makerBook spread ${spreadBps}bp < min ${minSpreadBps}bp` };
  }
  return { ok: true, spreadBps };
}

/** NormalizedBook 기반 cross 스프레드 bp 계산 헬퍼 */
export function calcCrossSpreadBps(
  makerBook: NormalizedBook,
  takerBook: NormalizedBook,
  direction: 'MAKER_BUY_FIRST' | 'TAKER_SELL_FIRST',
): number {
  const numerator   = direction === 'MAKER_BUY_FIRST' ? takerBook.bid : makerBook.bid;
  const denominator = direction === 'MAKER_BUY_FIRST' ? makerBook.bid : takerBook.bid;
  if (!denominator || denominator <= 0) return 0;
  return Math.floor((numerator / denominator - 1) * 10000);
}
