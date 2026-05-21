/**
 * 코인원 스테이블코인 WebSocket 매니저
 *
 * wss://stream.coinone.co.kr ORDERBOOK 채널 구독:
 *   - 6종 스테이블코인(USDT, USDC, RLUSD, USDS, USDE, USD1) 실시간 호가
 *   - 코인원 WS는 매 이벤트마다 전체 orderbook 전송 (델타 아님) → bids[0]/asks[0]만 사용
 *   - 30분 무이벤트 시 서버 연결 끊김 → 25분마다 PING 전송
 *   - 지수 백오프 자동 재연결
 *
 * REST fallback (8s 주기):
 *   - 저유동성 코인(RLUSD/USD1/USDS/USDE)은 WS 이벤트가 수십 초 이상 안 올 수 있음
 *   - 10s 거래 신선도 게이트를 유지하기 위해 WS와 병행하여 REST 폴링 유지
 */

import WebSocket from 'ws';
import axios from 'axios';

const COINONE_WS_URL = 'wss://stream.coinone.co.kr';
const COINONE_TICKER_URL = 'https://api.coinone.co.kr/public/v2/ticker_new/KRW';

export const COINONE_STABLECOIN_SYMBOLS = ['USDT', 'USDC', 'RLUSD', 'USDS', 'USDE', 'USD1'] as const;
export type CoinoneStablecoin = typeof COINONE_STABLECOIN_SYMBOLS[number];

const CACHE_TTL_MS = 30_000;
const TRADING_FRESHNESS_MS = 10_000;
const PING_INTERVAL_MS = 25 * 60 * 1000; // 25분 (서버 idle timeout 30분 이전)
const REST_FALLBACK_INTERVAL_MS = 8_000;

export interface CoinoneOrderbookTop {
  symbol: string;
  bid: number;
  ask: number;
  timestamp: number;
}

// ── 모듈 레벨 상태 ────────────────────────────────────────────────────────────
const cache = new Map<string, CoinoneOrderbookTop>();

let ws: WebSocket | null = null;
let pingTimer: NodeJS.Timeout | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let restFallbackTimer: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;
let subscriberCount = 0;

// ── REST fallback ──────────────────────────────────────────────────────────────

async function fetchFromRest(): Promise<void> {
  try {
    const res = await axios.get(COINONE_TICKER_URL, { timeout: 6000 });
    if (res.data?.result !== 'success') return;

    for (const ticker of res.data.tickers ?? []) {
      const sym = String(ticker.target_currency).toUpperCase();
      if (!(COINONE_STABLECOIN_SYMBOLS as readonly string[]).includes(sym)) continue;

      const bid = parseFloat(ticker.best_bids?.[0]?.price ?? '0');
      const ask = parseFloat(ticker.best_asks?.[0]?.price ?? '0');
      if (bid > 0 && ask > 0) {
        cache.set(sym, { symbol: sym, bid, ask, timestamp: Date.now() });
      }
    }
  } catch (e: any) {
    console.warn('[CoinoneStablecoinWs] REST fallback 실패:', e.message);
  }
}

function startRestFallback(): void {
  if (restFallbackTimer) return;
  restFallbackTimer = setInterval(async () => {
    await fetchFromRest().catch(e =>
      console.warn('[CoinoneStablecoinWs] REST 주기 갱신 실패:', e.message),
    );
  }, REST_FALLBACK_INTERVAL_MS);
  console.log('[CoinoneStablecoinWs] REST fallback 시작 (8s 주기)');
}

function stopRestFallback(): void {
  if (restFallbackTimer) {
    clearInterval(restFallbackTimer);
    restFallbackTimer = null;
  }
}

// ── WebSocket ──────────────────────────────────────────────────────────────────

function subscribeAll(socket: WebSocket): void {
  for (const sym of COINONE_STABLECOIN_SYMBOLS) {
    socket.send(JSON.stringify({
      request_type: 'SUBSCRIBE',
      channel: 'ORDERBOOK',
      topic: { quote_currency: 'KRW', target_currency: sym },
    }));
  }
}

function startPing(socket: WebSocket): void {
  stopPing();
  pingTimer = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ request_type: 'PING' }));
    }
  }, PING_INTERVAL_MS);
}

function stopPing(): void {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 60_000);
  reconnectAttempts++;
  console.log(`[CoinoneStablecoinWs] ${delay}ms 후 재연결 (시도 ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectInternal();
  }, delay);
}

function connectInternal(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const currentWs = new WebSocket(COINONE_WS_URL);
  ws = currentWs;

  currentWs.on('open', () => {
    if (ws !== currentWs) {
      try { currentWs.close(); } catch { /* orphan */ }
      return;
    }
    reconnectAttempts = 0;
    subscribeAll(currentWs);
    startPing(currentWs);
    console.log('[CoinoneStablecoinWs] 연결됨. ORDERBOOK 구독:', COINONE_STABLECOIN_SYMBOLS.join(', '));

    // 초기 REST 스냅샷으로 캐시 채우기 (첫 WS 이벤트 오기 전 공백 방지)
    fetchFromRest().catch(e => console.warn('[CoinoneStablecoinWs] 초기 REST 실패:', e.message));
  });

  currentWs.on('message', (data: Buffer) => {
    if (ws !== currentWs) return;
    try {
      const msg = JSON.parse(data.toString());
      if (msg.response_type === 'PONG') return;
      if (msg.response_type !== 'DATA' || msg.channel !== 'ORDERBOOK') return;

      const d = msg.data;
      if (!d) return;

      const sym = String(d.target_currency ?? '').toUpperCase();
      if (!(COINONE_STABLECOIN_SYMBOLS as readonly string[]).includes(sym)) return;

      // 코인원 WS는 전체 orderbook 전송 → bids[0] / asks[0]이 최우선 호가
      const bid = parseFloat(d.bids?.[0]?.price ?? '0');
      const ask = parseFloat(d.asks?.[0]?.price ?? '0');
      if (bid > 0 && ask > 0) {
        cache.set(sym, { symbol: sym, bid, ask, timestamp: Date.now() });
      }
    } catch (err: any) {
      console.error('[CoinoneStablecoinWs] 메시지 파싱 오류:', err.message);
    }
  });

  currentWs.on('close', (code: number) => {
    if (ws !== currentWs) return;
    ws = null;
    stopPing();
    console.log(`[CoinoneStablecoinWs] 연결 종료 (code=${code}) — 재연결 예약`);
    if (subscriberCount > 0) scheduleReconnect();
  });

  currentWs.on('error', (err: Error) => {
    console.error('[CoinoneStablecoinWs] 오류:', err.message);
    if (ws === currentWs) ws = null;
  });
}

// ── 공개 API ──────────────────────────────────────────────────────────────────

/** 폴링 시작 (ref count 방식) */
export function subscribeCoinoneStablecoinOrderbooks(): void {
  subscriberCount++;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  connectInternal();
  startRestFallback();
}

/** 폴링 중지 (마지막 구독자 해제 시 WS 종료) */
export function unsubscribeCoinoneStablecoinOrderbooks(): void {
  subscriberCount = Math.max(0, subscriberCount - 1);
  if (subscriberCount > 0) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopPing();
  stopRestFallback();
  if (ws) {
    ws.close();
    ws = null;
  }
  cache.clear();
  console.log('[CoinoneStablecoinWs] 구독 해제 — WS 종료');
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

/** 거래용 조회 — 10s 신선도 게이트. null = 데이터 없거나 낡음 */
export function getCoinoneOrderbookForTrading(symbol: string): CoinoneOrderbookTop | null {
  const entry = cache.get(symbol.toUpperCase());
  if (!entry || Date.now() - entry.timestamp > TRADING_FRESHNESS_MS) return null;
  return entry;
}

/** WS 연결 상태 */
export function isCoinoneStablecoinPolling(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}
