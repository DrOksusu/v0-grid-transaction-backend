// MEXC 현물 현재가 피드(그리드용). MVP는 REST 폴링 + 2초 캐시. 실시간 WS는 후속.
import axios from 'axios';
import { MEXC } from './exchange/exchange-signer';

const CACHE_MS = 2000;

class MexcGridPriceManager {
  private cache = new Map<string, { at: number; price: number }>();

  /** 심볼(BTCUSDT) 현재가. 2초 캐시. 실패 시 직전 캐시가 있으면 반환, 없으면 throw. */
  async getPriceWithFallback(ticker: string): Promise<number> {
    const hit = this.cache.get(ticker);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.price;
    try {
      const res = await axios.get(`${MEXC.baseUrl}/api/v3/ticker/price?symbol=${ticker}`, { timeout: 8000 });
      const price = parseFloat(res.data?.price ?? '0');
      if (!(price > 0)) throw new Error(`MEXC 현재가 이상: ${res.data?.price}`);
      this.cache.set(ticker, { at: Date.now(), price });
      return price;
    } catch (e) {
      if (hit) return hit.price; // 폴백: 직전값
      throw e;
    }
  }
}

export const mexcGridPriceManager = new MexcGridPriceManager();
