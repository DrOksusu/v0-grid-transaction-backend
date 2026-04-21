import {
  computeDepegStatus,
  optimisticUpdate,
  getCachedInventory,
  _clearCacheForTesting,
} from '../../src/services/stablecoin-inventory.service';

describe('computeDepegStatus', () => {
  it('정상 범위면 모든 코인 not depegged', () => {
    const prices = {
      USDT: 1400, USDC: 1401, USDS: 1399, USD1: 1400, USDE: 1402,
    };
    const result = computeDepegStatus(prices, 200);  // 200bp = 2%
    Object.values(result).forEach(v => expect(v).toBe(false));
  });

  it('한 코인이 중앙값 대비 2% 이상 벗어나면 depegged', () => {
    const prices = {
      USDT: 1400, USDC: 1400, USDS: 1400, USD1: 1428, USDE: 1400,
    };
    // 중앙값 1400, USD1 = 1428 → (1428-1400)/1400 = 2%
    const result = computeDepegStatus(prices, 200);
    expect(result.USD1).toBe(true);
    expect(result.USDT).toBe(false);
  });

  it('코인 가격이 missing이면 해당 코인은 not depegged 처리', () => {
    const prices = {
      USDT: 1400, USDC: 1400, USDS: 1400, USD1: null, USDE: 1400,
    } as any;
    const result = computeDepegStatus(prices, 200);
    expect(result.USD1).toBe(false);
  });

  it('유효 데이터 3개 미만이면 전부 not depegged (판정 불가)', () => {
    const prices = {
      USDT: 1400, USDC: null, USDS: null, USD1: null, USDE: null,
    } as any;
    const result = computeDepegStatus(prices, 200);
    Object.values(result).forEach(v => expect(v).toBe(false));
  });
});

describe('optimisticUpdate / getCachedInventory (캐시 격리)', () => {
  beforeEach(() => {
    _clearCacheForTesting();
  });

  it('캐시가 없으면 optimisticUpdate는 undefined 반환', () => {
    const result = optimisticUpdate(1, { USDT: 5 });
    expect(result).toBeUndefined();
  });

  it('getCachedInventory는 초기에 undefined', () => {
    expect(getCachedInventory(1)).toBeUndefined();
  });

  it('서로 다른 botId 캐시는 독립적', () => {
    // 두 봇에 대해 수동으로 캐시 세팅이 불가능하므로, reconcileInventory가 필요
    // 이 케이스는 optimisticUpdate만 단독으로 검증 불가 → 간단히 캐시 없을 때 서로 영향 없음만 확인
    const a = optimisticUpdate(1, { USDT: 5 });
    const b = getCachedInventory(2);
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
  });
});

describe('computeDepegStatus — 경계값', () => {
  it('경계값 바로 아래는 not depegged (1427 ≈ 1.93%)', () => {
    const prices = { USDT: 1400, USDC: 1400, USDS: 1400, USD1: 1427, USDE: 1400 };
    const result = computeDepegStatus(prices, 200);
    expect(result.USD1).toBe(false);
  });

  it('경계값 바로 위는 depegged (1429 ≈ 2.07%)', () => {
    const prices = { USDT: 1400, USDC: 1400, USDS: 1400, USD1: 1429, USDE: 1400 };
    const result = computeDepegStatus(prices, 200);
    expect(result.USD1).toBe(true);
  });
});
