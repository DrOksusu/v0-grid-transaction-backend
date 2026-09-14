// 오케스트레이터 흐름 테스트 — 하위 모듈 전부 모킹 (spec §5 데이터 흐름)
import { multiExchangeArbScannerService, computeKimchiPct } from '../../src/services/multi-exchange-arb-scanner.service';
import { multiArbSymbolUniverseService } from '../../src/services/multi-arb-symbol-universe.service';
import { multiArbPriceSource } from '../../src/services/multi-arb-price-source.service';
import { multiArbWalletStatusService } from '../../src/services/multi-arb-wallet-status.service';
import { multiArbNotifierService } from '../../src/services/multi-arb-notifier.service';
import { PriceMap, MultiArbExchange } from '../../src/services/multi-arb-types';

jest.mock('../../src/services/multi-arb-symbol-universe.service', () => ({
  multiArbSymbolUniverseService: { getUniverse: jest.fn() },
}));
jest.mock('../../src/services/multi-arb-price-source.service', () => ({
  multiArbPriceSource: { fetchAllPrices: jest.fn(), getKrwPerUsdt: jest.fn() },
}));
jest.mock('../../src/services/multi-arb-wallet-status.service', () => ({
  multiArbWalletStatusService: { getAll: jest.fn() },
}));
jest.mock('../../src/services/multi-arb-notifier.service', () => ({
  multiArbNotifierService: { notify: jest.fn() },
}));

const mockUniverse = multiArbSymbolUniverseService.getUniverse as jest.Mock;
const mockPrices = multiArbPriceSource.fetchAllPrices as jest.Mock;
const mockKrwPerUsdt = multiArbPriceSource.getKrwPerUsdt as jest.Mock;
const mockWallets = multiArbWalletStatusService.getAll as jest.Mock;
const mockNotify = multiArbNotifierService.notify as jest.Mock;

function priceMap(entries: Record<string, number>): PriceMap {
  return new Map(Object.entries(entries));
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
  });

  it('임계값(2%) 초과 후보만 실현가능성 판정 후 알림에 넘긴다 (spec §5 step 4~6)', async () => {
    mockUniverse.mockResolvedValue({ krw: ['WLD', 'BTC'], usdt: [] });
    mockPrices.mockResolvedValue({
      upbit: priceMap({ WLD: 4340, BTC: 100000000 }),
      bithumb: priceMap({ WLD: 4200, BTC: 100050000 }), // BTC 스프레드 0.05% → 임계값 미달
    } as Partial<Record<MultiArbExchange, PriceMap>>);

    const summary = await multiExchangeArbScannerService.scanOnce();

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const [cand, feas, kimchi] = mockNotify.mock.calls[0];
    expect(cand.symbol).toBe('WLD');
    expect(cand.buyExchange).toBe('bithumb');
    expect(feas.feasibility).toBe('feasible');
    expect(typeof kimchi === 'number' || kimchi === null).toBe(true);
    expect(summary.hotCandidates).toBe(1);
    expect(summary.alerted).toBe(1);
  });

  it('임계값 미달이면 알림 없음', async () => {
    mockUniverse.mockResolvedValue({ krw: ['BTC'], usdt: [] });
    mockPrices.mockResolvedValue({
      upbit: priceMap({ BTC: 100000000 }),
      bithumb: priceMap({ BTC: 100050000 }),
    });
    const summary = await multiExchangeArbScannerService.scanOnce();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(summary.alerted).toBe(0);
  });

  it('한 후보의 notify 실패가 다른 후보를 막지 않는다', async () => {
    mockUniverse.mockResolvedValue({ krw: ['WLD'], usdt: ['PEPE'] });
    mockPrices.mockResolvedValue({
      upbit: priceMap({ WLD: 4340 }),
      bithumb: priceMap({ WLD: 4200 }),
      binance: priceMap({ PEPE: 0.00001 }),
      mexc: priceMap({ PEPE: 0.0000105 }),
    });
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
    mockPrices.mockResolvedValue({
      upbit: priceMap({ LSK: 533 }),
      bithumb: priceMap({ LSK: 1322 }),
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await multiExchangeArbScannerService.scanOnce();

      // 알림 자체는 경고 태그와 함께 발송된다 (spec §6)
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

  it('mismatch 없는 사이클에는 network_mismatch warn 로그가 없다', async () => {
    mockUniverse.mockResolvedValue({ krw: ['WLD'], usdt: [] });
    mockPrices.mockResolvedValue({
      upbit: priceMap({ WLD: 4340 }),
      bithumb: priceMap({ WLD: 4200 }),
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
