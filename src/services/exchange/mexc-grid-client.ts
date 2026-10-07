// MEXC 현물 그리드 어댑터 — GridTradeClient 규격 구현.
// 재고형 아비용 MexcLeg(IOC)와 별개: 그리드는 GTC 지정가 + 체결 폴링이 필요하다.
import axios from 'axios';
import { MEXC } from './exchange-signer';

/** 수량을 stepSize 배수로 내림(floor). 거래소 LOT_SIZE 통과용. */
export function roundToStep(qty: number, step: number): number {
  if (!(step > 0)) return qty;
  return Math.floor(qty / step) * step;
}

/** 가격을 tickSize 배수로 내림(floor). PRICE_FILTER 통과용. */
export function roundToTick(price: number, tick: number): number {
  if (!(tick > 0)) return price;
  return Math.floor(price / tick) * tick;
}

/** qty*price 가 minNotional 이상인지. */
export function meetsMinNotional(qty: number, price: number, minNotional: number): boolean {
  return qty * price >= minNotional;
}

interface SymbolFilters { tickSize: number; stepSize: number; minNotional: number; }

export class MexcGridClient {
  private filtersCache = new Map<string, { at: number; f: SymbolFilters }>();

  constructor(private readonly creds: { apiKey: string; secretKey: string }) {}

  /** exchangeInfo 필터 조회(공개 API, 1시간 캐시). 실패 시 보수적 기본값. */
  async getFilters(symbol: string): Promise<SymbolFilters> {
    const hit = this.filtersCache.get(symbol);
    if (hit && Date.now() - hit.at < 3600_000) return hit.f;
    try {
      const res = await axios.get(`${MEXC.baseUrl}/api/v3/exchangeInfo?symbol=${symbol}`, { timeout: 8000 });
      const info = res.data?.symbols?.[0];
      const filters: any[] = info?.filters ?? [];
      const price = filters.find((x) => x.filterType === 'PRICE_FILTER');
      const lot = filters.find((x) => x.filterType === 'LOT_SIZE');
      const notional = filters.find((x) => x.filterType === 'NOTIONAL' || x.filterType === 'MIN_NOTIONAL');
      const f: SymbolFilters = {
        tickSize: Number(price?.tickSize) || 0.01,
        stepSize: Number(lot?.stepSize) || 0.000001,
        minNotional: Number(notional?.minNotional) || 1,
      };
      this.filtersCache.set(symbol, { at: Date.now(), f });
      return f;
    } catch {
      return { tickSize: 0.01, stepSize: 0.000001, minNotional: 1 };
    }
  }
}
