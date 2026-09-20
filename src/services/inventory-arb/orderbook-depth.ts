// 업비트·빗썸 공개 REST 호가(다단계 depth) 조회 → BookTop(레벨 배열 포함) 반환.
// 인증 불필요(공개 호가). 실패 시 null (호출자는 skip).
import type { BookTop, BookLevel, ExchangeName } from './types';

const UPBIT_ORDERBOOK = 'https://api.upbit.com/v1/orderbook';
const BITHUMB_ORDERBOOK = 'https://api.bithumb.com/public/orderbook';
const FETCH_TIMEOUT_MS = 4000;

async function fetchJson(url: string): Promise<any | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return null;
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** BookLevel 배열로 BookTop 구성 (bids 내림차순, asks 오름차순 정렬 보장) */
function buildBook(bids: BookLevel[], asks: BookLevel[]): BookTop | null {
  const b = bids.filter((x) => x.price > 0 && x.qty > 0).sort((x, y) => y.price - x.price);
  const a = asks.filter((x) => x.price > 0 && x.qty > 0).sort((x, y) => x.price - y.price);
  if (b.length === 0 || a.length === 0) return null;
  return { bid: b[0].price, ask: a[0].price, bidQty: b[0].qty, askQty: a[0].qty, bids: b, asks: a };
}

/**
 * 업비트 다중 마켓 호가를 한 번의 REST 호출로 조회 (후보 스캔 효율).
 * @returns symbol → BookTop 맵 (조회 실패/누락 심볼은 맵에 없음)
 */
export async function fetchUpbitDepthBatch(symbols: string[]): Promise<Map<string, BookTop>> {
  const out = new Map<string, BookTop>();
  if (symbols.length === 0) return out;
  const markets = symbols.map((s) => `KRW-${s}`).join(',');
  const j = await fetchJson(`${UPBIT_ORDERBOOK}?markets=${markets}`);
  if (!Array.isArray(j)) return out;
  for (const entry of j) {
    const market: string = entry?.market ?? '';
    const sym = market.startsWith('KRW-') ? market.slice(4) : '';
    const units = entry?.orderbook_units;
    if (!sym || !Array.isArray(units) || units.length === 0) continue;
    const bids: BookLevel[] = units.map((u: any) => ({ price: Number(u.bid_price), qty: Number(u.bid_size) }));
    const asks: BookLevel[] = units.map((u: any) => ({ price: Number(u.ask_price), qty: Number(u.ask_size) }));
    const book = buildBook(bids, asks);
    if (book) out.set(sym, book);
  }
  return out;
}

/**
 * 거래소별 다단계 호가 조회.
 * @param symbol base 심볼 (예: "XRP")
 */
export async function fetchOrderbookDepth(exchange: ExchangeName, symbol: string): Promise<BookTop | null> {
  if (exchange === 'upbit') {
    const j = await fetchJson(`${UPBIT_ORDERBOOK}?markets=KRW-${symbol}`);
    const units = j?.[0]?.orderbook_units;
    if (!Array.isArray(units) || units.length === 0) return null;
    const bids: BookLevel[] = units.map((u: any) => ({ price: Number(u.bid_price), qty: Number(u.bid_size) }));
    const asks: BookLevel[] = units.map((u: any) => ({ price: Number(u.ask_price), qty: Number(u.ask_size) }));
    return buildBook(bids, asks);
  } else {
    const j = await fetchJson(`${BITHUMB_ORDERBOOK}/${symbol}_KRW?count=10`);
    const d = j?.data;
    if (!d || !Array.isArray(d.bids) || !Array.isArray(d.asks)) return null;
    const bids: BookLevel[] = d.bids.map((x: any) => ({ price: Number(x.price), qty: Number(x.quantity) }));
    const asks: BookLevel[] = d.asks.map((x: any) => ({ price: Number(x.price), qty: Number(x.quantity) }));
    return buildBook(bids, asks);
  }
}
