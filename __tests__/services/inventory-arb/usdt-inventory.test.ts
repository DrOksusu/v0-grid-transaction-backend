import { shouldExecute, GATE_FEE_BPS, MEXC_FEE_BPS } from '../../../src/services/inventory-arb/usdt-inventory.service';
import type { BookLevel } from '../../../src/services/multi-arb-types';

const bot = {
  symbol: 'ALEO',
  thresholdPct: 2,
  orderUsdt: 10,
  killSwitch: false,
};

// 깊이 충분 + 순차익 넉넉(≈4%): threshold(2) + 수수료(0.3%)를 여유 있게 상회
const DEEP_GATE_ASK: BookLevel[] = [
  { price: 0.017, qty: 1000 },
  { price: 0.0171, qty: 1000 },
];
const DEEP_MEXC_BID: BookLevel[] = [
  { price: 0.0177, qty: 1000 }, // (0.0177-0.017)/0.017 ≈ 4.1% gross
  { price: 0.0176, qty: 1000 },
];

function baseInput(overrides: Partial<Parameters<typeof shouldExecute>[0]> = {}) {
  return {
    gateAsk: 0.017,
    gateBid: 0.0169,
    mexcAsk: 0.0178,
    mexcBid: 0.0177,
    gateAskLevels: DEEP_GATE_ASK,
    mexcBidLevels: DEEP_MEXC_BID,
    mexcAleoBalance: 100000, // 충분
    gateUsdtBalance: 1000, // 충분
    bot,
    ...overrides,
  };
}

describe('shouldExecute (순수 판정 함수)', () => {
  it('정상: 갭 크고 재고 충분 → go:true, qty/prices 정확', () => {
    const r = shouldExecute(baseInput());
    expect(r.go).toBe(true);
    expect(r.stop).toBeUndefined();
    // qty = floor(orderUsdt / gateAsk) = floor(10 / 0.017) = floor(588.23...) = 588
    expect(r.qty).toBe(Math.floor(10 / 0.017));
    expect(r.buyPrice).toBe(0.017);
    expect(r.sellPrice).toBe(0.0177);
  });

  it('방향 역전(mexcBid <= gateAsk) → go:false, wrong_direction', () => {
    const r = shouldExecute(
      baseInput({
        gateAsk: 0.018,
        mexcBid: 0.0177, // MEXC가 더 쌈 — 재고 배치상 실행 불가 방향
      }),
    );
    expect(r.go).toBe(false);
    expect(r.reason).toBe('no_gap_or_wrong_direction');
  });

  it('방향 동일가(mexcBid === gateAsk) → go:false (경계는 실행 불가)', () => {
    const r = shouldExecute(baseInput({ gateAsk: 0.0177, mexcBid: 0.0177 }));
    expect(r.go).toBe(false);
    expect(r.reason).toBe('no_gap_or_wrong_direction');
  });

  it('순차익 미달(임계 상향) → go:false, net_spread_below_threshold', () => {
    // gross ≈ 4.1%인데 threshold를 10%로 올리면 미달
    const r = shouldExecute(baseInput({ bot: { ...bot, thresholdPct: 10 } }));
    expect(r.go).toBe(false);
    expect(r.reason).toBe('net_spread_below_threshold');
  });

  it('갭이 수수료(0.3%)만 겨우 넘고 임계(2%) 미달인 좁은 스프레드 → go:false', () => {
    // gross ≈ 0.5%: (0.01709-0.017)/0.017 ≈ 0.53% < threshold 2%
    const r = shouldExecute(
      baseInput({
        gateAsk: 0.017,
        gateAskLevels: [{ price: 0.017, qty: 1000 }],
        mexcBid: 0.01709,
        mexcBidLevels: [{ price: 0.01709, qty: 1000 }],
      }),
    );
    expect(r.go).toBe(false);
    expect(r.reason).toBe('net_spread_below_threshold');
  });

  it('깊이 부족(주문 규모를 못 채움) → go:false, depth_insufficient', () => {
    const r = shouldExecute(
      baseInput({
        gateAskLevels: [{ price: 0.017, qty: 0.001 }], // orderUsdt=10 못 채움
        mexcBidLevels: [{ price: 0.0177, qty: 0.001 }],
      }),
    );
    expect(r.go).toBe(false);
    expect(r.reason).toBe('depth_insufficient');
  });

  it('재고 소진(MEXC ALEO < qty) → go:false, stop:true, mexc_aleo_drained', () => {
    const r = shouldExecute(baseInput({ mexcAleoBalance: 10 })); // qty=588 > 10
    expect(r.go).toBe(false);
    expect(r.stop).toBe(true);
    expect(r.reason).toBe('mexc_aleo_drained');
  });

  it('Gate USDT 부족(< orderUsdt) → go:false, stop:true, gate_usdt_low', () => {
    const r = shouldExecute(baseInput({ gateUsdtBalance: 1 })); // < orderUsdt(10)
    expect(r.go).toBe(false);
    expect(r.stop).toBe(true);
    expect(r.reason).toBe('gate_usdt_low');
  });

  it('killSwitch=true → go:false, stop 없음(자동정지 오알림 방지)', () => {
    const r = shouldExecute(baseInput({ bot: { ...bot, killSwitch: true } }));
    expect(r.go).toBe(false);
    expect(r.reason).toBe('kill_switch');
    expect(r.stop).toBeUndefined();
  });

  it('qty가 최소 base 단위(1) 미만이면 go:false', () => {
    // orderUsdt=10, gateAsk=20 → floor(10/20)=0 < 1. mexcBid도 방향 게이트를 통과하도록 비례 상향.
    const r = shouldExecute(
      baseInput({
        gateAsk: 20,
        gateAskLevels: [{ price: 20, qty: 1000 }],
        mexcBid: 21,
        mexcBidLevels: [{ price: 21, qty: 1000 }],
      }),
    );
    expect(r.go).toBe(false);
    expect(r.reason).toBe('qty_below_min_base_unit');
  });

  it('수수료 상수 확인 (Gate taker 0.2% / MEXC taker 0.1%)', () => {
    expect(GATE_FEE_BPS).toBe(20);
    expect(MEXC_FEE_BPS).toBe(10);
  });
});
