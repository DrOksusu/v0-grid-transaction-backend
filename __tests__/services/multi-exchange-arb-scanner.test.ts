// 오케스트레이터 흐름 테스트 — 하위 모듈 전부 모킹 (spec §5 데이터 흐름, 2026-09-22 호가·깊이·순차익 개편)
import { multiExchangeArbScannerService, computeKimchiPct } from '../../src/services/multi-exchange-arb-scanner.service';
import { multiArbSymbolUniverseService } from '../../src/services/multi-arb-symbol-universe.service';
import { multiArbBookSource } from '../../src/services/multi-arb-book-source.service';
import { multiArbPriceSource } from '../../src/services/multi-arb-price-source.service';
import { multiArbWalletStatusService } from '../../src/services/multi-arb-wallet-status.service';
import { multiArbNotifierService } from '../../src/services/multi-arb-notifier.service';
import { getAdminCreds } from '../../src/services/admin-credentials';
import { BookLevel, BookMap, PriceMap, MultiArbExchange } from '../../src/services/multi-arb-types';

jest.mock('../../src/services/multi-arb-symbol-universe.service', () => ({
  multiArbSymbolUniverseService: { getUniverse: jest.fn() },
}));
jest.mock('../../src/services/multi-arb-book-source.service', () => ({
  multiArbBookSource: { fetchAllBooks: jest.fn() },
}));
jest.mock('../../src/services/multi-arb-price-source.service', () => ({
  multiArbPriceSource: { getKrwPerUsdt: jest.fn() },
}));
jest.mock('../../src/services/multi-arb-wallet-status.service', () => ({
  multiArbWalletStatusService: { getAll: jest.fn() },
}));
jest.mock('../../src/services/multi-arb-notifier.service', () => ({
  multiArbNotifierService: { notify: jest.fn(), recordPriceAnomaly: jest.fn() },
}));
// depth 서비스는 vwapForNotional(computeNet이 실제로 import)까지 auto-mock되지 않도록 부분 모킹한다.
// USDT권 shortlist만 쓰는 fetch*Depth 세 개만 목으로 대체하고 나머지(vwapForNotional)는 실제 구현 유지.
jest.mock('../../src/services/multi-arb-depth.service', () => ({
  ...jest.requireActual('../../src/services/multi-arb-depth.service'),
  fetchBinanceDepth: jest.fn(),
  fetchMexcDepth: jest.fn(),
  fetchGateioDepth: jest.fn(),
}));
jest.mock('../../src/services/admin-credentials', () => ({
  getAdminCreds: jest.fn(),
}));
jest.mock('../../src/services/exchange/bithumb-client', () => {
  const actual = jest.requireActual('../../src/services/exchange/bithumb-client');
  return {
    ...actual,
    BithumbClient: jest.fn().mockImplementation(() => ({
      getWithdrawFeeInfo: jest.fn().mockResolvedValue(null),
    })),
  };
});

const depthMock = require('../../src/services/multi-arb-depth.service');

const mockUniverse = multiArbSymbolUniverseService.getUniverse as jest.Mock;
const mockBooks = multiArbBookSource.fetchAllBooks as jest.Mock;
const mockKrwPerUsdt = multiArbPriceSource.getKrwPerUsdt as jest.Mock;
const mockWallets = multiArbWalletStatusService.getAll as jest.Mock;
const mockNotify = multiArbNotifierService.notify as jest.Mock;
const mockRecordAnomaly = (multiArbNotifierService as any).recordPriceAnomaly as jest.Mock;
const mockGetAdminCreds = getAdminCreds as jest.Mock;
const mockFetchBinanceDepth = depthMock.fetchBinanceDepth as jest.Mock;
const mockFetchMexcDepth = depthMock.fetchMexcDepth as jest.Mock;
const mockFetchGateioDepth = depthMock.fetchGateioDepth as jest.Mock;

function priceMap(entries: Record<string, number>): PriceMap {
  return new Map(Object.entries(entries));
}

// 가격 P를 넉넉한 깊이(BIG 수량)를 가진 BookTop으로 감싼다.
// KRW권 최소주문 10만원/USDT권 100USDT를 항상 채울 수 있도록 큰 수량을 부여해
// "깊이+순차익" 게이트가 새로 추가되어도 실현 스프레드(가격) 검증에 집중할 수 있게 한다.
const BIG_QTY = 1_000_000;
function bookMap(entries: Record<string, number>): BookMap {
  const map: BookMap = new Map();
  for (const [symbol, price] of Object.entries(entries)) {
    const level: BookLevel = { price, qty: BIG_QTY };
    map.set(symbol, { ask: price, bid: price, askLevels: [level], bidLevels: [level] });
  }
  return map;
}

describe('multiExchangeArbScannerService.scanOnce', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockKrwPerUsdt.mockResolvedValue(1385);
    mockWallets.mockResolvedValue({
      upbit: new Map([['WLD', [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }]]]),
      bithumb: new Map([['WLD', [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }]]]),
    });
    mockNotify.mockResolvedValue(true);
    mockRecordAnomaly.mockResolvedValue(undefined);
    mockGetAdminCreds.mockResolvedValue(null); // bithumb 출금료 조회 스킵 (미확인 처리)
    mockFetchBinanceDepth.mockResolvedValue(null);
    mockFetchMexcDepth.mockResolvedValue(null);
    mockFetchGateioDepth.mockResolvedValue(null);
  });

  it('임계값(1%) 초과 후보만 실현가능성 판정 후 알림에 넘긴다 (spec §5 step 4~6)', async () => {
    mockUniverse.mockResolvedValue({ krw: ['WLD', 'BTC'], usdt: [] });
    mockBooks.mockResolvedValue({
      upbit: bookMap({ WLD: 4340, BTC: 100000000 }),
      bithumb: bookMap({ WLD: 4200, BTC: 100050000 }), // BTC 스프레드 0.05% → 임계값 미달
    } as Partial<Record<MultiArbExchange, BookMap>>);

    const summary = await multiExchangeArbScannerService.scanOnce();

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const [cand, feas, kimchi, net] = mockNotify.mock.calls[0];
    expect(cand.symbol).toBe('WLD');
    expect(cand.buyExchange).toBe('bithumb');
    expect(feas.feasibility).toBe('feasible');
    expect(typeof kimchi === 'number' || kimchi === null).toBe(true);
    expect(net.depthOk).toBe(true); // 넉넉한 깊이 픽스처 → 최소주문 규모 충족
    expect(summary.hotCandidates).toBe(1);
    expect(summary.alerted).toBe(1);
  });

  it('임계값 미달이면 알림 없음', async () => {
    mockUniverse.mockResolvedValue({ krw: ['BTC'], usdt: [] });
    mockBooks.mockResolvedValue({
      upbit: bookMap({ BTC: 100000000 }),
      bithumb: bookMap({ BTC: 100050000 }),
    });
    const summary = await multiExchangeArbScannerService.scanOnce();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(summary.alerted).toBe(0);
  });

  it('한 후보의 notify 실패가 다른 후보를 막지 않는다', async () => {
    mockWallets.mockResolvedValue({
      upbit: new Map([['WLD', [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }]]]),
      bithumb: new Map([['WLD', [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }]]]),
      binance: new Map([['PEPE', [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }]]]),
      mexc: new Map([['PEPE', [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }]]]),
    });
    mockUniverse.mockResolvedValue({ krw: ['WLD'], usdt: ['PEPE'] });
    mockBooks.mockResolvedValue({
      upbit: bookMap({ WLD: 4340 }),
      bithumb: bookMap({ WLD: 4200 }),
      binance: bookMap({ PEPE: 0.00001 }),
      mexc: bookMap({ PEPE: 0.0000105 }),
    });
    // USDT권(PEPE)은 book levels 없음(최우선만) → shortlist depth 조회로 넘어감, 넉넉한 깊이로 응답
    mockFetchBinanceDepth.mockResolvedValue({ askLevels: [{ price: 0.00001, qty: BIG_QTY }], bidLevels: [{ price: 0.00001, qty: BIG_QTY }] });
    mockFetchMexcDepth.mockResolvedValue({ askLevels: [{ price: 0.0000105, qty: BIG_QTY }], bidLevels: [{ price: 0.0000105, qty: BIG_QTY }] });
    mockNotify.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(true);
    const summary = await multiExchangeArbScannerService.scanOnce();
    expect(mockNotify).toHaveBeenCalledTimes(2);
    expect(summary.alerted).toBe(1);
  });

  it('network_mismatch 후보는 양쪽 거래소 네트워크 목록을 console.warn으로 요약 로깅한다 (Task 7 리뷰 반영)', async () => {
    // LSK류 함정: 업비트 LSK망 ↔ 빗썸 ETH망 (교집합 0)
    mockWallets.mockResolvedValue({
      upbit: new Map([['LSK', [{ network: 'LSK', depositEnabled: true, withdrawEnabled: true }]]]),
      bithumb: new Map([['LSK', [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }]]]),
    });
    mockUniverse.mockResolvedValue({ krw: ['LSK'], usdt: [] });
    // 바이낸스 기준가 0.5 USDT × 1385 = 692.5 KRW → 533(0.77x)/1322(1.91x) 모두 sanity 허용 범위
    // (Task 12 sanity check 도입 후에도 network_mismatch 경고 경로가 검증되도록 기준가를 픽스처에 포함)
    mockBooks.mockResolvedValue({
      upbit: bookMap({ LSK: 533 }),
      bithumb: bookMap({ LSK: 1322 }),
      binance: bookMap({ LSK: 0.5 }),
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await multiExchangeArbScannerService.scanOnce();

      // 알림 자체는 경고 태그와 함께 발송된다 (spec §6, FEASIBLE_ONLY 기본값이지만 notify 호출 자체는 유지)
      expect(mockNotify).toHaveBeenCalledTimes(1);
      expect(mockNotify.mock.calls[0][1].feasibility).toBe('network_mismatch');

      // 사이클당 1회 요약 warn — 양쪽 거래소의 정규화 네트워크 목록 포함
      const warnCalls = warnSpy.mock.calls.filter(c => String(c[0]).includes('network_mismatch'));
      expect(warnCalls).toHaveLength(1);
      const logged = String(warnCalls[0][0]);
      expect(logged).toContain('LSK zone=KRW');
      expect(logged).toContain('buy=upbit[LSK]');
      expect(logged).toContain('sell=bithumb[ETH]');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('(e) 가격 sanity 미달 후보는 실현가능성/알림 단계에서 제외하고 warn 요약 로깅한다 (Task 12)', async () => {
    // TROLL류: 바이낸스에 없는 코인 + 스프레드 28억% → 폴백(스프레드 상한)으로 제외
    mockUniverse.mockResolvedValue({ krw: [], usdt: ['TROLL'] });
    mockBooks.mockResolvedValue({
      mexc: bookMap({ TROLL: 1.6e-9 }),
      gateio: bookMap({ TROLL: 0.046 }),
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const summary = await multiExchangeArbScannerService.scanOnce();

      expect(mockNotify).not.toHaveBeenCalled();
      expect(summary.alerted).toBe(0);

      // I-2: 제외 건은 분석용으로 price_anomaly 기록에 위임 (카톡 발송 없음)
      expect(mockRecordAnomaly).toHaveBeenCalledTimes(1);
      expect(mockRecordAnomaly.mock.calls[0][0].symbol).toBe('TROLL');
      expect(typeof mockRecordAnomaly.mock.calls[0][1]).toBe('string');

      const warnCalls = warnSpy.mock.calls.filter(c => String(c[0]).includes('price_sanity'));
      expect(warnCalls).toHaveLength(1);
      expect(String(warnCalls[0][0])).toContain('TROLL');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('기준가(바이낸스) 있는 이상치는 배수 포함 warn 로깅 후 제외, 정상 후보는 그대로 알림된다', async () => {
    // XEM: 바이낸스 0.02 USDT × 1385 = 27.7 KRW 기준인데 업비트 850 KRW (30.7x) → 티커 충돌 의심
    // WLD: 바이낸스 3.1 USDT × 1385 = 4,293.5 KRW 기준, 국내 4,200/4,340 → 정상 통과
    mockWallets.mockResolvedValue({
      upbit: new Map([
        ['WLD', [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }]],
        ['XEM', [{ network: 'XEM', depositEnabled: true, withdrawEnabled: true }]],
      ]),
      bithumb: new Map([
        ['WLD', [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }]],
        ['XEM', [{ network: 'XEM', depositEnabled: true, withdrawEnabled: true }]],
      ]),
    });
    mockUniverse.mockResolvedValue({ krw: ['WLD', 'XEM'], usdt: [] });
    mockBooks.mockResolvedValue({
      upbit: bookMap({ WLD: 4340, XEM: 850 }),
      bithumb: bookMap({ WLD: 4200, XEM: 28 }),
      binance: bookMap({ WLD: 3.1, XEM: 0.02 }),
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const summary = await multiExchangeArbScannerService.scanOnce();

      // 정상 후보(WLD)만 알림 — 진짜 기회는 보존
      expect(mockNotify).toHaveBeenCalledTimes(1);
      expect(mockNotify.mock.calls[0][0].symbol).toBe('WLD');
      expect(summary.alerted).toBe(1);

      const warnCalls = warnSpy.mock.calls.filter(c => String(c[0]).includes('price_sanity'));
      expect(warnCalls).toHaveLength(1);
      const logged = String(warnCalls[0][0]);
      expect(logged).toContain('XEM');
      expect(logged).toContain('upbit'); // 어느 쪽 가격이 이상인지
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('mismatch 없는 사이클에는 network_mismatch warn 로그가 없다', async () => {
    mockUniverse.mockResolvedValue({ krw: ['WLD'], usdt: [] });
    mockBooks.mockResolvedValue({
      upbit: bookMap({ WLD: 4340 }),
      bithumb: bookMap({ WLD: 4200 }),
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await multiExchangeArbScannerService.scanOnce();
      const warnCalls = warnSpy.mock.calls.filter(c => String(c[0]).includes('network_mismatch'));
      expect(warnCalls).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// I-1: 알림 폭주 방지 — 발송 게이트(ENABLED) / 사이클당 상한(MAX_ALERTS_PER_CYCLE) / feasible 전용(FEASIBLE_ONLY)
// 게이트는 "카톡 발송"에만 적용: notify 5번째 인자 {send}로 위임하고 DB 기록·쿨다운·별칭 로그는 종전 유지
// (2026-09-22 개편: notify 시그니처가 (candidate, feasibility, kimchiPct, net, options)로 확장되어
//  옵션 인자 인덱스가 3→4로 이동했다)
describe('알림 발송 게이트 (I-1)', () => {
  const GATE_ENVS = [
    'MULTI_ARB_ALERT_ENABLED',
    'MULTI_ARB_MAX_ALERTS_PER_CYCLE',
    'MULTI_ARB_ALERT_FEASIBLE_ONLY',
  ];

  // feasible 후보 픽스처: WLD +3.33% / SOL +5%
  function setupTwoFeasible() {
    mockWallets.mockResolvedValue({
      upbit: new Map([
        ['WLD', [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }]],
        ['SOL', [{ network: 'SOL', depositEnabled: true, withdrawEnabled: true }]],
      ]),
      bithumb: new Map([
        ['WLD', [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }]],
        ['SOL', [{ network: 'SOL', depositEnabled: true, withdrawEnabled: true }]],
      ]),
    });
    mockUniverse.mockResolvedValue({ krw: ['WLD', 'SOL'], usdt: [] });
    mockBooks.mockResolvedValue({
      upbit: bookMap({ WLD: 4340, SOL: 210000 }),
      bithumb: bookMap({ WLD: 4200, SOL: 200000 }),
    });
  }

  // network_mismatch 후보 픽스처: LSK +148% (바이낸스 기준가로 sanity 통과)
  function setupMismatchLsk() {
    mockWallets.mockResolvedValue({
      upbit: new Map([['LSK', [{ network: 'LSK', depositEnabled: true, withdrawEnabled: true }]]]),
      bithumb: new Map([['LSK', [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }]]]),
    });
    mockUniverse.mockResolvedValue({ krw: ['LSK'], usdt: [] });
    mockBooks.mockResolvedValue({
      upbit: bookMap({ LSK: 533 }),
      bithumb: bookMap({ LSK: 1322 }),
      binance: bookMap({ LSK: 0.5 }),
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockKrwPerUsdt.mockResolvedValue(1385);
    mockGetAdminCreds.mockResolvedValue(null);
    mockFetchBinanceDepth.mockResolvedValue(null);
    mockFetchMexcDepth.mockResolvedValue(null);
    mockFetchGateioDepth.mockResolvedValue(null);
    // 실제 notifier 계약과 동일: send=false면 발송 없이 false 반환 (DB 기록만)
    mockNotify.mockImplementation(async (_c, _f, _k, _net, opts) => opts?.send === true);
    mockRecordAnomaly.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const key of GATE_ENVS) delete process.env[key];
  });

  it('기본값(MULTI_ARB_ALERT_ENABLED 미설정=false): 스캔·DB 기록은 수행하되 send:false로 위임한다', async () => {
    setupTwoFeasible();
    await multiExchangeArbScannerService.scanOnce();
    expect(mockNotify).toHaveBeenCalledTimes(2); // DB 기록 경로는 유지 (스캔 정지 금지)
    for (const call of mockNotify.mock.calls) {
      expect(call[4]).toEqual({ send: false });
    }
  });

  it('ENABLED=true + feasible 후보는 send:true로 발송된다', async () => {
    process.env.MULTI_ARB_ALERT_ENABLED = 'true';
    setupTwoFeasible();
    const summary = await multiExchangeArbScannerService.scanOnce();
    expect(mockNotify).toHaveBeenCalledTimes(2);
    for (const call of mockNotify.mock.calls) {
      expect(call[4]).toEqual({ send: true });
    }
    expect(summary.alerted).toBe(2);
  });

  it('FEASIBLE_ONLY 기본(true): 주의 태그(network_mismatch)는 send:false — DB 기록/로그만', async () => {
    process.env.MULTI_ARB_ALERT_ENABLED = 'true';
    setupMismatchLsk();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await multiExchangeArbScannerService.scanOnce();
      expect(mockNotify).toHaveBeenCalledTimes(1);
      expect(mockNotify.mock.calls[0][1].feasibility).toBe('network_mismatch');
      expect(mockNotify.mock.calls[0][4]).toEqual({ send: false });
      // 별칭 수집 로그는 종전대로 유지
      const warnCalls = warnSpy.mock.calls.filter(c => String(c[0]).includes('network_mismatch'));
      expect(warnCalls).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('FEASIBLE_ONLY=false면 주의 태그도 send:true로 발송된다', async () => {
    process.env.MULTI_ARB_ALERT_ENABLED = 'true';
    process.env.MULTI_ARB_ALERT_FEASIBLE_ONLY = 'false';
    setupMismatchLsk();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await multiExchangeArbScannerService.scanOnce();
      expect(mockNotify).toHaveBeenCalledTimes(1);
      expect(mockNotify.mock.calls[0][4]).toEqual({ send: true });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('MAX_ALERTS_PER_CYCLE=1: 순차익 큰 후보(SOL)만 send:true, 초과분(WLD)은 send:false', async () => {
    process.env.MULTI_ARB_ALERT_ENABLED = 'true';
    process.env.MULTI_ARB_MAX_ALERTS_PER_CYCLE = '1';
    setupTwoFeasible();
    const summary = await multiExchangeArbScannerService.scanOnce();
    expect(mockNotify).toHaveBeenCalledTimes(2);
    // 우선순위 정렬: 순차익 큰 순 → SOL(+5%) 먼저 (넉넉한 깊이 픽스처라 gross≈실현 스프레드로 순위 보존)
    expect(mockNotify.mock.calls[0][0].symbol).toBe('SOL');
    expect(mockNotify.mock.calls[0][4]).toEqual({ send: true });
    expect(mockNotify.mock.calls[1][0].symbol).toBe('WLD');
    expect(mockNotify.mock.calls[1][4]).toEqual({ send: false });
    expect(summary.alerted).toBe(1);
  });

  it('발송 우선순위: FEASIBLE_ONLY=false + MAX=1이면 순차익 작아도 feasible이 주의 태그보다 먼저', async () => {
    process.env.MULTI_ARB_ALERT_ENABLED = 'true';
    process.env.MULTI_ARB_ALERT_FEASIBLE_ONLY = 'false';
    process.env.MULTI_ARB_MAX_ALERTS_PER_CYCLE = '1';
    // WLD feasible +3.33% vs LSK mismatch +148%
    mockWallets.mockResolvedValue({
      upbit: new Map([
        ['WLD', [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }]],
        ['LSK', [{ network: 'LSK', depositEnabled: true, withdrawEnabled: true }]],
      ]),
      bithumb: new Map([
        ['WLD', [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }]],
        ['LSK', [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }]],
      ]),
    });
    mockUniverse.mockResolvedValue({ krw: ['WLD', 'LSK'], usdt: [] });
    mockBooks.mockResolvedValue({
      upbit: bookMap({ WLD: 4340, LSK: 533 }),
      bithumb: bookMap({ WLD: 4200, LSK: 1322 }),
      binance: bookMap({ LSK: 0.5 }),
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await multiExchangeArbScannerService.scanOnce();
      expect(mockNotify).toHaveBeenCalledTimes(2);
      expect(mockNotify.mock.calls[0][0].symbol).toBe('WLD'); // feasible 우선
      expect(mockNotify.mock.calls[0][4]).toEqual({ send: true });
      expect(mockNotify.mock.calls[1][0].symbol).toBe('LSK');
      expect(mockNotify.mock.calls[1][4]).toEqual({ send: false });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('상한은 실제 발송 성공 기준: 쿨다운 스킵(false)은 상한을 소모하지 않는다', async () => {
    process.env.MULTI_ARB_ALERT_ENABLED = 'true';
    process.env.MULTI_ARB_MAX_ALERTS_PER_CYCLE = '1';
    setupTwoFeasible();
    mockNotify.mockResolvedValueOnce(false).mockResolvedValueOnce(true); // 첫 건 쿨다운 스킵
    const summary = await multiExchangeArbScannerService.scanOnce();
    expect(mockNotify).toHaveBeenCalledTimes(2);
    expect(mockNotify.mock.calls[0][4]).toEqual({ send: true });
    expect(mockNotify.mock.calls[1][4]).toEqual({ send: true }); // 상한 미소모 → 다음 후보 발송 가능
    expect(summary.alerted).toBe(1);
  });
});

// (MAJOR 리뷰 반영) 순차익 reject-path 통합 테스트 — 기존 픽스처는 전부 BIG_QTY(넉넉한 깊이)+adminCreds=null이라
// "최우선호가는 임계 이상인데 순차익이 미달 → 발송 억제" 경로가 검증되지 않았다.
// 게이트를 켜고(feasible 후보) 발송 여부를 결정하는 구체적 원인(depthOk / netSpreadPct)까지 단언한다.
describe('순차익 reject-path (MAJOR 리뷰 반영)', () => {
  const GATE_ENVS = ['MULTI_ARB_ALERT_ENABLED', 'MULTI_ARB_UNKNOWN_WITHDRAW_PCT'];

  beforeEach(() => {
    jest.clearAllMocks();
    mockKrwPerUsdt.mockResolvedValue(1385);
    mockNotify.mockImplementation(async (_c, _f, _k, _net, opts) => opts?.send === true);
    mockRecordAnomaly.mockResolvedValue(undefined);
    mockGetAdminCreds.mockResolvedValue(null);
    mockFetchBinanceDepth.mockResolvedValue(null);
    mockFetchMexcDepth.mockResolvedValue(null);
    mockFetchGateioDepth.mockResolvedValue(null);
    process.env.MULTI_ARB_ALERT_ENABLED = 'true';
  });

  afterEach(() => {
    for (const key of GATE_ENVS) delete process.env[key];
  });

  it('(a) 얇은 깊이: 최우선호가 스프레드는 임계 이상이지만 최소주문 VWAP 미충족 → depthOk=false로 발송 억제', async () => {
    mockWallets.mockResolvedValue({
      upbit: new Map([['WLD', [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }]]]),
      bithumb: new Map([['WLD', [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }]]]),
    });
    mockUniverse.mockResolvedValue({ krw: ['WLD'], usdt: [] });
    // 최우선호가 스프레드는 +3.33%로 임계값(1%) 이상이지만, 각 호가에 걸린 수량이 얕아
    // 최소주문 10만원(KRW)을 채우지 못한다 (매수측 ask 4200 × qty 1 = 4,200원 << 100,000원).
    const thinLevel = (price: number) => [{ price, qty: 1 }];
    mockBooks.mockResolvedValue({
      upbit: new Map([['WLD', { ask: 4340, bid: 4340, askLevels: thinLevel(4340), bidLevels: thinLevel(4340) }]]),
      bithumb: new Map([['WLD', { ask: 4200, bid: 4200, askLevels: thinLevel(4200), bidLevels: thinLevel(4200) }]]),
    });

    const summary = await multiExchangeArbScannerService.scanOnce();

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const [, feas, , net, opts] = mockNotify.mock.calls[0];
    expect(feas.feasibility).toBe('feasible');
    expect(net.depthOk).toBe(false); // 얕은 깊이 → 최소주문 VWAP 미충족
    expect(opts).toEqual({ send: false });
    expect(summary.alerted).toBe(0);
  });

  it('(b) 출금료로 순차익 미달: gross는 임계 이상이지만 알려진 출금료 반영 시 net<1% → 발송 억제', async () => {
    // 바이낸스 매수 → MEXC 매도, USDT권. gross ≈ 1.1% (수수료 0.2% 차감해도 통과권)이지만
    // 바이낸스 NetworkStatus.withdrawFee(코인 정액)를 반영하면 net이 1% 밑으로 떨어지도록 구성.
    mockWallets.mockResolvedValue({
      binance: new Map([['ABC', [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true, withdrawFee: 5 }]]]),
      mexc: new Map([['ABC', [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }]]]),
    });
    mockUniverse.mockResolvedValue({ krw: [], usdt: ['ABC'] });
    mockBooks.mockResolvedValue({
      binance: new Map([['ABC', { ask: 1, bid: 1 }]]),   // levels 없음(최우선만) → shortlist depth 조회로 넘어감
      mexc: new Map([['ABC', { ask: 1.011, bid: 1.011 }]]), // 실현 스프레드 +1.1%
    });
    // 넉넉한 깊이(최소주문 100USDT 충족)로 depth를 채워 depthOk는 통과시키고 출금료만으로 net 미달을 검증
    mockFetchBinanceDepth.mockResolvedValue({ askLevels: [{ price: 1, qty: 1000 }], bidLevels: [{ price: 1, qty: 1000 }] });
    mockFetchMexcDepth.mockResolvedValue({ askLevels: [{ price: 1.011, qty: 1000 }], bidLevels: [{ price: 1.011, qty: 1000 }] });

    const summary = await multiExchangeArbScannerService.scanOnce();

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const [, feas, , net, opts] = mockNotify.mock.calls[0];
    expect(feas.feasibility).toBe('feasible');
    expect(net.depthOk).toBe(true);
    expect(net.withdrawFeeKnown).toBe(true); // 바이낸스 NetworkStatus.withdrawFee로 확인됨(폴백 아님)
    expect(net.netSpreadPct).toBeLessThan(1); // 출금료 반영 시 임계값 미달
    expect(opts).toEqual({ send: false });
    expect(summary.alerted).toBe(0);
  });
});

describe('computeKimchiPct (spec §5 step 7: 참고 수치, 알림 트리거 아님)', () => {
  it('국내(업비트 우선) vs 해외(바이낸스 우선) 김프% 계산', () => {
    const prices: Partial<Record<MultiArbExchange, PriceMap>> = {
      upbit: priceMap({ WLD: 4340 }),
      binance: priceMap({ WLD: 3.1 }),
    };
    // 4340 / (3.1 * 1385) - 1 = +1.08%
    expect(computeKimchiPct('WLD', prices, 1385)).toBeCloseTo((4340 / (3.1 * 1385) - 1) * 100, 6);
  });

  it('환율 또는 한쪽 가격이 없으면 null', () => {
    const prices: Partial<Record<MultiArbExchange, PriceMap>> = { upbit: priceMap({ WLD: 4340 }) };
    expect(computeKimchiPct('WLD', prices, 1385)).toBeNull();     // 해외가 없음
    expect(computeKimchiPct('WLD', prices, null)).toBeNull();     // 환율 없음
  });
});
