import { simulateGridProfit, DEFAULT_FEE_RATE, DEFAULT_TAX_RATE } from '../../src/utils/korean-stock-fee-calculator';

describe('simulateGridProfit', () => {
  it('흑자 케이스 (그리드 간격 1.43%, 10만원 거래)', () => {
    const result = simulateGridProfit({
      buyPrice: 70000,
      sellPrice: 71000,
      orderAmount: 100000,
    });
    // 수량 = 100000 / 70000 = 1.4286
    // 매수 = 100000 (수수료 15원)
    // 매도 = 1.4286 * 71000 ≈ 101428.57 (수수료 ~15원 + 거래세 ~182.57원)
    // gross = 1428.57, fees ≈ 30, tax ≈ 182.57, net ≈ 1216
    expect(result.grossProfit).toBeCloseTo(1428.57, 0);
    expect(result.totalFees).toBeCloseTo(30, 0);
    expect(result.totalTax).toBeCloseTo(183, 0);
    expect(result.netProfit).toBeCloseTo(1216, 0);
    expect(result.netProfitPct).toBeCloseTo(1.22, 1);
    expect(result.warningLevel).toBe('ok');
  });

  it('손실 케이스 (그리드 간격 0.1% — 세금보다 작음)', () => {
    const result = simulateGridProfit({
      buyPrice: 70000,
      sellPrice: 70070,
      orderAmount: 100000,
    });
    expect(result.netProfit).toBeLessThan(0);
    expect(result.warningLevel).toBe('loss');
  });

  it('얇은 수익 케이스 (그리드 간격 0.3%)', () => {
    const result = simulateGridProfit({
      buyPrice: 70000,
      sellPrice: 70210,
      orderAmount: 100000,
    });
    expect(result.netProfit).toBeGreaterThan(0);
    expect(result.warningLevel).toBe('thin');
  });

  it('feeRate/taxRate override 가능', () => {
    const result = simulateGridProfit({
      buyPrice: 100000,
      sellPrice: 101000,
      orderAmount: 100000,
      feeRate: 0,
      taxRate: 0,
    });
    expect(result.totalFees).toBe(0);
    expect(result.totalTax).toBe(0);
    expect(result.netProfit).toBeCloseTo(1000, 0); // 그대로 차익
    expect(result.warningLevel).toBe('ok');
  });
});

describe('DEFAULT constants', () => {
  it('DEFAULT_FEE_RATE = 0.00015 (토스 0.015%)', () => {
    expect(DEFAULT_FEE_RATE).toBe(0.00015);
  });
  it('DEFAULT_TAX_RATE = 0.0018 (매도 0.18%)', () => {
    expect(DEFAULT_TAX_RATE).toBe(0.0018);
  });
});
