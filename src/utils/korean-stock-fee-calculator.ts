// 한국주식 거래세/수수료 시뮬레이터
// 그리드 한 칸(매수 → 매도 1 cycle)의 실수익을 미리 계산하여
// 사용자에게 spread 설정 시 손실 위험을 경고한다.

export const DEFAULT_FEE_RATE = 0.00015; // 토스증권 0.015%
export const DEFAULT_TAX_RATE = 0.0018;  // 매도 거래세 0.18% (코스피/코스닥 동일, 2026)

export interface SimulateInput {
  buyPrice: number;
  sellPrice: number;
  orderAmount: number; // 1회 매수 금액 (KRW)
  feeRate?: number;
  taxRate?: number;
}

export interface SimulateResult {
  grossProfit: number;      // 수수료/세금 제외 차익
  totalFees: number;        // 양쪽 수수료 합
  totalTax: number;         // 매도 거래세
  netProfit: number;        // 실수익 (수수료/세금 차감 후)
  netProfitPct: number;     // 실수익률 (%)
  warningLevel: 'ok' | 'thin' | 'loss';
}

/**
 * 그리드 한 칸 거래 시뮬레이션 (매수 → 매도 1 cycle)
 * - 일반 사용자에게 거래세/수수료 차감 후 실수익 미리 보여줌
 * - warningLevel: 'loss' (손실) / 'thin' (수익률 < 0.5%) / 'ok' (수익률 >= 0.5%)
 */
export function simulateGridProfit(input: SimulateInput): SimulateResult {
  const feeRate = input.feeRate ?? DEFAULT_FEE_RATE;
  const taxRate = input.taxRate ?? DEFAULT_TAX_RATE;

  const quantity = input.orderAmount / input.buyPrice;
  const buyTotal = quantity * input.buyPrice;
  const sellTotal = quantity * input.sellPrice;

  const buyFee = buyTotal * feeRate;
  const sellFee = sellTotal * feeRate;
  const sellTax = sellTotal * taxRate;

  const grossProfit = sellTotal - buyTotal;
  const totalFees = buyFee + sellFee;
  const totalTax = sellTax;
  const netProfit = grossProfit - totalFees - totalTax;
  const netProfitPct = (netProfit / buyTotal) * 100;

  let warningLevel: 'ok' | 'thin' | 'loss';
  if (netProfit < 0) warningLevel = 'loss';
  else if (netProfitPct < 0.5) warningLevel = 'thin';
  else warningLevel = 'ok';

  return { grossProfit, totalFees, totalTax, netProfit, netProfitPct, warningLevel };
}
