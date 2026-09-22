import { computeNet, computeMaxExecutable } from '../../src/services/multi-arb-net-calculator';
import { BookLevel } from '../../src/services/multi-arb-types';

describe('computeNet', () => {
  it('출금 정률 케이스: gross 2% - 거래수수료 - 출금 정률 1% ≈ net 0.9%', () => {
    // buy ask 1000 전량 레벨(깊이 충분), sell bid 1020 전량 레벨(깊이 충분) → gross = (1020-1000)/1000*100 = 2%
    const buyLevels: BookLevel[] = [{ price: 1000, qty: 1000 }];
    const sellLevels: BookLevel[] = [{ price: 1020, qty: 1000 }];
    const r = computeNet({
      buyLevels,
      sellLevels,
      minNotional: 100000,
      buyFeeBps: 5,
      sellFeeBps: 5,
      withdrawFee: { rate: 0.01 }, // 정률 1%
    });
    expect(r.depthOk).toBe(true);
    expect(r.buyVwap).toBe(1000);
    expect(r.sellVwap).toBe(1020);
    expect(r.grossSpreadPct).toBeCloseTo(2, 6);
    expect(r.tradingFeePct).toBeCloseTo(0.1, 6); // (5+5)bps/100 = 0.1%
    expect(r.withdrawFeeKnown).toBe(true);
    expect(r.withdrawFeePct).toBeCloseTo(1, 6);
    expect(r.netSpreadPct).toBeCloseTo(2 - 0.1 - 1, 6); // 0.9%
  });

  it('출금 정액(feeCoin) 케이스: 코인 정액을 규모로 나눠 %환산', () => {
    const buyLevels: BookLevel[] = [{ price: 1000, qty: 1000 }];
    const sellLevels: BookLevel[] = [{ price: 1020, qty: 1000 }];
    const r = computeNet({
      buyLevels,
      sellLevels,
      minNotional: 100000,
      buyFeeBps: 5,
      sellFeeBps: 5,
      withdrawFee: { feeCoin: 1 }, // 코인 1개 정액
    });
    // filledNotional=100000, buyVwap=1000 → withdrawFeePct = feeCoin*buyVwap/filledNotional*100 = 1*1000/100000*100 = 1%
    expect(r.withdrawFeeKnown).toBe(true);
    expect(r.withdrawFeePct).toBeCloseTo(1, 6);
    expect(r.netSpreadPct).toBeCloseTo(r.grossSpreadPct - r.tradingFeePct - 1, 6);
  });

  it('출금료 미확인(null): withdrawFeeKnown=false, withdrawFeePct=0', () => {
    const buyLevels: BookLevel[] = [{ price: 1000, qty: 1000 }];
    const sellLevels: BookLevel[] = [{ price: 1020, qty: 1000 }];
    const r = computeNet({
      buyLevels,
      sellLevels,
      minNotional: 100000,
      buyFeeBps: 5,
      sellFeeBps: 5,
      withdrawFee: null,
    });
    expect(r.withdrawFeeKnown).toBe(false);
    expect(r.withdrawFeePct).toBe(0);
    expect(r.netSpreadPct).toBeCloseTo(r.grossSpreadPct - r.tradingFeePct, 6);
  });

  // (H1 리뷰 반영) 출금료 미확인 시 0으로 통과시키지 않고 보수적 폴백률을 적용해 순차익을 불리하게 계산한다.
  it('출금료 미확인 + 폴백률 지정: withdrawFeeKnown=false 유지하되 withdrawFeePct=폴백값 반영, netSpreadPct는 그만큼 낮아진다', () => {
    const buyLevels: BookLevel[] = [{ price: 1000, qty: 1000 }];
    const sellLevels: BookLevel[] = [{ price: 1020, qty: 1000 }];
    const withoutFallback = computeNet({
      buyLevels, sellLevels, minNotional: 100000, buyFeeBps: 5, sellFeeBps: 5, withdrawFee: null,
    });
    const withFallback = computeNet({
      buyLevels, sellLevels, minNotional: 100000, buyFeeBps: 5, sellFeeBps: 5,
      withdrawFee: null, unknownWithdrawFallbackPct: 1,
    });
    expect(withFallback.withdrawFeeKnown).toBe(false); // 메시지 구분용 플래그는 그대로 미확인
    expect(withFallback.withdrawFeePct).toBeCloseTo(1, 6);
    expect(withFallback.netSpreadPct).toBeCloseTo(withoutFallback.netSpreadPct - 1, 6);
  });

  it('깊이 부족: 매수측이 최소주문을 못 채우면 depthOk=false', () => {
    const buyLevels: BookLevel[] = [{ price: 1000, qty: 10 }]; // 10,000원어치뿐 (목표 100,000)
    const sellLevels: BookLevel[] = [{ price: 1020, qty: 1000 }];
    const r = computeNet({
      buyLevels,
      sellLevels,
      minNotional: 100000,
      buyFeeBps: 5,
      sellFeeBps: 5,
      withdrawFee: null,
    });
    expect(r.depthOk).toBe(false);
  });

  it('깊이 부족: 매도측이 매수 체결 수량만큼을 못 채우면 depthOk=false', () => {
    const buyLevels: BookLevel[] = [{ price: 1000, qty: 1000 }]; // 매수 100개 필요(100,000/1000)
    const sellLevels: BookLevel[] = [{ price: 1020, qty: 5 }]; // 매도측은 5개뿐
    const r = computeNet({
      buyLevels,
      sellLevels,
      minNotional: 100000,
      buyFeeBps: 5,
      sellFeeBps: 5,
      withdrawFee: null,
    });
    expect(r.depthOk).toBe(false);
  });

  it('levels가 비면 depthOk=false, vwap 0', () => {
    const r = computeNet({
      buyLevels: [],
      sellLevels: [],
      minNotional: 100000,
      buyFeeBps: 5,
      sellFeeBps: 5,
      withdrawFee: null,
    });
    expect(r.depthOk).toBe(false);
    expect(r.buyVwap).toBe(0);
    expect(r.sellVwap).toBe(0);
  });
});

describe('computeMaxExecutable', () => {
  // 반환 notional 두 개로 순차익 재계산 (같은 수량이므로 sellVwap/buyVwap = sellN/buyN)
  const netFromNotionals = (buyN: number, sellN: number, tradingPct: number, wdPct: number) =>
    (sellN / buyN - 1) * 100 - tradingPct - wdPct;

  it('(a) 단일 레벨에서 net이 임계 위 → 그 레벨 전량 규모, depthLimited=true', () => {
    const buyLevels: BookLevel[] = [{ price: 1000, qty: 100 }];
    const sellLevels: BookLevel[] = [{ price: 1020, qty: 100 }];
    // gross 2% − 거래 0.2 − 출금 0.5 = net 1.3% ≥ 임계 1%
    const r = computeMaxExecutable(buyLevels, sellLevels, 0.2, 0.5, 1);
    expect(r.maxExecDepthLimited).toBe(true);
    expect(r.maxExecBuyNotional).toBeCloseTo(100 * 1000, 6);
    expect(r.maxExecSellNotional).toBeCloseTo(100 * 1020, 6);
  });

  it('(b) 다단계에서 깊어질수록 net 하락 → 이분탐색 종료(depthLimited=false), 반환 지점 net ≈ 임계', () => {
    const buyLevels: BookLevel[] = [{ price: 1000, qty: 50 }, { price: 1012, qty: 1000 }];
    const sellLevels: BookLevel[] = [{ price: 1020, qty: 50 }, { price: 1004, qty: 1000 }];
    const r = computeMaxExecutable(buyLevels, sellLevels, 0.2, 0.5, 1);
    expect(r.maxExecDepthLimited).toBe(false);
    // 1레벨(50개)만으론 net 1.3%라 임계 위 → 더 깊이 들어가 임계에 닿는 지점에서 멈춤
    expect(r.maxExecBuyNotional).toBeGreaterThan(50 * 1000);
    // 반환 지점의 순차익은 임계값(1%)에 수렴
    expect(netFromNotionals(r.maxExecBuyNotional, r.maxExecSellNotional, 0.2, 0.5)).toBeCloseTo(1, 2);
  });

  it('(c) 처음부터 net이 임계 미달 → 0/false', () => {
    const buyLevels: BookLevel[] = [{ price: 1000, qty: 100 }];
    const sellLevels: BookLevel[] = [{ price: 1005, qty: 100 }]; // gross 0.5% − 수수료 → 음수
    const r = computeMaxExecutable(buyLevels, sellLevels, 0.2, 0.5, 1);
    expect(r).toEqual({ maxExecBuyNotional: 0, maxExecSellNotional: 0, maxExecDepthLimited: false });
  });

  it('(d) 수량 매칭: 매수 체결수량 == 매도 체결수량', () => {
    const buyLevels: BookLevel[] = [{ price: 1000, qty: 100 }];
    const sellLevels: BookLevel[] = [{ price: 1020, qty: 100 }];
    const r = computeMaxExecutable(buyLevels, sellLevels, 0.2, 0.5, 1);
    const buyQty = r.maxExecBuyNotional / 1000;
    const sellQty = r.maxExecSellNotional / 1020;
    expect(buyQty).toBeCloseTo(sellQty, 6);
  });

  it('빈 호가 → 0/false', () => {
    expect(computeMaxExecutable([], [], 0.2, 0.5, 1)).toEqual({
      maxExecBuyNotional: 0, maxExecSellNotional: 0, maxExecDepthLimited: false,
    });
  });
});
