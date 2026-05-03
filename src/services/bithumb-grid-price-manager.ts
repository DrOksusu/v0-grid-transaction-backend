/**
 * Bithumb Grid Price Manager
 *
 * 빗썸 REST API 폴링 기반 가격 관리자 (WebSocket 미지원).
 * UpbitPriceManager와 동일한 인터페이스를 제공해 BotEngine + TradingService에서 투명하게 교체 가능.
 *
 * - 5초마다 구독된 티커 일괄 조회 (GET /v1/ticker)
 * - 가격 리스너 패턴 지원 (가격 크로스 감지용)
 */

import axios from 'axios';

const BITHUMB_API_URL = 'https://api.bithumb.com';
const POLL_INTERVAL_MS = 5000;
const CACHE_TTL_MS = 30000;

interface PriceCache {
  price: number;
  timestamp: number;
}

class BithumbGridPriceManager {
  private static instance: BithumbGridPriceManager;

  private priceCache: Map<string, PriceCache> = new Map();
  private subscriptions: Set<string> = new Set();
  private pollTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  private priceListeners: Array<(ticker: string, price: number) => void> = [];

  private constructor() {}

  static getInstance(): BithumbGridPriceManager {
    if (!BithumbGridPriceManager.instance) {
      BithumbGridPriceManager.instance = new BithumbGridPriceManager();
    }
    return BithumbGridPriceManager.instance;
  }

  connect(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const poll = async () => {
      if (!this.isRunning) return;
      if (this.subscriptions.size > 0) {
        await this.fetchPrices();
      }
      if (this.isRunning) {
        this.pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    poll();
    console.log('[BithumbPriceManager] REST 폴링 시작');
  }

  disconnect(): void {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.subscriptions.clear();
    this.priceCache.clear();
    console.log('[BithumbPriceManager] 폴링 중지');
  }

  subscribe(ticker: string): void {
    this.subscriptions.add(ticker.toUpperCase());
  }

  unsubscribe(ticker: string): void {
    const t = ticker.toUpperCase();
    this.subscriptions.delete(t);
    this.priceCache.delete(t);
  }

  getPrice(ticker: string): number | null {
    const cached = this.priceCache.get(ticker.toUpperCase());
    if (!cached) return null;
    if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
      this.priceCache.delete(ticker.toUpperCase());
      return null;
    }
    return cached.price;
  }

  async getPriceWithFallback(ticker: string): Promise<number> {
    const cached = this.getPrice(ticker);
    if (cached !== null) return cached;

    // 캐시 없으면 즉시 조회
    const price = await this.fetchSinglePrice(ticker.toUpperCase());
    if (price === null) throw new Error(`[BithumbPriceManager] 현재가 조회 실패: ${ticker}`);
    return price;
  }

  onPrice(callback: (ticker: string, price: number) => void): void {
    this.priceListeners.push(callback);
  }

  removeOnPrice(callback: (ticker: string, price: number) => void): void {
    this.priceListeners = this.priceListeners.filter(cb => cb !== callback);
  }

  getConnectionStatus(): { connected: boolean; subscriptions: string[]; cacheSize: number } {
    return {
      connected: this.isRunning,
      subscriptions: Array.from(this.subscriptions),
      cacheSize: this.priceCache.size,
    };
  }

  // 구독된 모든 티커 일괄 조회
  private async fetchPrices(): Promise<void> {
    if (this.subscriptions.size === 0) return;

    const markets = Array.from(this.subscriptions).join(',');
    try {
      const { data } = await axios.get<Array<{ market: string; trade_price: number }>>(
        `${BITHUMB_API_URL}/v1/ticker`,
        { params: { markets }, timeout: 5000 },
      );

      if (!Array.isArray(data)) return;

      const now = Date.now();
      for (const item of data) {
        if (!item.market || !item.trade_price) continue;
        const prev = this.priceCache.get(item.market)?.price;
        this.priceCache.set(item.market, { price: item.trade_price, timestamp: now });

        // 가격이 변경됐을 때만 리스너 호출
        if (prev !== item.trade_price) {
          for (const listener of this.priceListeners) {
            try { listener(item.market, item.trade_price); } catch { /* isolate */ }
          }
        }
      }
    } catch (err: any) {
      console.error('[BithumbPriceManager] 가격 조회 실패:', err.message);
    }
  }

  // 단건 즉시 조회 (fallback용)
  private async fetchSinglePrice(ticker: string): Promise<number | null> {
    try {
      const { data } = await axios.get<Array<{ market: string; trade_price: number }>>(
        `${BITHUMB_API_URL}/v1/ticker`,
        { params: { markets: ticker }, timeout: 5000 },
      );
      if (Array.isArray(data) && data[0]?.trade_price) {
        const price = data[0].trade_price;
        this.priceCache.set(ticker, { price, timestamp: Date.now() });
        return price;
      }
      return null;
    } catch {
      return null;
    }
  }
}

export const bithumbPriceManager = BithumbGridPriceManager.getInstance();
