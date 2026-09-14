// 거래소별 배치 시세 조회 어댑터 (spec §4 ExchangePriceSource)
// 전 종목 스캔이므로 코인별 개별 호출 금지 — 거래소당 1~수 콜의 배치 엔드포인트만 사용 (모두 public, 인증 불필요)
import axios from 'axios';
import { MultiArbExchange, PriceMap } from './multi-arb-types';

const HTTP_TIMEOUT_MS = 10000;
const UPBIT_TICKER_CHUNK = 100; // 업비트 /v1/ticker markets 파라미터 안전 상한

class MultiArbPriceSourceService {
  // 업비트: GET /v1/ticker?markets=KRW-A,KRW-B,... (100개 청크)
  async fetchUpbit(symbols: string[]): Promise<PriceMap> {
    const map: PriceMap = new Map();
    for (let i = 0; i < symbols.length; i += UPBIT_TICKER_CHUNK) {
      const chunk = symbols.slice(i, i + UPBIT_TICKER_CHUNK);
      const markets = chunk.map(s => `KRW-${s}`).join(',');
      const res = await axios.get(`https://api.upbit.com/v1/ticker?markets=${markets}`, { timeout: HTTP_TIMEOUT_MS });
      for (const item of res.data ?? []) {
        const price = Number(item.trade_price);
        if (typeof item.market === 'string' && item.market.startsWith('KRW-') && price > 0) {
          map.set(item.market.slice(4), price);
        }
      }
    }
    return map;
  }

  // 빗썸: GET /public/ticker/ALL_KRW (1콜)
  async fetchBithumb(): Promise<PriceMap> {
    const res = await axios.get('https://api.bithumb.com/public/ticker/ALL_KRW', { timeout: HTTP_TIMEOUT_MS });
    if (res.data?.status !== '0000') throw new Error(`Bithumb ALL_KRW 응답 오류: status=${res.data?.status}`);
    const map: PriceMap = new Map();
    for (const [key, value] of Object.entries<any>(res.data.data ?? {})) {
      if (key === 'date') continue; // 응답에 섞여 있는 타임스탬프 키
      const price = parseFloat(value?.closing_price);
      if (price > 0) map.set(key.toUpperCase(), price);
    }
    return map;
  }

  // 바이낸스: GET /api/v3/ticker/price (전 종목 1콜) → *USDT만
  async fetchBinance(): Promise<PriceMap> {
    const res = await axios.get('https://api.binance.com/api/v3/ticker/price', { timeout: HTTP_TIMEOUT_MS });
    return this.parseUsdtSymbolArray(res.data);
  }

  // MEXC: GET /api/v3/ticker/price (바이낸스 호환 포맷)
  async fetchMexc(): Promise<PriceMap> {
    const res = await axios.get('https://api.mexc.com/api/v3/ticker/price', { timeout: HTTP_TIMEOUT_MS });
    return this.parseUsdtSymbolArray(res.data);
  }

  // Gate.io: GET /api/v4/spot/tickers (전 종목 1콜) → *_USDT만
  async fetchGateio(): Promise<PriceMap> {
    const res = await axios.get('https://api.gateio.ws/api/v4/spot/tickers', { timeout: HTTP_TIMEOUT_MS });
    const map: PriceMap = new Map();
    for (const item of res.data ?? []) {
      const pair = String(item.currency_pair ?? '');
      if (!pair.endsWith('_USDT')) continue;
      const price = parseFloat(item.last);
      if (price > 0) map.set(pair.slice(0, -5).toUpperCase(), price);
    }
    return map;
  }

  // 5개 거래소 병렬 조회 — 실패 거래소는 키 자체를 제외 (spec §9: 하나 실패해도 나머지 진행)
  async fetchAllPrices(upbitSymbols: string[]): Promise<Partial<Record<MultiArbExchange, PriceMap>>> {
    const exchanges: MultiArbExchange[] = ['upbit', 'bithumb', 'binance', 'mexc', 'gateio'];
    const results = await Promise.allSettled([
      this.fetchUpbit(upbitSymbols),
      this.fetchBithumb(),
      this.fetchBinance(),
      this.fetchMexc(),
      this.fetchGateio(),
    ]);
    const out: Partial<Record<MultiArbExchange, PriceMap>> = {};
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        out[exchanges[i]] = r.value;
      } else {
        console.error(`[MultiArbPriceSource] ${exchanges[i]} 시세 조회 실패:`, r.reason?.message ?? r.reason);
      }
    });
    return out;
  }

  // 김프 환산용 KRW/USDT 환율 (업비트 KRW-USDT, spec §5 step 7) — 실패 시 null (김프 표시는 참고용)
  async getKrwPerUsdt(): Promise<number | null> {
    try {
      const res = await axios.get('https://api.upbit.com/v1/ticker?markets=KRW-USDT', { timeout: 5000 });
      const price = Number(res.data?.[0]?.trade_price);
      return price > 0 ? price : null;
    } catch {
      return null;
    }
  }

  // 바이낸스/MEXC 공통: [{ symbol: 'BTCUSDT', price: '65000' }] → base 맵
  private parseUsdtSymbolArray(rows: any[]): PriceMap {
    const map: PriceMap = new Map();
    for (const item of rows ?? []) {
      const symbol = String(item.symbol ?? '');
      if (!symbol.endsWith('USDT')) continue;
      const price = parseFloat(item.price);
      if (price > 0) map.set(symbol.slice(0, -4).toUpperCase(), price);
    }
    return map;
  }
}

export const multiArbPriceSource = new MultiArbPriceSourceService();
