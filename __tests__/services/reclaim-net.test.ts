import { reclaimNetPct, shouldReclaim, RECLAIM_FEE_BPS } from '../../src/services/reclaim/net';

describe('reclaimNetPct', () => {
  it('되돌림 순차익% = (빗썸bid-업비트ask)/업비트ask×100 - 수수료%', () => {
    // 빗썸bid 1010, 업비트ask 1000 → gross 1.0%, 수수료 0.09% → net 0.91%
    expect(reclaimNetPct(1010, 1000)).toBeCloseTo(1.0 - RECLAIM_FEE_BPS / 100, 6);
  });
  it('gross가 수수료와 같으면 net 0', () => {
    const ask = 1000, bid = 1000 * (1 + RECLAIM_FEE_BPS / 10000); // gross = 0.09%
    expect(reclaimNetPct(bid, ask)).toBeCloseTo(0, 6);
  });
});

describe('shouldReclaim', () => {
  it('순차익 ≥ minNetPct면 true', () => {
    expect(shouldReclaim(1010, 1000, 0)).toBe(true);   // net 0.91% ≥ 0
    expect(shouldReclaim(1010, 1000, 0.5)).toBe(true);
  });
  it('순차익 < minNetPct면 false', () => {
    expect(shouldReclaim(1000, 1000, 0)).toBe(false);  // net -0.09% < 0
    expect(shouldReclaim(1010, 1000, 2.0)).toBe(false);
  });
});
