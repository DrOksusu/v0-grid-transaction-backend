import { computeReclaimQty } from '../../src/services/reclaim/sizing';

const base = {
  bithumbBidQty: 100, upbitAskQty: 100, bithumbHolding: 100,
  upbitKrw: 1_000_000, upbitAsk: 1000, maxOrderKrw: 50000, feeBps: 5,
};

describe('computeReclaimQty', () => {
  it('최우선호가 물량이 가장 작으면 그 값으로 제한', () => {
    expect(computeReclaimQty({ ...base, bithumbBidQty: 3 })).toBeCloseTo(3, 8);
    expect(computeReclaimQty({ ...base, upbitAskQty: 2 })).toBeCloseTo(2, 8);
  });
  it('보유 재고가 가장 작으면 재고로 제한', () => {
    expect(computeReclaimQty({ ...base, bithumbHolding: 1.5 })).toBeCloseTo(1.5, 8);
  });
  it('1회 한도(maxOrderKrw)로 제한 — 50000/1000 = 50', () => {
    expect(computeReclaimQty(base)).toBeCloseTo(50, 8);
  });
  it('업비트 KRW 잔고 부족이면 그만큼만', () => {
    // upbitKrw 10000, ask 1000, fee 0.05% → 10000/(1000*1.0005) ≈ 9.995
    expect(computeReclaimQty({ ...base, upbitKrw: 10000 })).toBeLessThan(10);
  });
  it('음수/0 입력 방어 → 0', () => {
    expect(computeReclaimQty({ ...base, bithumbHolding: 0 })).toBe(0);
  });
});
