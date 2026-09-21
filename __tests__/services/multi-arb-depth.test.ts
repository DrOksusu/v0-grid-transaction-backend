import { vwapForNotional } from '../../src/services/multi-arb-depth.service';
import { BookLevel } from '../../src/services/multi-arb-types';

describe('vwapForNotional', () => {
  it('레벨 부족 시 목표금액을 못 채우면 ok:false, 채운 금액만 반환', () => {
    const levels: BookLevel[] = [{ price: 2000, qty: 10 }]; // 20,000원어치만 존재
    const r = vwapForNotional(levels, 100000);
    expect(r.ok).toBe(false);
    expect(r.filledNotional).toBe(20000);
    expect(r.vwap).toBe(2000);
  });

  it('단일 레벨로 목표금액을 정확히 채우면 ok:true', () => {
    const levels: BookLevel[] = [{ price: 2000, qty: 100 }]; // 200,000원어치
    const r = vwapForNotional(levels, 100000);
    expect(r.ok).toBe(true);
    expect(r.vwap).toBe(2000);
    expect(r.filledNotional).toBe(100000);
  });

  it('2레벨 혼합 VWAP 계산', () => {
    // 레벨1: price 100, qty 5 → 500원어치
    // 레벨2: price 110, qty 100 → 나머지 99500원어치 채우려면 qty = 99500/110 ≈ 904.5454...
    const levels: BookLevel[] = [
      { price: 100, qty: 5 },
      { price: 110, qty: 1000 },
    ];
    const target = 100000;
    const r = vwapForNotional(levels, target);
    expect(r.ok).toBe(true);
    expect(r.filledNotional).toBeCloseTo(target, 6);
    // 소비수량 = 5 + (99500/110), 소비금액 = 100000
    const qty2 = 99500 / 110;
    const totalQty = 5 + qty2;
    const expectedVwap = target / totalQty;
    expect(r.vwap).toBeCloseTo(expectedVwap, 6);
  });

  it('levels가 비면 전부 0/false', () => {
    const r = vwapForNotional([], 100000);
    expect(r).toEqual({ vwap: 0, filledNotional: 0, ok: false });
  });
});
