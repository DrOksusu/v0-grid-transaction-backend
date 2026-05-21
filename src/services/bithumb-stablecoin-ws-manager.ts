/**
 * Bithumb 스테이블코인 orderbook WebSocket 매니저
 *
 * pubwss orderbookdepth 구독:
 *   - 5종 스테이블코인 KRW 마켓 실시간 호가 수신
 *   - Bithumb WS는 증분 델타(delta) 방식 → 로컬 호가창(Map) 유지 후 best bid/ask 추출
 *   - 연결 후 REST 호출 없음
 *   - 지수 백오프 자동 재연결 (최대 10회)
 *
 * 비유: 빗썸 매장의 호가판(로컬 호가창)을 항상 최신으로 갱신하고,
 * Observer가 언제든지 "지금 USDT 최우선 매수/매도가"를 즉시 읽을 수 있게 함.
 */

import WebSocket from 'ws';
import axios from 'axios';

const BITHUMB_WS_URL = 'wss://pubwss.bithumb.com/pub/ws';

export const BITHUMB_STABLECOIN_SYMBOLS = ['USDT', 'USDC', 'USDS', 'USD1', 'USDE'] as const;
export type BithumbStablecoin = typeof BITHUMB_STABLECOIN_SYMBOLS[number];

const CACHE_TTL_MS = 120_000;
/** 거래 결정에 사용할 최대 허용 stale 시간. 이보다 오래된 호가는 게이트 차단. */
const TRADING_FRESHNESS_MS = 10_000;
const MAX_RECONNECT_ATTEMPTS = Infinity;

export interface BithumbOrderbookTop {
  symbol: string;
  bid: number;
  bidQty: number;
  ask: number;
  askQty: number;
  timestamp: number;
}

// 로컬 호가창: price 문자열 → 수량 (float 정밀도 오염 방지용 string key)
interface LocalBook {
  bids: Map<string, number>;
  asks: Map<string, number>;
  lastUpdated: number;
}

// ── 모듈 레벨 상태 ────────────────────────────────────────────────────────────
const localBooks = new Map<string, LocalBook>();
const cache = new Map<string, BithumbOrderbookTop>();

let ws: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;
let subscriberCount = 0;

// ── 내부 유틸 ─────────────────────────────────────────────────────────────────

function bestBid(bids: Map<string, number>): { price: number; qty: number } {
  let bestPrice = 0;
  let bestQty = 0;
  for (const [priceStr, qty] of bids) {
    if (qty > 0) {
      const p = parseFloat(priceStr);
      if (p > bestPrice) {
        bestPrice = p;
        bestQty = qty;
      }
    }
  }
  return { price: bestPrice, qty: bestQty };
}

function bestAsk(asks: Map<string, number>): { price: number; qty: number } {
  let bestPrice = Infinity;
  let bestQty = 0;
  for (const [priceStr, qty] of asks) {
    if (qty > 0) {
      const p = parseFloat(priceStr);
      if (p < bestPrice) {
        bestPrice = p;
        bestQty = qty;
      }
    }
  }
  return bestPrice === Infinity ? { price: 0, qty: 0 } : { price: bestPrice, qty: bestQty };
}

function applyDelta(
  symbol: string,
  orderType: 'ask' | 'bid',
  price: string,
  quantity: string,
): void {
  if (!localBooks.has(symbol)) {
    localBooks.set(symbol, { bids: new Map(), asks: new Map(), lastUpdated: Date.now() });
  }
  const book = localBooks.get(symbol)!;
  const side = orderType === 'bid' ? book.bids : book.asks;
  const qty = parseFloat(quantity);

  if (qty === 0) {
    side.delete(price);
  } else {
    side.set(price, qty);
  }
  book.lastUpdated = Date.now();

  const { price: bid, qty: bidQty } = bestBid(book.bids);
  const { price: ask, qty: askQty } = bestAsk(book.asks);
  if (bid > 0 && ask > 0) {
    cache.set(symbol, { symbol, bid, bidQty, ask, askQty, timestamp: Date.now() });
  }
}

function scheduleReconnect(): void {
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 60_000);
  reconnectAttempts++;
  console.log(`[BithumbStablecoinWs] ${delay}ms 후 재연결 (시도 ${reconnectAttempts})`);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    // WS 재연결 전 REST로 먼저 호가 갱신 (WS가 오래 끊겼을 때 stale 방지)
    if (reconnectAttempts > 3) {
      await initFromRest().catch(e => console.warn('[BithumbStablecoinWs] REST 재초기화 실패:', e.message));
    }
    connectInternal();
  }, delay);
}

/** WS 연결 직후 REST 호가로 localBooks와 cache를 초기화 */
async function initFromRest(): Promise<void> {
  await Promise.all(
    BITHUMB_STABLECOIN_SYMBOLS.map(async (symbol) => {
      try {
        const res = await axios.get(
          `https://api.bithumb.com/public/orderbook/${symbol}_KRW?count=5`,
          { timeout: 5000 },
        );
        const data = res.data?.data;
        if (!data) return;
        if (!localBooks.has(symbol)) {
          localBooks.set(symbol, { bids: new Map(), asks: new Map(), lastUpdated: Date.now() });
        }
        const book = localBooks.get(symbol)!;
        for (const row of (data.bids ?? [])) {
          book.bids.set(String(row.price), parseFloat(row.quantity));
        }
        for (const row of (data.asks ?? [])) {
          book.asks.set(String(row.price), parseFloat(row.quantity));
        }
        book.lastUpdated = Date.now();
        const { price: bid, qty: bidQty } = bestBid(book.bids);
        const { price: ask, qty: askQty } = bestAsk(book.asks);
        if (bid > 0 && ask > 0) {
          cache.set(symbol, { symbol, bid, bidQty, ask, askQty, timestamp: Date.now() });
          console.log(`[BithumbStablecoinWs] REST 갱신: ${symbol} bid=${bid} ask=${ask}`);
        }
      } catch {
        // 개별 코인 실패는 무시
      }
    }),
  );
}

function connectInternal(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const currentWs = new WebSocket(BITHUMB_WS_URL);
  ws = currentWs;

  currentWs.on('open', () => {
    if (ws !== currentWs) {
      try { currentWs.close(); } catch { /* orphan */ }
      return;
    }
    reconnectAttempts = 0;
    // REST 주기 폴링은 WS 연결 후에도 계속 유지 (얇은 시장 심볼은 WS delta가 10초 이상 안 올 수 있음)
    const symbols = BITHUMB_STABLECOIN_SYMBOLS.map(s => `${s}_KRW`);
    currentWs.send(JSON.stringify({ type: 'orderbookdepth', symbols }));
    console.log('[BithumbStablecoinWs] orderbookdepth 구독 시작:', symbols.join(', '));

    // WS delta 방식이라 초기 스냅샷이 없음 → REST로 초기 호가 채우기
    initFromRest().catch(e => console.warn('[BithumbStablecoinWs] REST 초기화 실패:', e.message));
  });

  currentWs.on('message', (data: Buffer) => {
    if (ws !== currentWs) return;
    try {
      const msg = JSON.parse(data.toString());
      // status 메시지는 무시 ({"status":"0000","resmsg":"Connected Successfully"})
      if (msg.status !== undefined) return;
      if (msg.type !== 'orderbookdepth' || !Array.isArray(msg.content?.list)) return;

      for (const entry of msg.content.list) {
        const symbol = typeof entry.symbol === 'string'
          ? entry.symbol.replace('_KRW', '')
          : null;
        if (!symbol || !(BITHUMB_STABLECOIN_SYMBOLS as readonly string[]).includes(symbol)) continue;
        applyDelta(symbol, entry.orderType, String(entry.price), String(entry.quantity));
      }
    } catch (err: any) {
      console.error('[BithumbStablecoinWs] 메시지 파싱 오류:', err.message);
    }
  });

  currentWs.on('close', (code: number) => {
    if (ws !== currentWs) return;
    ws = null;
    console.log(`[BithumbStablecoinWs] 연결 종료 (code=${code}) — 재연결 예약`);
    if (subscriberCount > 0) {
      scheduleReconnect();
      startRestFallback();
    }
  });

  currentWs.on('error', (err: Error) => {
    console.error('[BithumbStablecoinWs] 오류:', err.message);
    if (ws === currentWs) ws = null;
  });
}

// ── REST 주기 폴링 (WS 연결 여부와 무관하게 항상 실행) ─────────────────────────
// WS delta는 호가 변동 시에만 오므로, 얇은 시장(USDS 등)은 10s+ 무업데이트 가능.
// 10s 주기 REST 폴링으로 TRADING_FRESHNESS_MS(10s) 이내 보장.
const REST_FALLBACK_INTERVAL_MS = 8_000;
let restFallbackTimer: NodeJS.Timeout | null = null;

function startRestFallback(): void {
  if (restFallbackTimer) return;
  restFallbackTimer = setInterval(async () => {
    await initFromRest().catch(e =>
      console.warn('[BithumbStablecoinWs] REST 주기 갱신 실패:', e.message),
    );
  }, REST_FALLBACK_INTERVAL_MS);
  console.log('[BithumbStablecoinWs] REST 주기 폴링 시작 (8s 주기, WS와 병행)');
}

function stopRestFallback(): void {
  if (restFallbackTimer) {
    clearInterval(restFallbackTimer);
    restFallbackTimer = null;
    console.log('[BithumbStablecoinWs] REST fallback 폴링 중지');
  }
}

// ── 공개 API ─────────────────────────────────────────────────────────────────

/** Observer/Agent에서 호출 — ref count 증가 + WS 연결 (이미 연결 중이면 no-op) */
export function subscribeBithumbStablecoinOrderbooks(): void {
  subscriberCount++;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  connectInternal();
  startRestFallback();
}

/** Observer/Agent 종료 시 호출 — ref count 감소, 마지막 구독자 해제 시 WS 종료 */
export function unsubscribeBithumbStablecoinOrderbooks(): void {
  subscriberCount = Math.max(0, subscriberCount - 1);
  if (subscriberCount > 0) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopRestFallback();
  if (ws) {
    ws.close();
    ws = null;
  }
  localBooks.clear();
  cache.clear();
}

/** 단일 심볼 최우선 호가 조회 (캐시 stale 또는 없으면 null) */
export function getBithumbStablecoinOrderbook(symbol: string): BithumbOrderbookTop | null {
  const entry = cache.get(symbol);
  if (!entry || Date.now() - entry.timestamp > CACHE_TTL_MS) return null;
  return entry;
}

/**
 * 거래 결정(게이트 체크 + 주문 실행)에만 사용하는 엄격한 freshness 조회.
 * TRADING_FRESHNESS_MS(10초)보다 오래된 데이터는 null 반환 → 봇이 해당 사이클을 스킵.
 * UI 표시 등 비거래 용도는 getBithumbStablecoinOrderbook 사용.
 */
export function getBithumbOrderbookForTrading(symbol: string): BithumbOrderbookTop | null {
  const entry = cache.get(symbol);
  if (!entry || Date.now() - entry.timestamp > TRADING_FRESHNESS_MS) return null;
  return entry;
}

/** 전체 심볼 호가 캐시 (불변 복사본) */
export function getAllBithumbStablecoinOrderbooks(): ReadonlyMap<string, BithumbOrderbookTop> {
  return new Map(cache);
}

/** WS 연결 상태 */
export function isBithumbStablecoinWsConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}
