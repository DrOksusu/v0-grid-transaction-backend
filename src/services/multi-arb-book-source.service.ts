// 거래소별 배치 호가(bid/ask) 조회 어댑터 (spec §Task2)
// 전 종목 스캔이므로 코인별 개별 호출 금지 — 거래소당 1~수 콜의 배치 엔드포인트만 사용 (모두 public, 인증 불필요)
// KRW권(업비트/빗썸)은 depth levels까지 배치로 채우고, USDT권(바낸/MEXC/Gate)은 최우선호가만 채운다.
import axios from 'axios';
import { BookLevel, BookMap, MultiArbExchange } from './multi-arb-types';

const HTTP_TIMEOUT_MS = 10000;
const UPBIT_ORDERBOOK_CHUNK = 100; // 업비트 /v1/orderbook markets 파라미터 안전 상한

class MultiArbBookSourceService {
  // 업비트: GET /v1/orderbook?markets=KRW-A,KRW-B,... (100개 청크, 각 최대 30호가)
  async fetchUpbitBooks(symbols: string[]): Promise<BookMap> {
    const map: BookMap = new Map();
    for (let i = 0; i < symbols.length; i += UPBIT_ORDERBOOK_CHUNK) {
      const chunk = symbols.slice(i, i + UPBIT_ORDERBOOK_CHUNK);
      const markets = chunk.map((s) => `KRW-${s}`).join(',');
      const res = await axios.get(`https://api.upbit.com/v1/orderbook?markets=${markets}`, { timeout: HTTP_TIMEOUT_MS });
      for (const item of res.data ?? []) {
        if (typeof item.market !== 'string' || !item.market.startsWith('KRW-')) continue;
        const units: any[] = item.orderbook_units ?? [];
        if (units.length === 0) continue;
        const ask = Number(units[0].ask_price);
        const bid = Number(units[0].bid_price);
        if (!(ask > 0) || !(bid > 0)) continue;
        // (MEDIUM-2) vwapForNotional/vwapForQuantity는 askLevels 오름차·bidLevels 내림차 순서를 계약으로 가정한다.
        // 거래소 응답 순서를 신뢰하지 않고 파싱 시점에 명시 정렬 + qty<=0 레벨 제외.
        const askLevels: BookLevel[] = units
          .map((u) => ({ price: Number(u.ask_price), qty: Number(u.ask_size) }))
          .filter((l) => l.qty > 0)
          .sort((a, b) => a.price - b.price);
        const bidLevels: BookLevel[] = units
          .map((u) => ({ price: Number(u.bid_price), qty: Number(u.bid_size) }))
          .filter((l) => l.qty > 0)
          .sort((a, b) => b.price - a.price);
        map.set(item.market.slice(4), { ask, bid, askLevels, bidLevels });
      }
    }
    return map;
  }

  // 빗썸: GET /public/orderbook/ALL_KRW (1콜, 각 5호가)
  async fetchBithumbBooks(): Promise<BookMap> {
    const res = await axios.get('https://api.bithumb.com/public/orderbook/ALL_KRW', { timeout: HTTP_TIMEOUT_MS });
    if (res.data?.status !== '0000') throw new Error(`Bithumb ALL_KRW orderbook 응답 오류: status=${res.data?.status}`);
    const map: BookMap = new Map();
    for (const [key, value] of Object.entries<any>(res.data.data ?? {})) {
      if (key === 'date') continue; // 응답에 섞여 있는 타임스탬프 키
      const asks: any[] = value?.asks ?? [];
      const bids: any[] = value?.bids ?? [];
      if (asks.length === 0 || bids.length === 0) continue;
      const ask = parseFloat(asks[0].price);
      const bid = parseFloat(bids[0].price);
      if (!(ask > 0) || !(bid > 0)) continue;
      // (MEDIUM-2) 정렬 계약 명시 보장 + qty<=0 레벨 제외 (업비트 파서와 동일 정책)
      const askLevels: BookLevel[] = asks
        .map((a) => ({ price: parseFloat(a.price), qty: parseFloat(a.quantity) }))
        .filter((l) => l.qty > 0)
        .sort((a, b) => a.price - b.price);
      const bidLevels: BookLevel[] = bids
        .map((b) => ({ price: parseFloat(b.price), qty: parseFloat(b.quantity) }))
        .filter((l) => l.qty > 0)
        .sort((a, b) => b.price - a.price);
      map.set(key.toUpperCase(), { ask, bid, askLevels, bidLevels });
    }
    return map;
  }

  // 바이낸스: GET /api/v3/ticker/bookTicker (전 종목 1콜, 최우선호가만) → *USDT만
  async fetchBinanceBooks(): Promise<BookMap> {
    const res = await axios.get('https://api.binance.com/api/v3/ticker/bookTicker', { timeout: HTTP_TIMEOUT_MS });
    return this.parseBookTickerArray(res.data);
  }

  // MEXC: GET /api/v3/ticker/bookTicker (바이낸스 호환 포맷)
  async fetchMexcBooks(): Promise<BookMap> {
    const res = await axios.get('https://api.mexc.com/api/v3/ticker/bookTicker', { timeout: HTTP_TIMEOUT_MS });
    return this.parseBookTickerArray(res.data);
  }

  // Gate.io: GET /api/v4/spot/tickers (전 종목 1콜, 최우선호가만) → *_USDT만
  async fetchGateioBooks(): Promise<BookMap> {
    const res = await axios.get('https://api.gateio.ws/api/v4/spot/tickers', { timeout: HTTP_TIMEOUT_MS });
    const map: BookMap = new Map();
    for (const item of res.data ?? []) {
      const pair = String(item.currency_pair ?? '');
      if (!pair.endsWith('_USDT')) continue;
      const ask = parseFloat(item.lowest_ask);
      const bid = parseFloat(item.highest_bid);
      if (!(ask > 0) || !(bid > 0)) continue;
      map.set(pair.slice(0, -5).toUpperCase(), { ask, bid });
    }
    return map;
  }

  // 5개 거래소 병렬 조회 — 실패 거래소는 키 자체를 제외 (기존 fetchAllPrices와 동일 패턴)
  async fetchAllBooks(upbitSymbols: string[]): Promise<Partial<Record<MultiArbExchange, BookMap>>> {
    const exchanges: MultiArbExchange[] = ['upbit', 'bithumb', 'binance', 'mexc', 'gateio'];
    const results = await Promise.allSettled([
      this.fetchUpbitBooks(upbitSymbols),
      this.fetchBithumbBooks(),
      this.fetchBinanceBooks(),
      this.fetchMexcBooks(),
      this.fetchGateioBooks(),
    ]);
    const out: Partial<Record<MultiArbExchange, BookMap>> = {};
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        out[exchanges[i]] = r.value;
      } else {
        console.error(`[MultiArbBookSource] ${exchanges[i]} 호가 조회 실패:`, r.reason?.message ?? r.reason);
      }
    });
    return out;
  }

  // 바이낸스/MEXC 공통: [{ symbol:'BTCUSDT', bidPrice, bidQty, askPrice, askQty }] → BookMap
  private parseBookTickerArray(rows: any[]): BookMap {
    const map: BookMap = new Map();
    for (const item of rows ?? []) {
      const symbol = String(item.symbol ?? '');
      if (!symbol.endsWith('USDT')) continue;
      const ask = parseFloat(item.askPrice);
      const bid = parseFloat(item.bidPrice);
      if (!(ask > 0) || !(bid > 0)) continue;
      map.set(symbol.slice(0, -4).toUpperCase(), { ask, bid });
    }
    return map;
  }
}

export const multiArbBookSource = new MultiArbBookSourceService();
