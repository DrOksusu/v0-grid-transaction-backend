import { evaluateFeasibility } from '../../src/services/inventory-arb/feasibility-gate';
import type { FeasibilityInput, SpreadOpportunity } from '../../src/services/inventory-arb/types';

const opp: SpreadOpportunity = {
  direction: 'buy_upbit_sell_bithumb',
  buyExchange: 'upbit',
  sellExchange: 'bithumb',
  buyPrice: 1000,
  sellPrice: 1010,
  spreadBps: 100,
  maxQtyByDepth: 50,
};

const base: FeasibilityInput = {
  opp,
  minSpreadBps: 30,
  anomalyMaxBps: 2000,
  maxOrderKrw: 20000, // 20 coin @1000
  dailyMaxKrw: null,
  dailyMaxCount: null,
  todayNotionalKrw: 0,
  todayCount: 0,
  sellCoinBalance: 1000,
  buyKrwBalance: 1_000_000,
  buyFeeBps: 5,
};

describe('evaluateFeasibility', () => {
  it('스프레드가 임계 미만이면 거부', () => {
    const r = evaluateFeasibility({ ...base, opp: { ...opp, spreadBps: 10 } });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('spread');
  });

  it('스프레드가 anomaly 상한 초과면 거부', () => {
    const r = evaluateFeasibility({ ...base, opp: { ...opp, spreadBps: 3000 } });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('anomaly');
  });

  it('정상: qty = min(depth, maxOrderKrw/price, 재고, KRW예산)', () => {
    const r = evaluateFeasibility(base);
    // maxOrderKrw 20000 / 1000 = 20; depth 50; 재고 1000; KRW예산 충분 → 20
    expect(r.ok).toBe(true);
    expect(r.qty).toBe(20);
    expect(r.notionalKrw).toBe(20000);
  });

  it('매도 거래소 코인 재고가 부족하면 그만큼만', () => {
    const r = evaluateFeasibility({ ...base, sellCoinBalance: 7 });
    expect(r.qty).toBe(7);
  });

  it('매수 거래소 KRW 예산이 부족하면 그만큼만 (수수료 포함)', () => {
    // KRW 5025 / (1000 * 1.0005) = 5.02248875... → 소수점 8자리 floor (암호화폐 수량은 소수 허용)
    const r = evaluateFeasibility({ ...base, buyKrwBalance: 5025 });
    expect(r.qty).toBeCloseTo(5.02248875, 8);
  });

  it('최종 주문액이 최소주문(5000) 미만이면 거부', () => {
    const r = evaluateFeasibility({ ...base, sellCoinBalance: 3 }); // 3*1000=3000 < 5000
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('min order');
  });

  it('일일 notional 한도 잔여만큼 cap', () => {
    const r = evaluateFeasibility({ ...base, dailyMaxKrw: 30000, todayNotionalKrw: 22000 });
    // 잔여 8000 / 1000 = 8
    expect(r.qty).toBe(8);
  });

  it('일일 건수 한도 도달 시 거부', () => {
    const r = evaluateFeasibility({ ...base, dailyMaxCount: 3, todayCount: 3 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('daily count');
  });
});
