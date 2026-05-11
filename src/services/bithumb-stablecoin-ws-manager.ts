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

const CACHE_TTL_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 10;

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
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('[BithumbStablecoinWs] 최대 재연결 횟수 초과. REST fallback 으로 동작.');
    return;
  }
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30_000);
  reconnectAttempts++;
  console.log(`[BithumbStablecoinWs] ${delay}ms 후 재연결 (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
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
          console.log(`[BithumbStablecoinWs] REST 초기화: ${symbol} bid=${bid} bidQty=${bidQty} ask=${ask} askQty=${askQty}`);
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
    if (subscriberCount > 0) scheduleReconnect();
  });

  currentWs.on('error', (err: Error) => {
    console.error('[BithumbStablecoinWs] 오류:', err.message);
    if (ws === currentWs) ws = null;
  });
}

// ── 공개 API ─────────────────────────────────────────────────────────────────

/** Observer/Agent에서 호출 — ref count 증가 + WS 연결 (이미 연결 중이면 no-op) */
export function subscribeBithumbStablecoinOrderbooks(): void {
  subscriberCount++;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  connectInternal();
}

/** Observer/Agent 종료 시 호출 — ref count 감소, 마지막 구독자 해제 시 WS 종료 */
export function unsubscribeBithumbStablecoinOrderbooks(): void {
  subscriberCount = Math.max(0, subscriberCount - 1);
  if (subscriberCount > 0) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
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

/** 전체 심볼 호가 캐시 (불변 복사본) */
export function getAllBithumbStablecoinOrderbooks(): ReadonlyMap<string, BithumbOrderbookTop> {
  return new Map(cache);
}

/** WS 연결 상태 */
export function isBithumbStablecoinWsConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}
