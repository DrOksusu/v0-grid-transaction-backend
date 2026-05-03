import prisma from '../config/database';

interface ExchangeResult {
  exchange: string;
  price: number | null;
}

const FETCH_TIMEOUT_MS = 5000;

async function fetchWithTimeout(url: string, options?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUpbitPrice(symbol: string): Promise<number | null> {
  try {
    const res = await fetchWithTimeout(
      `https://api.upbit.com/v1/ticker?markets=KRW-${symbol}`,
      { headers: { accept: 'application/json' } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as any[];
    return data[0]?.trade_price ?? null;
  } catch {
    return null;
  }
}

async function fetchBithumbPrice(symbol: string): Promise<number | null> {
  try {
    const res = await fetchWithTimeout(
      `https://api.bithumb.com/public/ticker/${symbol}_KRW`,
      { headers: { accept: 'application/json' } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    if (data.status !== '0000') return null;
    const price = parseFloat(data.data?.closing_price);
    return isNaN(price) ? null : price;
  } catch {
    return null;
  }
}

async function fetchBinancePrice(symbol: string): Promise<number | null> {
  try {
    const res = await fetchWithTimeout(
      `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const price = parseFloat(data.price);
    return isNaN(price) ? null : price;
  } catch {
    return null;
  }
}

async function fetchBybitPrice(symbol: string): Promise<number | null> {
  try {
    const res = await fetchWithTimeout(
      `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${symbol}USDT`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const price = parseFloat(data.result?.list?.[0]?.lastPrice);
    return isNaN(price) ? null : price;
  } catch {
    return null;
  }
}

async function fetchMexcPrice(symbol: string): Promise<number | null> {
  try {
    const res = await fetchWithTimeout(
      `https://api.mexc.com/api/v3/ticker/price?symbol=${symbol}USDT`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const price = parseFloat(data.price);
    return isNaN(price) ? null : price;
  } catch {
    return null;
  }
}

export async function fetchAllExchangePrices(symbol: string): Promise<ExchangeResult[]> {
  const [upbit, bithumb, binance, bybit, mexc] = await Promise.allSettled([
    fetchUpbitPrice(symbol),
    fetchBithumbPrice(symbol),
    fetchBinancePrice(symbol),
    fetchBybitPrice(symbol),
    fetchMexcPrice(symbol),
  ]);

  return [
    { exchange: 'upbit', price: upbit.status === 'fulfilled' ? upbit.value : null },
    { exchange: 'bithumb', price: bithumb.status === 'fulfilled' ? bithumb.value : null },
    { exchange: 'binance', price: binance.status === 'fulfilled' ? binance.value : null },
    { exchange: 'bybit', price: bybit.status === 'fulfilled' ? bybit.value : null },
    { exchange: 'mexc', price: mexc.status === 'fulfilled' ? mexc.value : null },
  ];
}

export async function recordPriceSnapshot(
  announcementId: number,
  symbol: string,
  snapshotType: string,
): Promise<void> {
  const prices = await fetchAllExchangePrices(symbol);
  const available = prices.filter(p => p.price !== null);

  if (available.length === 0) {
    console.warn(`[ListingTracker] ${snapshotType} 스냅샷: ${symbol} — 모든 거래소 가격 조회 실패`);
    return;
  }

  await (prisma as any).listingPriceSnapshot.createMany({
    data: available.map(p => ({
      announcementId,
      exchange: p.exchange,
      price: p.price!,
      snapshotType,
      recordedAt: new Date(),
    })),
  });

  const summary = prices
    .map(p => `${p.exchange}=${p.price !== null ? p.price : 'N/A'}`)
    .join(', ');
  console.log(`[ListingTracker] ${symbol} ${snapshotType} 스냅샷 저장 — ${summary}`);
}
