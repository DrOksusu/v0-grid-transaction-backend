/**
 * 코인원 스테이블코인 REST 폴링 매니저
 *
 * GET https://api.coinone.co.kr/public/v2/ticker_new/KRW 를 5초 주기로 폴링하여
 * 5종 스테이블코인(USDT, USDC, USD1, USDS, USDE)의 최우선 bid/ask를 캐싱.
 *
 * 빗썸(WS delta)과 달리 코인원은 REST만 사용. 모니터링 전용이므로 거래 신선도 체크 없음.
 */

import axios from 'axios';

const COINONE_TICKER_URL = 'https://api.coinone.co.kr/public/v2/ticker_new/KRW';

export const COINONE_STABLECOIN_SYMBOLS = ['USDT', 'USDC', 'USD1', 'USDS', 'USDE'] as const;
export type CoinoneStablecoin = typeof COINONE_STABLECOIN_SYMBOLS[number];

const CACHE_TTL_MS = 30_000;
const POLL_INTERVAL_MS = 5_000;

export interface CoinoneOrderbookTop {
  symbol: string;
  bid: number;
  ask: number;
  timestamp: number;
}

const cache = new Map<string, CoinoneOrderbookTop>();
let pollTimer: NodeJS.Timeout | null = null;
let subscriberCount = 0;

async function fetchAndUpdate(): Promise<void> {
  try {
    const res = await axios.get(COINONE_TICKER_URL, { timeout: 6000 });
    if (res.data?.result !== 'success') return;

    for (const ticker of res.data.tickers ?? []) {
      const sym = String(ticker.target_currency).toUpperCase();
      if (!(COINONE_STABLECOIN_SYMBOLS as readonly string[]).includes(sym)) continue;

      const bid = parseFloat(ticker.best_bids?.[0]?.price ?? '0');
      const ask = parseFloat(ticker.best_asks?.[0]?.price ?? '0');
      if (bid > 0 && ask > 0) {
        cache.set(sym, { symbol: sym, bid, ask, timestamp: ticker.timestamp });
      }
    }
  } catch (e: any) {
    console.warn('[CoinoneStablecoin] 폴링 실패:', e.message);
  }
}

/** 폴링 시작 (ref count 방식, 최초 호출 시에만 interval 생성) */
export function subscribeCoinoneStablecoinOrderbooks(): void {
  subscriberCount++;
  if (pollTimer) return;
  fetchAndUpdate();
  pollTimer = setInterval(fetchAndUpdate, POLL_INTERVAL_MS);
  console.log('[CoinoneStablecoin] REST 폴링 시작 (5s 주기)');
}

/** 폴링 중지 (마지막 구독자 해제 시 interval 제거) */
export function unsubscribeCoinoneStablecoinOrderbooks(): void {
  subscriberCount = Math.max(0, subscriberCount - 1);
  if (subscriberCount > 0) return;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  cache.clear();
  console.log('[CoinoneStablecoin] REST 폴링 중지');
}

/** 단일 심볼 조회 (TTL 초과 시 null) */
export function getCoinoneStablecoinOrderbook(symbol: string): CoinoneOrderbookTop | null {
  const entry = cache.get(symbol.toUpperCase());
  if (!entry || Date.now() - entry.timestamp > CACHE_TTL_MS) return null;
  return entry;
}

/** 전체 심볼 캐시 (불변 복사본) */
export function getAllCoinoneStablecoinOrderbooks(): ReadonlyMap<string, CoinoneOrderbookTop> {
  return new Map(cache);
}

/** 거래용 조회 — 10s 신선도 게이트 (빗썸 패턴과 동일). null = 데이터 없거나 낡음 */
export function getCoinoneOrderbookForTrading(symbol: string): CoinoneOrderbookTop | null {
  const entry = cache.get(symbol.toUpperCase());
  if (!entry || Date.now() - entry.timestamp > 10_000) return null;
  return entry;
}

/** WS 없이 REST만 쓰므로 항상 "연결됨"으로 간주 */
export function isCoinoneStablecoinPolling(): boolean {
  return pollTimer !== null;
}
