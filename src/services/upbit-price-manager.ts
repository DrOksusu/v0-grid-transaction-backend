/**
 * Upbit WebSocket Price Manager
 *
 * 실시간 시세를 WebSocket으로 수신하여 캐싱
 * - 단일 WebSocket 연결로 모든 봇의 시세 수신
 * - IP Rate Limit 문제 해결
 * - 실시간 가격 업데이트
 */

import WebSocket from 'ws';
import { UpbitService } from './upbit.service';
import { socketService } from './socket.service';

interface TickerData {
  type: string;
  code: string;
  trade_price: number;
  trade_volume: number;
  ask_bid: string;
  prev_closing_price: number;
  change: string;
  change_price: number;
  signed_change_price: number;
  change_rate: number;
  signed_change_rate: number;
  trade_date: string;
  trade_time: string;
  trade_timestamp: number;
  timestamp: number;
}

interface PriceCache {
  price: number;
  timestamp: number;
  data: TickerData;
}

// 변동성 추적용 인터페이스
interface VolatilityData {
  high: number;
  low: number;
  prices: Array<{ price: number; timestamp: number }>;
  lastCalculated: number;
  volatility: number; // 퍼센트
}

// 클라이언트 브로드캐스트용 버퍼
interface BroadcastBuffer {
  prices: Map<string, {
    ticker: string;
    price: number;
    change24h: number;
    volume24h: number;
  }>;
  lastBroadcast: number;
}

class UpbitPriceManager {
  private static instance: UpbitPriceManager;

  private ws: WebSocket | null = null;
  private priceCache: Map<string, PriceCache> = new Map();
  private volatilityCache: Map<string, VolatilityData> = new Map();
  private subscriptions: Set<string> = new Set();
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private broadcastInterval: NodeJS.Timeout | null = null;

  // 클라이언트 브로드캐스트 버퍼 (1초마다 일괄 전송)
  private broadcastBuffer: BroadcastBuffer = {
    prices: new Map(),
    lastBroadcast: 0,
  };

  // 가격 수신 리스너 (외부에서 가격 변동을 감지할 수 있도록)
  private priceListeners: Array<(ticker: string, price: number) => void> = [];

  private readonly WS_URL = 'wss://api.upbit.com/websocket/v1';
  private readonly PING_INTERVAL = 30000; // 30초마다 PING
  private readonly CACHE_TTL = 60000; // 캐시 유효기간 60초 (WebSocket 끊어졌을 때 대비)
  private readonly BROADCAST_INTERVAL = 1000; // 1초마다 클라이언트에 브로드캐스트
  private readonly VOLATILITY_WINDOW = 60000; // 변동성 계산 윈도우 (1분)

  private constructor() {}

  static getInstance(): UpbitPriceManager {
    if (!UpbitPriceManager.instance) {
      UpbitPriceManager.instance = new UpbitPriceManager();
    }
    return UpbitPriceManager.instance;
  }

  /**
   * WebSocket 연결 시작
   */
  connect(): void {
    if (this.ws && this.isConnected) {
      console.log('[PriceManager] Already connected');
      return;
    }

    console.log('[PriceManager] Connecting to Upbit WebSocket...');

    try {
      this.ws = new WebSocket(this.WS_URL);

      this.ws.on('open', () => {
        console.log('[PriceManager] WebSocket connected');
        this.isConnected = true;
        this.reconnectAttempts = 0;

        // 기존 구독 복원
        if (this.subscriptions.size > 0) {
          this.sendSubscription();
        }

        // Ping 시작
        this.startPing();

        // 클라이언트 브로드캐스트 시작
        this.startBroadcast();
      });

      this.ws.on('message', (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        console.log(`[PriceManager] WebSocket closed: ${code} - ${reason.toString()}`);
        this.isConnected = false;
        this.stopPing();
        this.scheduleReconnect();
      });

      this.ws.on('error', (error: Error) => {
        console.error('[PriceManager] WebSocket error:', error.message);
        this.isConnected = false;
      });

      this.ws.on('pong', () => {
        // Pong 수신 확인 (연결 유지)
      });

    } catch (error: any) {
      console.error('[PriceManager] Failed to connect:', error.message);
      this.scheduleReconnect();
    }
  }

  /**
   * WebSocket 연결 종료
   */
  disconnect(): void {
    console.log('[PriceManager] Disconnecting...');

    this.stopPing();
    this.stopBroadcast();

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
    this.subscriptions.clear();
    this.priceCache.clear();
    this.volatilityCache.clear();
    this.broadcastBuffer.prices.clear();
  }

  /**
   * 티커 구독 추가
   */
  subscribe(ticker: string): void {
    const normalizedTicker = ticker.toUpperCase();

    if (this.subscriptions.has(normalizedTicker)) {
      return;
    }

    // 구독 로그는 디버그 레벨 (필요시 주석 해제)
    // console.log(`[PriceManager] Subscribing to ${normalizedTicker}`);
    this.subscriptions.add(normalizedTicker);

    if (this.isConnected) {
      this.sendSubscription();
    }
  }

  /**
   * 티커 구독 제거
   */
  unsubscribe(ticker: string): void {
    const normalizedTicker = ticker.toUpperCase();

    if (!this.subscriptions.has(normalizedTicker)) {
      return;
    }

    // 구독 해제 로그는 디버그 레벨 (필요시 주석 해제)
    // console.log(`[PriceManager] Unsubscribing from ${normalizedTicker}`);
    this.subscriptions.delete(normalizedTicker);
    this.priceCache.delete(normalizedTicker);

    // 구독 목록이 변경되면 다시 구독 (Upbit는 증분 구독 미지원)
    if (this.isConnected && this.subscriptions.size > 0) {
      this.sendSubscription();
    }
  }

  /**
   * 현재가 조회 (캐시에서)
   * @returns 가격 또는 null (캐시 없음)
   */
  getPrice(ticker: string): number | null {
    const normalizedTicker = ticker.toUpperCase();
    const cached = this.priceCache.get(normalizedTicker);

    if (!cached) {
      return null;
    }

    // 캐시가 너무 오래되었으면 null 반환
    if (Date.now() - cached.timestamp > this.CACHE_TTL) {
      this.priceCache.delete(normalizedTicker);
      return null;
    }

    return cached.price;
  }

  /**
   * 현재가 조회 (캐시 + REST 폴백)
   * WebSocket 캐시가 없으면 REST API로 조회
   */
  async getPriceWithFallback(ticker: string): Promise<number> {
    const normalizedTicker = ticker.toUpperCase();

    // 1. 캐시에서 조회
    const cachedPrice = this.getPrice(normalizedTicker);
    if (cachedPrice !== null) {
      return cachedPrice;
    }

    // 2. 캐시 없으면 REST API 폴백 (로그 생략)

    try {
      const priceData = await UpbitService.getCurrentPrice(normalizedTicker);
      if (priceData && priceData.trade_price) {
        // REST 응답도 캐시에 저장
        this.priceCache.set(normalizedTicker, {
          price: priceData.trade_price,
          timestamp: Date.now(),
          data: priceData,
        });
        return priceData.trade_price;
      }
      throw new Error('가격 데이터 없음');
    } catch (error: any) {
      throw new Error(`현재가 조회 실패 (${normalizedTicker}): ${error.message}`);
    }
  }

  /**
   * 전체 시세 데이터 조회
   */
  getTickerData(ticker: string): TickerData | null {
    const normalizedTicker = ticker.toUpperCase();
    const cached = this.priceCache.get(normalizedTicker);

    if (!cached || Date.now() - cached.timestamp > this.CACHE_TTL) {
      return null;
    }

    return cached.data;
  }

  /**
   * 연결 상태 확인
   */
  getConnectionStatus(): { connected: boolean; subscriptions: string[]; cacheSize: number } {
    return {
      connected: this.isConnected,
      subscriptions: Array.from(this.subscriptions),
      cacheSize: this.priceCache.size,
    };
  }

  /**
   * 가격 수신 리스너 등록
   */
  onPrice(callback: (ticker: string, price: number) => void): void {
    this.priceListeners.push(callback);
  }

  /**
   * 가격 수신 리스너 해제
   */
  removeOnPrice(callback: (ticker: string, price: number) => void): void {
    this.priceListeners = this.priceListeners.filter(cb => cb !== callback);
  }

  /**
   * 변동성 업데이트 (내부 메서드)
   */
  private updateVolatility(ticker: string, price: number, timestamp: number): void {
    let data = this.volatilityCache.get(ticker);

    if (!data) {
      data = {
        high: price,
        low: price,
        prices: [],
        lastCalculated: timestamp,
        volatility: 0,
      };
      this.volatilityCache.set(ticker, data);
    }

    // 가격 기록 추가
    data.prices.push({ price, timestamp });

    // 오래된 가격 제거 (1분 윈도우)
    const cutoff = timestamp - this.VOLATILITY_WINDOW;
    data.prices = data.prices.filter(p => p.timestamp > cutoff);

    // 최고/최저 재계산
    if (data.prices.length > 0) {
      data.high = Math.max(...data.prices.map(p => p.price));
      data.low = Math.min(...data.prices.map(p => p.price));

      // 변동성 계산: (고가 - 저가) / 평균가 * 100
      const avg = (data.high + data.low) / 2;
      data.volatility = avg > 0 ? ((data.high - data.low) / avg) * 100 : 0;
      data.lastCalculated = timestamp;
    }
  }

  /**
   * 변동성 조회 (퍼센트)
   * @returns 변동성 퍼센트 (예: 2.5 = 2.5%)
   */
  getVolatility(ticker: string): number {
    const normalizedTicker = ticker.toUpperCase();
    const data = this.volatilityCache.get(normalizedTicker);
    return data?.volatility ?? 0;
  }

  /**
   * 변동성 기반 체크 간격 추천 (밀리초)
   */
  getRecommendedInterval(ticker: string): number {
    const volatility = this.getVolatility(ticker);

    if (volatility >= 5) return 3000;  // 5%+ → 3초
    if (volatility >= 3) return 5000;  // 3-5% → 5초
    if (volatility >= 1) return 10000; // 1-3% → 10초
    return 15000; // 1% 미만 → 15초
  }

  /**
   * 구독 메시지 전송
   */
  private sendSubscription(): void {
    if (!this.ws || !this.isConnected) {
      return;
    }

    const tickers = Array.from(this.subscriptions);

    if (tickers.length === 0) {
      return;
    }

    const message = JSON.stringify([
      { ticket: `grid-bot-${Date.now()}` },
      { type: 'ticker', codes: tickers },
      { format: 'DEFAULT' }
    ]);

    // 구독 시작 로그는 연결 시 1회만 출력
    if (this.reconnectAttempts === 0) {
      console.log(`[PriceManager] WebSocket 구독: ${tickers.length}개 종목`);
    }
    this.ws.send(message);
  }

  /**
   * 수신 메시지 처리
   */
  private handleMessage(data: Buffer): void {
    try {
      const message = JSON.parse(data.toString()) as TickerData;

      if (message.type === 'ticker' && message.code) {
        const now = Date.now();
        const price = message.trade_price;

        this.priceCache.set(message.code, {
          price: price,
          timestamp: now,
          data: message,
        });

        // 변동성 추적 업데이트
        this.updateVolatility(message.code, price, now);

        // 브로드캐스트 버퍼에 추가 (1초마다 일괄 전송됨)
        this.broadcastBuffer.prices.set(message.code, {
          ticker: message.code,
          price: price,
          change24h: message.signed_change_rate * 100, // 퍼센트로 변환
          volume24h: message.trade_volume,
        });

        // 가격 리스너 호출
        for (const listener of this.priceListeners) {
          try {
            listener(message.code, price);
          } catch (e) {
            // 리스너 에러가 WebSocket 처리를 방해하지 않도록
          }
        }
      }
    } catch (error: any) {
      // PING 응답 등 JSON이 아닌 메시지는 무시
      const text = data.toString();
      if (text !== 'PONG') {
        console.error('[PriceManager] Failed to parse message:', error.message);
      }
    }
  }

  /**
   * Ping 시작 (연결 유지)
   */
  private startPing(): void {
    this.stopPing();

    this.pingInterval = setInterval(() => {
      if (this.ws && this.isConnected) {
        try {
          this.ws.send('PING');
        } catch (error) {
          console.error('[PriceManager] Failed to send PING');
        }
      }
    }, this.PING_INTERVAL);
  }

  /**
   * Ping 중지
   */
  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * 클라이언트 브로드캐스트 시작 (1초마다)
   */
  private startBroadcast(): void {
    this.stopBroadcast();

    this.broadcastInterval = setInterval(() => {
      // 구독자가 없거나 버퍼가 비어있으면 스킵
      if (socketService.getPriceSubscribersCount() === 0) {
        return;
      }

      if (this.broadcastBuffer.prices.size === 0) {
        return;
      }

      // 버퍼의 가격 데이터를 배열로 변환해서 전송
      const prices = Array.from(this.broadcastBuffer.prices.values());
      socketService.emitPricesBatch(prices);

      // 버퍼 초기화
      this.broadcastBuffer.prices.clear();
      this.broadcastBuffer.lastBroadcast = Date.now();
    }, this.BROADCAST_INTERVAL);
  }

  /**
   * 클라이언트 브로드캐스트 중지
   */
  private stopBroadcast(): void {
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }
  }

  /**
   * 재연결 스케줄링 (지수 백오프)
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[PriceManager] Max reconnect attempts reached. Giving up.');
      return;
    }

    // 지수 백오프: 1초, 2초, 4초, 8초... (최대 30초)
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    console.log(`[PriceManager] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, delay);
  }
}

// 싱글톤 인스턴스 export
export const priceManager = UpbitPriceManager.getInstance();
