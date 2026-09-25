/**
 * private-order-ws 단위 테스트
 *
 * 실거래 체결 감지용 private WebSocket 모듈. 실제 WS는 jest.mock으로 대체.
 * (bithumb-stablecoin-ws-manager.test.ts의 EventEmitter mock 패턴을 따름)
 */

// ws는 `import WebSocket from 'ws'` 형태로 사용되므로 CommonJS 스타일(module.exports = MockWs)로 mock.
jest.mock('ws', () => {
  const EventEmitter = require('events');
  class MockWs extends EventEmitter {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;
    static instances: MockWs[] = [];
    readyState = 1; // OPEN
    send = jest.fn();
    url: string;
    opts: any;
    close = jest.fn(function (this: any) {
      this.readyState = 3;
    });
    constructor(url: string, opts?: any) {
      super();
      this.url = url;
      this.opts = opts;
      MockWs.instances.push(this);
    }
  }
  return MockWs;
});

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

function getMockWsClass() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('ws');
}

describe('private-order-ws', () => {
  describe('메시지 파싱 — 체결/비체결 판정', () => {
    it('myOrder 체결(state=done) 메시지 → onFill 1회 emit (uuid/market/state 파싱)', async () => {
      const { PrivateOrderWsConnection } = await import('../../src/services/private-order-ws');
      const MockWs = getMockWsClass();

      const jwtProvider = jest.fn(() => 'fake.jwt.token');
      const onFill = jest.fn();

      const conn = new PrivateOrderWsConnection({
        exchange: 'upbit',
        endpoint: 'wss://api.upbit.com/websocket/v1/private',
        generateJwt: jwtProvider,
        buildSubscribePayload: (markets: string[]) => [{ ticket: 't' }, { type: 'myOrder' }],
        markets: ['KRW-BTC'],
      });
      conn.onFill(onFill);
      conn.connect();

      const wsInstance = MockWs.instances[MockWs.instances.length - 1];
      wsInstance.emit('open');

      const msg = { type: 'myOrder', state: 'done', uuid: 'order-uuid-1', market: 'KRW-BTC' };
      wsInstance.emit('message', Buffer.from(JSON.stringify(msg)));

      expect(onFill).toHaveBeenCalledTimes(1);
      expect(onFill).toHaveBeenCalledWith(
        expect.objectContaining({ exchange: 'upbit', market: 'KRW-BTC', uuid: 'order-uuid-1', state: 'done' }),
      );

      conn.close();
    });

    it('부분체결(state=trade) 메시지도 onFill emit', async () => {
      const { PrivateOrderWsConnection } = await import('../../src/services/private-order-ws');
      const MockWs = getMockWsClass();

      const onFill = jest.fn();
      const conn = new PrivateOrderWsConnection({
        exchange: 'bithumb',
        endpoint: 'wss://ws-api.bithumb.com/websocket/v1/private',
        generateJwt: () => 'fake.jwt.token',
        buildSubscribePayload: (markets: string[]) => [{ ticket: 't' }, { type: 'myOrder', codes: markets }],
        markets: ['KRW-EGLD'],
      });
      conn.onFill(onFill);
      conn.connect();

      const wsInstance = MockWs.instances[MockWs.instances.length - 1];
      wsInstance.emit('open');
      wsInstance.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'myOrder', state: 'trade', uuid: 'order-uuid-2', code: 'KRW-EGLD' })),
      );

      expect(onFill).toHaveBeenCalledTimes(1);
      expect(onFill).toHaveBeenCalledWith(
        expect.objectContaining({ exchange: 'bithumb', market: 'KRW-EGLD', uuid: 'order-uuid-2', state: 'trade' }),
      );

      conn.close();
    });

    it('비체결(wait/watch) 메시지 → emit 안 함', async () => {
      const { PrivateOrderWsConnection } = await import('../../src/services/private-order-ws');
      const MockWs = getMockWsClass();

      const onFill = jest.fn();
      const conn = new PrivateOrderWsConnection({
        exchange: 'upbit',
        endpoint: 'wss://api.upbit.com/websocket/v1/private',
        generateJwt: () => 'fake.jwt.token',
        buildSubscribePayload: () => [{ ticket: 't' }, { type: 'myOrder' }],
        markets: ['KRW-BTC'],
      });
      conn.onFill(onFill);
      conn.connect();

      const wsInstance = MockWs.instances[MockWs.instances.length - 1];
      wsInstance.emit('open');
      wsInstance.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'myOrder', state: 'wait', uuid: 'order-uuid-3', market: 'KRW-BTC' })),
      );
      wsInstance.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'myOrder', state: 'watch', uuid: 'order-uuid-4', market: 'KRW-BTC' })),
      );
      // myOrder가 아닌 타입도 무시
      wsInstance.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'ticker', state: 'done', uuid: 'order-uuid-5', market: 'KRW-BTC' })),
      );

      expect(onFill).not.toHaveBeenCalled();

      conn.close();
    });
  });

  describe('PrivateOrderWsPool — ref-count', () => {
    it('같은 credential로 2봇 등록 → 연결 1개, 1개 해제해도 유지, 0되면 close', async () => {
      const { PrivateOrderWsPool } = await import('../../src/services/private-order-ws');
      const MockWs = getMockWsClass();

      const pool = new PrivateOrderWsPool({ idleCloseMs: 0 });
      const jwtProvider = jest.fn(() => 'fake.jwt.token');

      const connA = pool.getOrCreate({
        exchange: 'upbit',
        userId: 1,
        credentialId: 100,
        apiKey: 'ak',
        secretKey: 'sk',
        markets: ['KRW-BTC'],
        generateJwt: jwtProvider,
      });
      const connB = pool.getOrCreate({
        exchange: 'upbit',
        userId: 1,
        credentialId: 100,
        apiKey: 'ak',
        secretKey: 'sk',
        markets: ['KRW-ETH'],
        generateJwt: jwtProvider,
      });

      expect(connA).toBe(connB); // 같은 key → 같은 연결 인스턴스
      expect(MockWs.instances).toHaveLength(1);
      expect(pool.getStats().connections).toBe(1);

      pool.release('upbit', 100);
      // 아직 ref-count 1 남음 → 연결 유지
      expect(pool.getStats().connections).toBe(1);

      pool.release('upbit', 100);
      // idleCloseMs: 0 → 타이머 즉시 만료
      jest.advanceTimersByTime(1);
      expect(pool.getStats().connections).toBe(0);
    });

    it('다른 credential은 별도 연결 생성', async () => {
      const { PrivateOrderWsPool } = await import('../../src/services/private-order-ws');
      const MockWs = getMockWsClass();

      const pool = new PrivateOrderWsPool({ idleCloseMs: 0 });
      pool.getOrCreate({
        exchange: 'upbit', userId: 1, credentialId: 100, apiKey: 'ak', secretKey: 'sk',
        markets: ['KRW-BTC'], generateJwt: () => 'jwt',
      });
      pool.getOrCreate({
        exchange: 'bithumb', userId: 2, credentialId: 200, apiKey: 'ak2', secretKey: 'sk2',
        markets: ['KRW-EGLD'], generateJwt: () => 'jwt',
      });

      expect(MockWs.instances).toHaveLength(2);
      expect(pool.getStats().connections).toBe(2);
    });
  });

  describe('재연결 시 fresh JWT', () => {
    it('close 이벤트 후 재연결 스케줄에서 generateJwt가 다시 호출됨', async () => {
      const { PrivateOrderWsConnection } = await import('../../src/services/private-order-ws');
      const MockWs = getMockWsClass();

      let callCount = 0;
      const jwtProvider = jest.fn(() => `jwt-${++callCount}`);

      const conn = new PrivateOrderWsConnection({
        exchange: 'upbit',
        endpoint: 'wss://api.upbit.com/websocket/v1/private',
        generateJwt: jwtProvider,
        buildSubscribePayload: () => [{ ticket: 't' }, { type: 'myOrder' }],
        markets: ['KRW-BTC'],
      });
      conn.connect();
      expect(jwtProvider).toHaveBeenCalledTimes(1);

      const wsInstance = MockWs.instances[0];
      wsInstance.emit('open');
      // 연결 종료 → 재연결 스케줄
      wsInstance.emit('close', 1006);

      // 백오프 타이머 진행 (지수 백오프 첫 시도는 짧게)
      jest.advanceTimersByTime(60_000);

      expect(jwtProvider.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(MockWs.instances.length).toBeGreaterThanOrEqual(2);

      conn.close();
    });
  });

  describe('dispatchFill — uuid→gridId 조회 후 모드별 트리거', () => {
    it('on 모드: gridId 조회 성공 → trigger 1회 호출', async () => {
      const { dispatchFill } = await import('../../src/services/private-order-ws');

      const lookupGridId = jest.fn().mockResolvedValue(42);
      const trigger = jest.fn().mockResolvedValue(true);

      await dispatchFill(
        { exchange: 'upbit', market: 'KRW-BTC', uuid: 'order-uuid-1', state: 'done' },
        { mode: 'on', lookupGridId, trigger },
      );

      expect(lookupGridId).toHaveBeenCalledWith('order-uuid-1');
      expect(trigger).toHaveBeenCalledTimes(1);
      expect(trigger).toHaveBeenCalledWith(42);
    });

    it('on 모드: 미존재 uuid → trigger 호출 안 함', async () => {
      const { dispatchFill } = await import('../../src/services/private-order-ws');

      const lookupGridId = jest.fn().mockResolvedValue(null);
      const trigger = jest.fn().mockResolvedValue(true);

      await dispatchFill(
        { exchange: 'upbit', market: 'KRW-BTC', uuid: 'unknown-uuid', state: 'done' },
        { mode: 'on', lookupGridId, trigger },
      );

      expect(lookupGridId).toHaveBeenCalledWith('unknown-uuid');
      expect(trigger).not.toHaveBeenCalled();
    });

    it('shadow 모드: gridId 조회는 하되(지연 로깅용) trigger는 절대 호출 안 함', async () => {
      const { dispatchFill } = await import('../../src/services/private-order-ws');

      const lookupGridId = jest.fn().mockResolvedValue(42);
      const trigger = jest.fn().mockResolvedValue(true);

      await dispatchFill(
        { exchange: 'bithumb', market: 'KRW-EGLD', uuid: 'order-uuid-3', state: 'trade' },
        { mode: 'shadow', lookupGridId, trigger },
      );

      expect(trigger).not.toHaveBeenCalled();
    });

    it('off 모드: lookupGridId도 trigger도 호출 안 함', async () => {
      const { dispatchFill } = await import('../../src/services/private-order-ws');

      const lookupGridId = jest.fn().mockResolvedValue(42);
      const trigger = jest.fn().mockResolvedValue(true);

      await dispatchFill(
        { exchange: 'upbit', market: 'KRW-BTC', uuid: 'order-uuid-4', state: 'done' },
        { mode: 'off', lookupGridId, trigger },
      );

      expect(lookupGridId).not.toHaveBeenCalled();
      expect(trigger).not.toHaveBeenCalled();
    });
  });

  describe('getRealtimeFillWsMode — env 플래그 call-time 읽기', () => {
    it('REALTIME_FILL_WS_MODE 미설정 시 기본값 off', async () => {
      delete process.env.REALTIME_FILL_WS_MODE;
      const { getRealtimeFillWsMode } = await import('../../src/services/private-order-ws');
      expect(getRealtimeFillWsMode()).toBe('off');
    });

    it('REALTIME_FILL_WS_MODE=shadow 반영', async () => {
      process.env.REALTIME_FILL_WS_MODE = 'shadow';
      const { getRealtimeFillWsMode } = await import('../../src/services/private-order-ws');
      expect(getRealtimeFillWsMode()).toBe('shadow');
      delete process.env.REALTIME_FILL_WS_MODE;
    });

    it('REALTIME_FILL_WS_MODE=on 반영', async () => {
      process.env.REALTIME_FILL_WS_MODE = 'on';
      const { getRealtimeFillWsMode } = await import('../../src/services/private-order-ws');
      expect(getRealtimeFillWsMode()).toBe('on');
      delete process.env.REALTIME_FILL_WS_MODE;
    });

    it('알 수 없는 값은 off로 폴백(안전 기본값)', async () => {
      process.env.REALTIME_FILL_WS_MODE = 'garbage';
      const { getRealtimeFillWsMode } = await import('../../src/services/private-order-ws');
      expect(getRealtimeFillWsMode()).toBe('off');
      delete process.env.REALTIME_FILL_WS_MODE;
    });
  });
});
