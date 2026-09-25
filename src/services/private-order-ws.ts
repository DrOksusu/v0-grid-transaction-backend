/**
 * 실시간 체결(private myOrder) WebSocket
 *
 * 목적: 그리드 봇의 체결 감지 지연(현행 최대 ~36초, 30초 폴링 안전망 의존)을 제거.
 * 업비트/빗썸 private WS(myOrder)를 구독해 체결 즉시 기존 체결 처리 진입점
 * (TradingService.checkAndProcessSingleOrder)을 트리거한다.
 *
 * 비유: 30초 폴링 안전망이 "정기 순찰"이라면, 이 모듈은 "실시간 알림벨"이다.
 * 알림벨이 울리면 즉시 확인하고, 혹시 못 들었을 경우를 대비해 순찰은 계속 돈다.
 *
 * 단계적 배포: REALTIME_FILL_WS_MODE 환경변수로 off(기본)/shadow/on 제어.
 * - off: 연결 자체를 하지 않음(기존과 동일 동작).
 * - shadow: 연결·수신은 하되 로그만 남기고 실제 체결 트리거는 하지 않음.
 * - on: 수신 체결로 실제 반대주문 트리거.
 *
 * spec: docs/superpowers/specs/2026-09-25-realtime-fill-websocket.md
 */

import WebSocket from 'ws';

export type RealtimeFillWsMode = 'off' | 'shadow' | 'on';

/** 현재 배포 모드를 call-time에 읽는다 (모듈 로드 시점 캐싱 금지 — 런타임 토글/테스트 용이성). */
export function getRealtimeFillWsMode(): RealtimeFillWsMode {
  const raw = process.env.REALTIME_FILL_WS_MODE;
  if (raw === 'shadow' || raw === 'on') return raw;
  return 'off';
}

export interface FillInfo {
  exchange: string;
  market: string;
  uuid: string;
  state: string;
}

type FillListener = (info: FillInfo) => void;

/** 체결(완전/부분)로 간주할 state 값들. 방어적으로 여러 후보 허용. */
const FILLED_STATES = new Set(['done', 'trade']);
/** 명시적으로 비체결로 간주해 무시할 state 값들 (참고용, 화이트리스트 방식이라 실제 분기엔 미사용). */
// wait, watch 등은 FILLED_STATES에 없으므로 자연히 무시됨.

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 10;
const PING_INTERVAL_MS = 30_000;

export interface PrivateOrderWsConnectionOptions {
  exchange: string;
  endpoint: string;
  /** 매 connect()/재연결마다 새로 호출되어야 함 (fresh JWT 보장) */
  generateJwt: () => string;
  /** 거래소별 구독 페이로드 (빗썸은 codes 필요) */
  buildSubscribePayload: (markets: string[]) => unknown;
  markets: string[];
}

/**
 * 거래소 무관 공용 private WS 연결 1개.
 * 엔드포인트/JWT 생성/구독 페이로드는 주입받아 거래소 차이를 흡수한다.
 */
export class PrivateOrderWsConnection {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private closedByCaller = false;
  private listeners: FillListener[] = [];
  private markets: string[];

  constructor(private readonly options: PrivateOrderWsConnectionOptions) {
    this.markets = [...options.markets];
  }

  onFill(listener: FillListener): void {
    this.listeners.push(listener);
  }

  /** 구독 대상 마켓 갱신 (다음 재연결 시 반영). 봇 추가/제거 시 단순화를 위해 즉시 재구독은 하지 않음. */
  setMarkets(markets: string[]): void {
    this.markets = [...markets];
  }

  connect(): void {
    this.closedByCaller = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    let jwt: string;
    try {
      jwt = this.options.generateJwt();
    } catch (err: any) {
      console.error(`[PrivateOrderWs][${this.options.exchange}] JWT 생성 실패:`, err.message);
      this.scheduleReconnect();
      return;
    }

    let currentWs: WebSocket;
    try {
      currentWs = new WebSocket(this.options.endpoint, {
        headers: { Authorization: `Bearer ${jwt}` },
      } as any);
    } catch (err: any) {
      console.error(`[PrivateOrderWs][${this.options.exchange}] 연결 생성 실패:`, err.message);
      this.scheduleReconnect();
      return;
    }
    this.ws = currentWs;

    currentWs.on('open', () => {
      if (this.ws !== currentWs) {
        try { currentWs.close(); } catch { /* orphan */ }
        return;
      }
      this.reconnectAttempts = 0;
      try {
        const payload = this.options.buildSubscribePayload(this.markets);
        currentWs.send(JSON.stringify(payload));
        console.log(`[PrivateOrderWs][${this.options.exchange}] myOrder 구독 시작 (markets=${this.markets.length}개)`);
      } catch (err: any) {
        console.error(`[PrivateOrderWs][${this.options.exchange}] 구독 전송 실패:`, err.message);
      }
      this.startPing(currentWs);
    });

    currentWs.on('message', (data: Buffer) => {
      if (this.ws !== currentWs) return;
      this.handleMessage(data);
    });

    currentWs.on('close', () => {
      if (this.ws !== currentWs) return;
      this.ws = null;
      this.stopPing();
      if (!this.closedByCaller) {
        this.scheduleReconnect();
      }
    });

    currentWs.on('error', (err: Error) => {
      // 실거래 자금 영향 없어야 함 — 연결 실패는 로그 후 폴링 폴백으로 정상 동작 유지
      console.error(`[PrivateOrderWs][${this.options.exchange}] 오류:`, err.message);
      if (this.ws === currentWs) this.ws = null;
    });
  }

  private handleMessage(data: Buffer): void {
    try {
      const msg = JSON.parse(data.toString());
      if (msg?.type !== 'myOrder') return;

      // 필드명 방어적 파싱: 후보 여러 개 허용 (거래소별 표기 차이 대비)
      const uuid: string | undefined = msg.uuid ?? msg.orderId ?? msg.order_id;
      const market: string | undefined = msg.market ?? msg.code ?? msg.symbol;
      const state: string | undefined = msg.state ?? msg.status;

      if (!uuid || !market || !state) return;
      if (!FILLED_STATES.has(state)) return; // wait/watch 등 비체결 무시

      const info: FillInfo = { exchange: this.options.exchange, market, uuid, state };
      for (const listener of this.listeners) {
        try {
          listener(info);
        } catch (err: any) {
          console.error(`[PrivateOrderWs][${this.options.exchange}] onFill 리스너 오류:`, err.message);
        }
      }
    } catch (err: any) {
      console.error(`[PrivateOrderWs][${this.options.exchange}] 메시지 파싱 오류:`, err.message);
    }
  }

  private startPing(ws: WebSocket): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      try {
        if (ws.readyState === WebSocket.OPEN && typeof (ws as any).ping === 'function') {
          (ws as any).ping();
        }
      } catch {
        // keepalive 실패는 무시 — close 이벤트가 재연결을 처리
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error(`[PrivateOrderWs][${this.options.exchange}] 재연결 ${MAX_RECONNECT_ATTEMPTS}회 초과 — 포기 (30초 폴링 안전망으로 동작 유지)`);
      return;
    }
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts), RECONNECT_MAX_DELAY_MS);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(); // fresh JWT: connect()가 매번 generateJwt() 재호출
    }, delay);
  }

  close(): void {
    this.closedByCaller = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    if (this.ws) {
      try { this.ws.close(); } catch { /* noop */ }
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}

// ── 풀 ───────────────────────────────────────────────────────────────────────

export interface PoolConnectionParams {
  exchange: string;
  userId: number;
  credentialId: number;
  apiKey: string;
  secretKey: string;
  markets: string[];
  generateJwt: () => string;
  endpoint?: string;
  buildSubscribePayload?: (markets: string[]) => unknown;
}

interface PoolEntry {
  conn: PrivateOrderWsConnection;
  refCount: number;
  idleTimer: NodeJS.Timeout | null;
  markets: Set<string>;
}

const DEFAULT_IDLE_CLOSE_MS = 30_000;

const UPBIT_ENDPOINT = 'wss://api.upbit.com/websocket/v1/private';
const BITHUMB_ENDPOINT = 'wss://ws-api.bithumb.com/websocket/v1/private';

function defaultEndpoint(exchange: string): string {
  return exchange === 'bithumb' ? BITHUMB_ENDPOINT : UPBIT_ENDPOINT;
}

function defaultBuildSubscribePayload(exchange: string) {
  return (markets: string[]) => {
    const ticket = `private-fill-${Date.now()}`;
    if (exchange === 'bithumb') {
      return [{ ticket }, { type: 'myOrder', codes: markets }];
    }
    return [{ ticket }, { type: 'myOrder' }];
  };
}

/**
 * credential별 연결 풀. key = `${exchange}:${credentialId}`.
 * 같은 key로 여러 봇이 getOrCreate하면 연결 1개를 공유(ref-count).
 */
export class PrivateOrderWsPool {
  private entries = new Map<string, PoolEntry>();
  private onFillListeners: FillListener[] = [];
  private readonly idleCloseMs: number;

  constructor(opts?: { idleCloseMs?: number }) {
    this.idleCloseMs = opts?.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
  }

  private key(exchange: string, credentialId: number): string {
    return `${exchange}:${credentialId}`;
  }

  onFill(listener: FillListener): void {
    this.onFillListeners.push(listener);
  }

  getOrCreate(params: PoolConnectionParams): PrivateOrderWsConnection {
    const key = this.key(params.exchange, params.credentialId);
    const existing = this.entries.get(key);

    if (existing) {
      existing.refCount++;
      if (existing.idleTimer) {
        clearTimeout(existing.idleTimer);
        existing.idleTimer = null;
      }
      // 기존 마켓 + 새로 추가된 봇의 마켓을 합집합으로 유지 (다음 재연결부터 반영)
      for (const m of params.markets) existing.markets.add(m);
      existing.conn.setMarkets([...existing.markets]);
      return existing.conn;
    }

    const conn = new PrivateOrderWsConnection({
      exchange: params.exchange,
      endpoint: params.endpoint ?? defaultEndpoint(params.exchange),
      generateJwt: params.generateJwt,
      buildSubscribePayload: params.buildSubscribePayload ?? defaultBuildSubscribePayload(params.exchange),
      markets: params.markets,
    });
    for (const listener of this.onFillListeners) {
      conn.onFill(listener);
    }
    conn.connect();

    this.entries.set(key, { conn, refCount: 1, idleTimer: null, markets: new Set(params.markets) });
    return conn;
  }

  release(exchange: string, credentialId: number): void {
    const key = this.key(exchange, credentialId);
    const entry = this.entries.get(key);
    if (!entry) return;

    entry.refCount = Math.max(0, entry.refCount - 1);
    if (entry.refCount > 0) return;

    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      const current = this.entries.get(key);
      if (!current || current.refCount > 0) return;
      current.conn.close();
      this.entries.delete(key);
    }, this.idleCloseMs);
  }

  /** 전체 연결 종료 (엔진 stop() 시 호출) */
  closeAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.conn.close();
    }
    this.entries.clear();
  }

  getStats(): { connections: number; byExchange: Record<string, number> } {
    const byExchange: Record<string, number> = {};
    for (const key of this.entries.keys()) {
      const exchange = key.split(':')[0];
      byExchange[exchange] = (byExchange[exchange] ?? 0) + 1;
    }
    return { connections: this.entries.size, byExchange };
  }
}

// ── 체결 디스패치 (uuid → gridId 조회 → 모드별 트리거) ─────────────────────────

export interface DispatchFillDeps {
  mode: RealtimeFillWsMode;
  /** uuid(orderId)로 gridId 조회. 없으면 null. */
  lookupGridId: (uuid: string) => Promise<number | null>;
  /** 실제 체결 처리 트리거 (TradingService.checkAndProcessSingleOrder 등). */
  trigger: (gridId: number) => Promise<boolean>;
  /** shadow 모드 로깅 시 감지 지연 계산용 (선택) */
  now?: () => number;
}

/**
 * 수신한 체결 정보를 모드에 따라 처리.
 * - off: 아무 것도 하지 않음 (호출 자체가 상위에서 걸러지지만 방어적으로 한 번 더 체크).
 * - shadow: gridId 조회 후 로그만 남기고 trigger는 절대 호출하지 않음.
 * - on: gridId 조회 성공 시 trigger 호출 (fire-and-forget은 호출부 책임).
 */
export async function dispatchFill(info: FillInfo, deps: DispatchFillDeps): Promise<void> {
  if (deps.mode === 'off') return;

  let gridId: number | null;
  try {
    gridId = await deps.lookupGridId(info.uuid);
  } catch (err: any) {
    console.error(`[RealtimeFill][${info.exchange}] gridId 조회 실패 (uuid=${info.uuid}):`, err.message);
    return;
  }

  if (gridId === null) {
    console.log(`[RealtimeFill][${info.exchange}] uuid 매칭 grid 없음 — 무시 (uuid=${info.uuid})`);
    return;
  }

  if (deps.mode === 'shadow') {
    console.log(`[RealtimeFill][shadow] ${info.exchange} ${info.market} uuid=${info.uuid} state=${info.state} gridId=${gridId}`);
    return;
  }

  // mode === 'on'
  try {
    await deps.trigger(gridId);
  } catch (err: any) {
    console.error(`[RealtimeFill][${info.exchange}] trigger 실패 (gridId=${gridId}):`, err.message);
  }
}
