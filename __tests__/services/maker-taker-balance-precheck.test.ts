import { checkMakerPlacementBalance } from '../../src/services/maker-taker-balance-precheck';

describe('checkMakerPlacementBalance', () => {
  const baseArgs = {
    takerCoin: 'USDT',
    quantity: 10,
    makerOrderPrice: 1480,
    makerFeeBps: 5,
  };

  it('USDT/KRW 충분 → ok', () => {
    const result = checkMakerPlacementBalance({
      ...baseArgs,
      balances: { USDT: 100, KRW: 100_000 },
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('USDT 잔고 부족 (수량 미달) → fail', () => {
    const result = checkMakerPlacementBalance({
      ...baseArgs,
      balances: { USDT: 5, KRW: 100_000 },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('USDT balance 5');
    expect(result.reason).toContain('< required 10');
  });

  it('USDT key 자체 부재 → 0으로 간주, fail', () => {
    const result = checkMakerPlacementBalance({
      ...baseArgs,
      balances: { KRW: 100_000 },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('USDT balance 0');
  });

  it('KRW 잔고 부족 (maker fee 포함 미달) → fail', () => {
    // 필요 KRW = 1480 × 10 × 1.0005 = 14807.4
    const result = checkMakerPlacementBalance({
      ...baseArgs,
      balances: { USDT: 100, KRW: 14000 },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('KRW balance 14000');
  });

  it('KRW 정확히 fee 포함 임계값 → ok', () => {
    const required = 1480 * 10 * (1 + 5 / 10000); // 14807.4
    const result = checkMakerPlacementBalance({
      ...baseArgs,
      balances: { USDT: 100, KRW: required },
    });
    expect(result.ok).toBe(true);
  });

  it('takerCoin이 USDC인 경우 → USDC 잔고 검증', () => {
    const result = checkMakerPlacementBalance({
      ...baseArgs,
      takerCoin: 'USDC',
      balances: { USDC: 100, USDT: 0, KRW: 100_000 },
    });
    expect(result.ok).toBe(true);
  });

  it('USDT 검증이 KRW 검증보다 먼저 발동', () => {
    // 둘 다 부족 시 USDT 메시지 우선
    const result = checkMakerPlacementBalance({
      ...baseArgs,
      balances: { USDT: 0, KRW: 0 },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('USDT');
  });
});
