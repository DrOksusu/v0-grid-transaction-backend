/**
 * PairScannerService
 *
 * Upbit KRW 마켓 여러 페어의 실시간 호가를 WebSocket으로 구독하여
 * 각 페어의 spread를 계산하고 break-even 초과 이벤트를 통계로 집계한 뒤
 * Socket.IO로 프론트엔드에 push하는 서비스.
 */

import WebSocket from 'ws';
import { socketService } from './socket.service';
import type { OrderbookTop } from './upbit-price-manager';
import {
  subscribeBithumbStablecoinOrderbooks,
  unsubscribeBithumbStablecoinOrderbooks,
  getAllBithumbStablecoinOrderbooks,
  isBithumbStablecoinWsConnected,
} from './bithumb-stablecoin-ws-manager';
import {
  subscribeCoinoneStablecoinOrderbooks,
  unsubscribeCoinoneStablecoinOrderbooks,
  getCoinoneStablecoinOrderbook,
} from './coinone-stablecoin-price-manager';

// ─────────────────────────────────────────────────────────────
// 타입 정의
// ─────────────────────────────────────────────────────────────

export interface PairConfig {
  /** 유니크 식별자 (예: "USDS-USDT") */
  name: string;
  /** maker 코인 (예: "USDS" → underlying market: KRW-USDS) */
  makerCoin: string;
  /** taker 코인 (예: "USDT" → underlying market: KRW-USDT) */
  takerCoin: string;
  /** 거래 수량 */
  qty: number;
  /** maker 수수료율 (예: 0.0005 = 0.05%) */
  makerFeeRate: number;
  /** taker 수수료율 (예: 0.0005 = 0.05%) */
  takerFeeRate: number;
  /** 거래소 구분 (기본값: 'upbit') */
  exchange?: 'upbit' | 'bithumb' | 'coinone';
  /** 크로스 거래소 페어용: maker 코인을 구매할 거래소 (exchange보다 우선) */
  makerExchange?: 'upbit' | 'bithumb' | 'coinone';
  /** 크로스 거래소 페어용: taker 코인을 판매할 거래소 (exchange보다 우선) */
  takerExchange?: 'upbit' | 'bithumb' | 'coinone';
}

export interface PairStats {
  name: string;
  /** takerBook.bid.price - makerBook.ask.price (per unit, KRW) */
  spreadKrw: number;
  /** break-even spread per unit (수수료 합계) */
  breakEvenKrw: number;
  /** spreadKrw > breakEvenKrw */
  isBreakEven: boolean;
  /** 호가 수신 횟수 */
  totalSamples: number;
  /** isBreakEven=true 횟수 */
  breakEvenCount: number;
  /** breakEvenCount/totalSamples*100 */
  freqPercent: number;
  /** 마지막 업데이트 timestamp (ms) */
  lastUpdatedAt: number;
}

export interface PairScannerSnapshot {
  pairs: PairConfig[];
  stats: PairStats[];
  wsConnected: boolean;
  bithumbWsConnected: boolean;
}

// ─────────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────────

const UPBIT_WS_URL = 'wss://api.upbit.com/websocket/v1';
const MAX_RECONNECT_ATTEMPTS = 10;

// ─────────────────────────────────────────────────────────────
// PairScannerService 클래스
// ─────────────────────────────────────────────────────────────

class PairScannerService {
  /** name → PairConfig */
  private pairs: Map<string, PairConfig> = new Map();
  /** name → PairStats */
  private stats: Map<string, PairStats> = new Map();
  /** "KRW-USDS" 형태 market → OrderbookTop */
  private orderbookCache: Map<string, OrderbookTop> = new Map();

  // WS 상태
  private ws: WebSocket | null = null;
  /** 현재 WS에 구독된 마켓들 */
  private wsSubscribedMarkets: Set<string> = new Set();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  /** start()~stop() 사이에만 true */
  private isActive = false;

  // debounce broadcast용 타이머
  private broadcastTimer: NodeJS.Timeout | null = null;

  // 빗썸 주기적 갱신
  private bithumbRefreshTimer: NodeJS.Timeout | null = null;
  private bithumbSubscribed = false;
  private static readonly BITHUMB_REFRESH_INTERVAL = 2000;

  // 코인원 주기적 갱신
  private coinoneRefreshTimer: NodeJS.Timeout | null = null;
  private coinoneSubscribed = false;
  private static readonly COINONE_REFRESH_INTERVAL = 3000;

  // ───────────────────────────────────────────────
  // public API
  // ───────────────────────────────────────────────

  /**
   * 서비스 시작.
   * isActive=true로 설정하고, 페어가 있으면 WS 연결.
   */
  start(): void {
    if (this.isActive) {
      console.log('[PairScanner] 이미 가동 중');
      return;
    }
    this.isActive = true;
    console.log('[PairScanner] 서비스 시작');

    if (this.pairs.size > 0) {
      this.updateWsSubscription();
    }

    if (this.hasBithumbPairs()) {
      this.ensureBithumbSubscribed();
    }
    this.startBithumbRefresh();

    if (this.hasCoinonePairs()) {
      this.ensureCoinoneSubscribed();
    }
    this.startCoinoneRefresh();
  }

  /**
   * 서비스 중지.
   * isActive=false로 설정하고 WS 종료.
   */
  stop(): void {
    if (!this.isActive) {
      console.log('[PairScanner] 이미 중지됨');
      return;
    }
    this.isActive = false;
    console.log('[PairScanner] 서비스 중지');

    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    this.stopBithumbRefresh();
    if (this.bithumbSubscribed) {
      unsubscribeBithumbStablecoinOrderbooks();
      this.bithumbSubscribed = false;
    }
    this.stopCoinoneRefresh();
    if (this.coinoneSubscribed) {
      unsubscribeCoinoneStablecoinOrderbooks();
      this.coinoneSubscribed = false;
    }
    this.closeWs();
  }

  /**
   * 페어 추가.
   * 입력 검증 후 추가하고, WS 구독 갱신.
   */
  addPair(config: PairConfig): { success: boolean; error?: string } {
    // name 중복 검사
    if (this.pairs.has(config.name)) {
      return { success: false, error: `페어 '${config.name}'이 이미 존재합니다` };
    }

    // makerCoin === takerCoin 검사 (크로스 거래소 페어는 동일 코인 허용)
    const isCross = (config.makerExchange || config.takerExchange) &&
      (config.makerExchange ?? config.exchange ?? 'upbit') !== (config.takerExchange ?? config.exchange ?? 'upbit');
    if (!isCross && config.makerCoin.toUpperCase() === config.takerCoin.toUpperCase()) {
      return { success: false, error: '단일 거래소 페어는 makerCoin과 takerCoin이 달라야 합니다' };
    }

    // qty 검사
    if (config.qty <= 0) {
      return { success: false, error: 'qty는 0보다 커야 합니다' };
    }

    // makerFeeRate 검사
    if (config.makerFeeRate < 0 || config.makerFeeRate > 0.1) {
      return { success: false, error: 'makerFeeRate는 0 이상 0.1 이하여야 합니다' };
    }

    // takerFeeRate 검사
    if (config.takerFeeRate < 0 || config.takerFeeRate > 0.1) {
      return { success: false, error: 'takerFeeRate는 0 이상 0.1 이하여야 합니다' };
    }

    this.pairs.set(config.name, { ...config });
    const makerEx = config.makerExchange ?? (config.exchange ?? 'upbit');
    const takerEx = config.takerExchange ?? (config.exchange ?? 'upbit');
    const crossLabel = makerEx !== takerEx ? `크로스(${makerEx}→${takerEx})` : makerEx;
    console.log(`[PairScanner] 페어 추가: ${config.name} (${crossLabel} maker: ${config.makerCoin.toUpperCase()}, taker: ${config.takerCoin.toUpperCase()})`);

    if (this.isActive) {
      // 크로스 페어는 양쪽 거래소 모두 구독 처리
      if (makerEx === 'bithumb' || takerEx === 'bithumb') this.ensureBithumbSubscribed();
      if (makerEx === 'coinone' || takerEx === 'coinone') this.ensureCoinoneSubscribed();
      if (makerEx === 'upbit' || takerEx === 'upbit') this.updateWsSubscription();
    }

    return { success: true };
  }

  /**
   * 페어 제거.
   * @returns 제거 성공 여부
   */
  removePair(name: string): boolean {
    if (!this.pairs.has(name)) {
      return false;
    }

    this.pairs.delete(name);
    this.stats.delete(name);
    console.log(`[PairScanner] 페어 제거: ${name}`);

    if (this.isActive) {
      this.updateWsSubscription();
      if (!this.hasBithumbPairs() && this.bithumbSubscribed) {
        unsubscribeBithumbStablecoinOrderbooks();
        this.bithumbSubscribed = false;
      }
      if (!this.hasCoinonePairs() && this.coinoneSubscribed) {
        unsubscribeCoinoneStablecoinOrderbooks();
        this.coinoneSubscribed = false;
      }
    }

    return true;
  }

  /** 현재 등록된 페어 목록 반환 (불변 복사본) */
  getPairs(): PairConfig[] {
    return Array.from(this.pairs.values()).map(p => ({ ...p }));
  }

  /** 현재 통계 목록 반환 (불변 복사본) */
  getStats(): PairStats[] {
    return Array.from(this.stats.values()).map(s => ({ ...s }));
  }

  /** 현재 전체 스냅샷 반환 */
  getSnapshot(): PairScannerSnapshot {
    return {
      pairs: this.getPairs(),
      stats: this.getStats(),
      wsConnected: this.ws !== null && this.ws.readyState === WebSocket.OPEN,
      bithumbWsConnected: isBithumbStablecoinWsConnected(),
    };
  }

  // ───────────────────────────────────────────────
  // 빗썸 갱신 (private)
  // ───────────────────────────────────────────────

  private hasBithumbPairs(): boolean {
    for (const config of this.pairs.values()) {
      if (this.getEffectiveMakerExchange(config) === 'bithumb' || this.getEffectiveTakerExchange(config) === 'bithumb') return true;
    }
    return false;
  }

  private ensureBithumbSubscribed(): void {
    if (!this.bithumbSubscribed) {
      subscribeBithumbStablecoinOrderbooks();
      this.bithumbSubscribed = true;
    }
  }

  private startBithumbRefresh(): void {
    if (this.bithumbRefreshTimer) return;
    this.bithumbRefreshTimer = setInterval(() => {
      this.refreshBithumbStats();
    }, PairScannerService.BITHUMB_REFRESH_INTERVAL);
  }

  private stopBithumbRefresh(): void {
    if (this.bithumbRefreshTimer) {
      clearInterval(this.bithumbRefreshTimer);
      this.bithumbRefreshTimer = null;
    }
  }

  private refreshBithumbStats(): void {
    const bithumbBooks = getAllBithumbStablecoinOrderbooks();
    let updated = false;

    for (const config of this.pairs.values()) {
      if ((config.exchange ?? 'upbit') !== 'bithumb') continue;

      const makerBook = bithumbBooks.get(config.makerCoin.toUpperCase());
      const takerBook = bithumbBooks.get(config.takerCoin.toUpperCase());
      if (!makerBook || !takerBook) continue;

      const makerTop: OrderbookTop = {
        market: `BITHUMB-${config.makerCoin.toUpperCase()}`,
        bid: { price: makerBook.bid, size: 0 },
        ask: { price: makerBook.ask, size: 0 },
        timestamp: makerBook.timestamp,
      };
      const takerTop: OrderbookTop = {
        market: `BITHUMB-${config.takerCoin.toUpperCase()}`,
        bid: { price: takerBook.bid, size: 0 },
        ask: { price: takerBook.ask, size: 0 },
        timestamp: takerBook.timestamp,
      };

      this.updateStats(config, makerTop, takerTop);
      updated = true;
    }

    if (updated) {
      this.scheduleEmit();
    }
    // 크로스 페어도 갱신 (bithumb 데이터가 업데이트됐을 때)
    this.refreshCrossStats();
  }

  // ───────────────────────────────────────────────
  // 코인원 갱신 (private)
  // ───────────────────────────────────────────────

  private hasCoinonePairs(): boolean {
    for (const config of this.pairs.values()) {
      if (this.getEffectiveMakerExchange(config) === 'coinone' || this.getEffectiveTakerExchange(config) === 'coinone') return true;
    }
    return false;
  }

  private ensureCoinoneSubscribed(): void {
    if (!this.coinoneSubscribed) {
      subscribeCoinoneStablecoinOrderbooks();
      this.coinoneSubscribed = true;
    }
  }

  private startCoinoneRefresh(): void {
    if (this.coinoneRefreshTimer) return;
    this.coinoneRefreshTimer = setInterval(() => {
      this.refreshCoinoneStats();
    }, PairScannerService.COINONE_REFRESH_INTERVAL);
  }

  private stopCoinoneRefresh(): void {
    if (this.coinoneRefreshTimer) {
      clearInterval(this.coinoneRefreshTimer);
      this.coinoneRefreshTimer = null;
    }
  }

  private refreshCoinoneStats(): void {
    let updated = false;

    for (const config of this.pairs.values()) {
      if (config.exchange !== 'coinone') continue;

      const makerBook = getCoinoneStablecoinOrderbook(config.makerCoin);
      const takerBook = getCoinoneStablecoinOrderbook(config.takerCoin);
      if (!makerBook || !takerBook) continue;

      const makerTop: OrderbookTop = {
        market: `COINONE-${config.makerCoin.toUpperCase()}`,
        bid: { price: makerBook.bid, size: 1e6 },
        ask: { price: makerBook.ask, size: 1e6 },
        timestamp: makerBook.timestamp,
      };
      const takerTop: OrderbookTop = {
        market: `COINONE-${config.takerCoin.toUpperCase()}`,
        bid: { price: takerBook.bid, size: 1e6 },
        ask: { price: takerBook.ask, size: 1e6 },
        timestamp: takerBook.timestamp,
      };

      this.updateStats(config, makerTop, takerTop);
      updated = true;
    }

    if (updated) {
      this.scheduleEmit();
    }
    // 크로스 페어도 갱신 (coinone 데이터가 업데이트됐을 때)
    this.refreshCrossStats();
  }

  // ───────────────────────────────────────────────
  // WS 관리 (private)
  // ───────────────────────────────────────────────

  /**
   * 현재 등록된 페어들에서 필요한 마켓 목록 계산.
   */
  private getRequiredMarkets(): string[] {
    const markets = new Set<string>();
    for (const config of this.pairs.values()) {
      const makerEx = this.getEffectiveMakerExchange(config);
      const takerEx = this.getEffectiveTakerExchange(config);
      // maker가 upbit이면 makerCoin 마켓 구독
      if (makerEx === 'upbit') markets.add(`KRW-${config.makerCoin.toUpperCase()}`);
      // taker가 upbit이면 takerCoin 마켓 구독
      if (takerEx === 'upbit') markets.add(`KRW-${config.takerCoin.toUpperCase()}`);
    }
    return Array.from(markets);
  }

  /**
   * WS 구독 갱신.
   * - 필요한 마켓이 없으면 WS를 닫는다.
   * - WS가 OPEN이면 바로 재구독 메시지를 전송한다.
   * - WS가 없거나 닫혀있으면 새로 연결한다.
   */
  private updateWsSubscription(): void {
    const markets = this.getRequiredMarkets();

    if (markets.length === 0) {
      this.closeWs();
      return;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.connectWs();
      return;
    }

    // WS가 OPEN이면 바로 재구독
    const msg = [
      { ticket: `pair-scanner-${Date.now()}` },
      { type: 'orderbook', codes: markets },
      { format: 'DEFAULT' },
    ];
    this.ws.send(JSON.stringify(msg));
    this.wsSubscribedMarkets = new Set(markets);
    console.log(`[PairScanner] WS 재구독: ${markets.join(', ')}`);
  }

  /**
   * Upbit WebSocket 연결.
   * upbit-price-manager.ts의 connectOrderbookWsInternal 패턴 준수
   * (orphan WS 방어 포함).
   */
  private connectWs(): void {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const ws = new WebSocket(UPBIT_WS_URL);
    this.ws = ws;

    ws.on('open', () => {
      // orphan WS 방어: 전역이 다른 WS로 교체됐으면 닫는다
      if (this.ws !== ws) {
        try { ws.close(); } catch { /* ignore */ }
        return;
      }

      this.reconnectAttempts = 0;
      const markets = this.getRequiredMarkets();

      if (markets.length === 0) {
        // 연결됐지만 구독할 마켓이 없음 → 그냥 유지
        return;
      }

      const msg = [
        { ticket: `pair-scanner-${Date.now()}` },
        { type: 'orderbook', codes: markets },
        { format: 'DEFAULT' },
      ];
      ws.send(JSON.stringify(msg));
      this.wsSubscribedMarkets = new Set(markets);
      console.log(`[PairScanner] WS 연결 및 구독: ${markets.join(', ')}`);
    });

    ws.on('message', (data: Buffer) => {
      // orphan WS 방어
      if (this.ws !== ws) return;
      this.handleMessage(data);
    });

    ws.on('close', () => {
      // orphan WS의 close이면 reconnect 예약 안 함
      if (this.ws !== ws) {
        ws.removeAllListeners();
        return;
      }

      console.warn('[PairScanner] WS 닫힘 - 재연결 예약');
      this.ws.removeAllListeners();
      this.ws = null;
      this.wsSubscribedMarkets.clear();

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      // isActive=false이면 재연결 안 함
      if (this.isActive && this.pairs.size > 0) {
        this.scheduleReconnect();
      }
    });

    ws.on('error', (err: Error) => {
      console.error('[PairScanner] WS 에러:', err.message);
    });
  }

  /**
   * WS 종료 및 상태 초기화.
   */
  private closeWs(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }

    this.wsSubscribedMarkets.clear();
    this.reconnectAttempts = 0;
  }

  /**
   * 지수 백오프 재연결 스케줄링 (1s, 2s, 4s, ... 최대 30s).
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error(`[PairScanner] 최대 재연결 횟수(${MAX_RECONNECT_ATTEMPTS}) 초과. 중단.`);
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    console.log(`[PairScanner] ${delay}ms 후 재연결 (${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.isActive && this.pairs.size > 0) {
        this.connectWs();
      }
    }, delay);
  }

  // ───────────────────────────────────────────────
  // 메시지 처리 (private)
  // ───────────────────────────────────────────────

  /**
   * Upbit WS 메시지 처리.
   * orderbook 타입만 처리하고, 관련 페어들의 통계를 업데이트한다.
   */
  private handleMessage(data: Buffer): void {
    try {
      const parsed = JSON.parse(data.toString());

      if (parsed.type !== 'orderbook') return;

      const units: Array<{
        bid_price: number;
        bid_size: number;
        ask_price: number;
        ask_size: number;
      }> = parsed.orderbook_units || [];

      if (units.length === 0) return;

      const best = units[0];
      const market: string = parsed.code;

      const top: OrderbookTop = {
        market,
        bid: { price: best.bid_price, size: best.bid_size },
        ask: { price: best.ask_price, size: best.ask_size },
        timestamp: parsed.timestamp || Date.now(),
      };

      // 1. 호가 캐시 업데이트
      this.orderbookCache.set(market, top);

      // 2. 이 마켓을 사용하는 페어들 찾기
      let updated = false;
      for (const config of this.pairs.values()) {
        const makerMarket = `KRW-${config.makerCoin.toUpperCase()}`;
        const takerMarket = `KRW-${config.takerCoin.toUpperCase()}`;

        // 이번 메시지가 이 페어와 관련 없으면 스킵
        if (market !== makerMarket && market !== takerMarket) continue;

        // 두 underlying 모두 캐시에 있는 페어만 계산
        const makerBook = this.orderbookCache.get(makerMarket);
        const takerBook = this.orderbookCache.get(takerMarket);
        if (!makerBook || !takerBook) continue;

        // 3. 통계 업데이트
        this.updateStats(config, makerBook, takerBook);
        updated = true;
      }

      // 4. 하나라도 업데이트됐으면 debounce emit 예약
      if (updated) {
        this.scheduleEmit();
      }
      // 5. 크로스 페어도 갱신 (upbit 데이터가 업데이트됐을 때)
      this.refreshCrossStats();
    } catch (err) {
      console.error('[PairScanner] 메시지 파싱 에러:', err);
    }
  }

  /**
   * break-even 계산 및 통계 업데이트.
   *
   * spreadKrw = takerBook.bid.price - makerBook.ask.price (per unit)
   * feesPerUnit = makerBook.ask.price * makerFeeRate + takerBook.bid.price * takerFeeRate
   * breakEvenKrw = feesPerUnit
   * isBreakEven = spreadKrw > breakEvenKrw
   */
  private updateStats(
    config: PairConfig,
    makerBook: OrderbookTop,
    takerBook: OrderbookTop,
  ): void {
    const spreadKrw = takerBook.bid.price - makerBook.ask.price;
    const feesPerUnit =
      makerBook.ask.price * config.makerFeeRate +
      takerBook.bid.price * config.takerFeeRate;
    const breakEvenKrw = feesPerUnit;
    const isBreakEven = spreadKrw > breakEvenKrw;

    const prev = this.stats.get(config.name);
    const totalSamples = (prev?.totalSamples ?? 0) + 1;
    const breakEvenCount = (prev?.breakEvenCount ?? 0) + (isBreakEven ? 1 : 0);
    const freqPercent = totalSamples > 0 ? (breakEvenCount / totalSamples) * 100 : 0;

    this.stats.set(config.name, {
      name: config.name,
      spreadKrw,
      breakEvenKrw,
      isBreakEven,
      totalSamples,
      breakEvenCount,
      freqPercent,
      lastUpdatedAt: Date.now(),
    });
  }

  // ───────────────────────────────────────────────
  // 크로스 거래소 헬퍼 (private)
  // ───────────────────────────────────────────────

  /**
   * 거래소와 코인명으로 OrderbookTop을 반환.
   * upbit은 orderbookCache, bithumb/coinone은 각 매니저에서 조회.
   */
  private getOrderbookTop(exchange: 'upbit' | 'bithumb' | 'coinone', coin: string): OrderbookTop | null {
    if (exchange === 'upbit') {
      return this.orderbookCache.get(`KRW-${coin.toUpperCase()}`) ?? null;
    }
    if (exchange === 'bithumb') {
      const books = getAllBithumbStablecoinOrderbooks();
      const book = books.get(coin.toUpperCase());
      if (!book) return null;
      return {
        market: `BITHUMB-${coin.toUpperCase()}`,
        bid: { price: book.bid, size: 0 },
        ask: { price: book.ask, size: 0 },
        timestamp: book.timestamp,
      };
    }
    // coinone
    const book = getCoinoneStablecoinOrderbook(coin);
    if (!book) return null;
    return {
      market: `COINONE-${coin.toUpperCase()}`,
      bid: { price: book.bid, size: 1e6 },
      ask: { price: book.ask, size: 1e6 },
      timestamp: book.timestamp,
    };
  }

  /**
   * 페어 설정에서 실효 maker 거래소를 반환.
   * makerExchange가 있으면 우선 사용, 없으면 exchange, 둘 다 없으면 'upbit'.
   */
  private getEffectiveMakerExchange(config: PairConfig): 'upbit' | 'bithumb' | 'coinone' {
    return config.makerExchange ?? (config.exchange ?? 'upbit');
  }

  /**
   * 페어 설정에서 실효 taker 거래소를 반환.
   * takerExchange가 있으면 우선 사용, 없으면 exchange, 둘 다 없으면 'upbit'.
   */
  private getEffectiveTakerExchange(config: PairConfig): 'upbit' | 'bithumb' | 'coinone' {
    return config.takerExchange ?? (config.exchange ?? 'upbit');
  }

  /**
   * maker 거래소와 taker 거래소가 서로 다른 크로스 페어 여부 반환.
   */
  private isCrossPair(config: PairConfig): boolean {
    return this.getEffectiveMakerExchange(config) !== this.getEffectiveTakerExchange(config);
  }

  /**
   * 크로스 거래소 페어들의 spread 통계를 갱신.
   * bithumb/coinone/upbit 캐시가 업데이트될 때마다 호출.
   */
  private refreshCrossStats(): void {
    let updated = false;
    for (const config of this.pairs.values()) {
      if (!this.isCrossPair(config)) continue;
      const makerEx = this.getEffectiveMakerExchange(config);
      const takerEx = this.getEffectiveTakerExchange(config);
      const makerBook = this.getOrderbookTop(makerEx, config.makerCoin);
      const takerBook = this.getOrderbookTop(takerEx, config.takerCoin);
      if (!makerBook || !takerBook) continue;
      this.updateStats(config, makerBook, takerBook);
      updated = true;
    }
    if (updated) this.scheduleEmit();
  }

  // ───────────────────────────────────────────────
  // Broadcast (private)
  // ───────────────────────────────────────────────

  /**
   * 1초 debounce 후 emitUpdate 호출.
   * 이미 타이머가 예약된 경우 중복 예약하지 않는다.
   */
  private scheduleEmit(): void {
    if (this.broadcastTimer) return;

    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.emitUpdate();
    }, 1000);
  }

  /**
   * Socket.IO로 최신 스냅샷을 프론트엔드에 전송.
   * socket.service의 emitPairScannerUpdate는 Phase 2에서 추가됨
   * → optional chaining으로 안전하게 호출.
   */
  private emitUpdate(): void {
    const snapshot = this.getSnapshot();
    (socketService as any).emitPairScannerUpdate?.(snapshot);
  }
}

// ─────────────────────────────────────────────────────────────
// 싱글톤 export
// ─────────────────────────────────────────────────────────────

export const pairScannerService = new PairScannerService();
