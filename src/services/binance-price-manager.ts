/**
 * Binance WebSocket Price Manager
 *
 * 바이낸스 실시간 시세를 WebSocket으로 수신하여 캐싱
 * - @ticker 스트림으로 24시간 변동률, 거래대금 등 완전한 데이터 수신
 * - 1초마다 Socket.IO를 통해 프론트엔드에 브로드캐스트
 * - 지수 백오프 자동 재연결
 */

import WebSocket from 'ws';
import { socketService } from './socket.service';

interface BinanceTickerData {
  e: string;  // Event type (24hrTicker)
  s: string;  // Symbol (BTCUSDT)
  c: string;  // Last price
  P: string;  // Price change percent (24h)
  q: string;  // Total traded quote asset volume (거래대금)
  h: string;  // High price (24h)
  l: string;  // Low price (24h)
  o: string;  // Open price
  v: string;  // Total traded base asset volume
  E: number;  // Event time
}

interface BinancePriceCache {
  price: number;
  change24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  timestamp: number;
  rawData: BinanceTickerData;
}

class BinancePriceManager {
  private static instance: BinancePriceManager;

  private ws: WebSocket | null = null;
  private priceCache: Map<string, BinancePriceCache> = new Map();
  private subscriptions: Set<string> = new Set();
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private broadcastInterval: NodeJS.Timeout | null = null;

  // 클라이언트 브로드캐스트 버퍼 (1초마다 일괄 전송)
  private broadcastBuffer: Map<string, {
    ticker: string;
    price: number;
    change24h: number;
    volume24h: number;
  }> = new Map();

  private readonly BASE_WS_URL = 'wss://stream.binance.com:9443/ws';
  private readonly CACHE_TTL = 60000; // 캐시 유효기간 60초
  private readonly BROADCAST_INTERVAL = 1000; // 1초마다 브로드캐스트

  private constructor() {}

  static getInstance(): BinancePriceManager {
    if (!BinancePriceManager.instance) {
      BinancePriceManager.instance = new BinancePriceManager();
    }
    return BinancePriceManager.instance;
  }

  /**
   * 구독 심볼 추가
   */
  subscribe(symbol: string): void {
    const normalized = symbol.toUpperCase();
    if (this.subscriptions.has(normalized)) {
      return;
    }
    this.subscriptions.add(normalized);
  }

  /**
   * WebSocket 연결 시작
   */
  connect(): void {
    if (this.ws && this.isConnected) {
      console.log('[BinancePM] Already connected');
      return;
    }

    if (this.subscriptions.size === 0) {
      console.log('[BinancePM] No subscriptions, skipping connect');
      return;
    }

    // 스트림 이름 생성: btcusdt@ticker 형식
    const streams = Array.from(this.subscriptions)
      .map(s => `${s.toLowerCase()}@ticker`)
      .join('/');

    const url = this.subscriptions.size === 1
      ? `${this.BASE_WS_URL}/${streams}`
      : `${this.BASE_WS_URL.replace('/ws', '/stream')}?streams=${streams}`;

    console.log(`[BinancePM] Connecting to Binance WebSocket... (${this.subscriptions.size} symbols)`);

    try {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        console.log(`[BinancePM] WebSocket connected`);
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.startBroadcast();
      });

      this.ws.on('message', (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        console.log(`[BinancePM] WebSocket closed: ${code} - ${reason.toString()}`);
        this.isConnected = false;
        this.stopBroadcast();
        this.scheduleReconnect();
      });

      this.ws.on('error', (error: Error) => {
        console.error('[BinancePM] WebSocket error:', error.message);
        this.isConnected = false;
      });

      // ws 라이브러리가 Binance ping 프레임에 자동으로 pong 응답
      // 별도 ping 로직 불필요

    } catch (error: any) {
      console.error('[BinancePM] Failed to connect:', error.message);
      this.scheduleReconnect();
    }
  }

  /**
   * WebSocket 연결 종료
   */
  disconnect(): void {
    console.log('[BinancePM] Disconnecting...');

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
    this.broadcastBuffer.clear();
  }

  /**
   * 캐시된 가격 반환
   */
  getPrice(symbol: string): number | null {
    const normalized = symbol.toUpperCase();
    const cached = this.priceCache.get(normalized);

    if (!cached) {
      return null;
    }

    if (Date.now() - cached.timestamp > this.CACHE_TTL) {
      this.priceCache.delete(normalized);
      return null;
    }

    return cached.price;
  }

  /**
   * 전체 ticker 데이터 반환
   */
  getTickerData(symbol: string): BinancePriceCache | null {
    const normalized = symbol.toUpperCase();
    const cached = this.priceCache.get(normalized);

    if (!cached || Date.now() - cached.timestamp > this.CACHE_TTL) {
      return null;
    }

    return cached;
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
   * 수신 메시지 처리
   */
  private handleMessage(data: Buffer): void {
    try {
      const raw = JSON.parse(data.toString());

      // 멀티 스트림인 경우 data 필드에 실제 데이터가 있음
      const message: BinanceTickerData = raw.data || raw;

      if (!message.s || !message.c) {
        return;
      }

      const symbol = message.s.toUpperCase();
      const price = parseFloat(message.c);
      const change24h = parseFloat(message.P);
      const volume24h = parseFloat(message.q);
      const high24h = parseFloat(message.h);
      const low24h = parseFloat(message.l);
      const now = Date.now();

      // 캐시 업데이트
      this.priceCache.set(symbol, {
        price,
        change24h,
        volume24h,
        high24h,
        low24h,
        timestamp: now,
        rawData: message,
      });

      // 브로드캐스트 버퍼에 추가
      this.broadcastBuffer.set(symbol, {
        ticker: symbol,
        price,
        change24h,
        volume24h,
      });

    } catch (error: any) {
      console.error('[BinancePM] Failed to parse message:', error.message);
    }
  }

  /**
   * 클라이언트 브로드캐스트 시작 (1초마다)
   */
  private startBroadcast(): void {
    this.stopBroadcast();

    this.broadcastInterval = setInterval(() => {
      if (socketService.getPriceSubscribersCount() === 0) {
        return;
      }

      if (this.broadcastBuffer.size === 0) {
        return;
      }

      const prices = Array.from(this.broadcastBuffer.values());
      socketService.emitPricesBatch(prices);

      this.broadcastBuffer.clear();
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
      console.error('[BinancePM] Max reconnect attempts reached. Giving up.');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    console.log(`[BinancePM] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, delay);
  }
}

// 싱글톤 인스턴스 export
export const binancePriceManager = BinancePriceManager.getInstance();
