import { computeNet } from '../../src/services/multi-arb-net-calculator';
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
