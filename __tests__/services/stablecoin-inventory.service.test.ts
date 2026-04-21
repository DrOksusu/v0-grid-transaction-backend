import { computeDepegStatus } from '../../src/services/stablecoin-inventory.service';

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
