// 재고 되돌림 scanOnce — 로밍과 같은 코인 동시 주문 방지 (이슈 #123)
const mockGetKrwHoldings = jest.fn();
const mockExecuteReclaim = jest.fn();
const mockTradeCreate = jest.fn(async (..._a: any[]) => ({}));

jest.mock('../../src/config/env', () => ({ config: { adminEmail: 'admin@test' } }));
jest.mock('../../src/config/database', () => ({
  __esModule: true,
  default: {
    user: { findFirst: jest.fn(async () => ({ id: 2 })) },
    credential: { findFirst: jest.fn(async () => ({ apiKey: 'k', secretKey: 's' })) },
    arbReclaimConfig: {
      upsert: jest.fn(async () => ({
        enabled: true, killSwitch: false, minNetPct: 0.5, maxOrderKrw: 200000,
        dailyMaxCount: 50, dailyMaxKrw: 5000000, imbalanceCapKrw: 300000,
        withdrawFeePctThreshold: 0.3, excludeMajors: true,
      })),
    },
    arbReclaimTrade: { findMany: jest.fn(async () => []), create: (...a: any[]) => mockTradeCreate(...a) },
    inventoryArbBot: { findMany: jest.fn(async () => []) },
    inventoryArbTrade: { findMany: jest.fn(async () => []) },
  },
}));
jest.mock('../../src/utils/encryption', () => ({ decrypt: (v: string) => v }));
jest.mock('../../src/services/upbit.service', () => ({ UpbitService: class {} }));
jest.mock('../../src/services/exchange/bithumb-client', () => ({ BithumbClient: class {} }));
jest.mock('../../src/services/exchange-leg', () => ({ UpbitLeg: class {}, BithumbLeg: class {} }));
jest.mock('../../src/services/inventory-arb.service', () => ({
  inventoryArbService: { getKrwHoldings: (...a: any[]) => mockGetKrwHoldings(...a) },
}));
jest.mock('../../src/services/inventory-arb/orderbook-depth', () => ({
  fetchUpbitDepthBatch: jest.fn(async (syms: string[]) => new Map(syms.map((s) => [s, { ask: 10, askQty: 100000 }]))),
  fetchOrderbookDepth: jest.fn(async () => ({ bid: 10.2, bidQty: 100000 })),
}));
// 대상 선별은 두 코인 고정 (선별 로직은 reclaim-target.test.ts가 검증)
jest.mock('../../src/services/reclaim/target-selector', () => ({ selectReclaimTargets: () => ['T', 'WAXP'] }));
jest.mock('../../src/services/reclaim/executor', () => ({ executeReclaim: (...a: any[]) => mockExecuteReclaim(...a) }));

import { reclaimService } from '../../src/services/reclaim/reclaim.service';
import { tryLockSymbol, unlockSymbol, isSymbolLocked } from '../../src/services/inventory-arb/symbol-lock';

const filled = { status: 'filled', sellFilled: 1, buyFilled: 1, sellGrossKrw: 10, buyGrossKrw: 9, feeKrw: 0, netKrw: 1, note: '' };

describe('reclaimService.scanOnce 코인 잠금', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // 캐시(오래된) 잔고: 빗썸 T·WAXP 모두 보유
    const stale = { upbit: { KRW: 1_000_000 }, bithumb: { T: 1000, WAXP: 1000 } };
    mockGetKrwHoldings.mockImplementation(async (_u: number, opts?: { fresh?: boolean }) => (opts?.fresh ? freshHoldings : stale));
    mockExecuteReclaim.mockResolvedValue(filled);
    freshHoldings = { upbit: { KRW: 1_000_000 }, bithumb: { T: 1000, WAXP: 1000 } };
  });
  afterEach(() => { unlockSymbol(2, 'T'); unlockSymbol(2, 'WAXP'); });

  let freshHoldings: { upbit: Record<string, number>; bithumb: Record<string, number> };

  it('로밍이 잠근 코인(T)은 건너뛰고 다른 코인(WAXP)만 되돌린다', async () => {
    expect(tryLockSymbol(2, 'T')).toBe(true); // 로밍 실행 중
    await reclaimService.scanOnce();
    const symbols = mockExecuteReclaim.mock.calls.map((c) => c[0].symbol);
    expect(symbols).toEqual(['WAXP']);
    expect(isSymbolLocked(2, 'T')).toBe(true); // 남의 잠금은 건드리지 않음
  });

  it('수량은 잠금 후 최신 잔고로 계산 — 캐시엔 있어도 실제 재고가 0이면 주문하지 않는다', async () => {
    freshHoldings = { upbit: { KRW: 1_000_000 }, bithumb: { T: 0, WAXP: 1000 } }; // 방금 로밍이 T를 다 팔았음
    await reclaimService.scanOnce();
    const symbols = mockExecuteReclaim.mock.calls.map((c) => c[0].symbol);
    expect(symbols).toEqual(['WAXP']);
    expect(mockGetKrwHoldings).toHaveBeenCalledWith(2, { fresh: true });
  });

  it('주문 오류가 나도 잠금을 해제한다', async () => {
    mockExecuteReclaim.mockRejectedValue(new Error('boom'));
    await reclaimService.scanOnce();
    expect(isSymbolLocked(2, 'T')).toBe(false);
    expect(isSymbolLocked(2, 'WAXP')).toBe(false);
  });
});
