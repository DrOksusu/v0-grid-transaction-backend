// 순차익 계산 (spec §Task5): 최소주문 규모 VWAP 스프레드 − 거래수수료 − 출금수수료 = netSpreadPct
// 순수함수 — 외부 I/O 없음
import { vwapForNotional } from './multi-arb-depth.service';
import { BookLevel, NetResult } from './multi-arb-types';

export interface WithdrawFeeInput {
  rate?: number;      // 정률 (예: 0.01 = 1%)
  feeCoin?: number;   // 정액 (코인 단위)
}

export interface ComputeNetInput {
  buyLevels: BookLevel[];   // 매수측 ask 오름차순
  sellLevels: BookLevel[];  // 매도측 bid 내림차순
  minNotional: number;      // 최소주문 규모 (통화권 단위)
  buyFeeBps: number;        // 매수측 taker 수수료 (bps)
  sellFeeBps: number;       // 매도측 taker 수수료 (bps)
  withdrawFee: WithdrawFeeInput | null; // null = 미확인
  // 출금료 미확인 시 적용할 보수적 폴백 출금료율(%). 미전달(undefined) 시 기존 동작(0)과 동일 — 하위 호환.
  // (H1) 미확인이라고 0으로 통과시키지 않기 위해, 순차익을 불리하게(빼는 방향) 계산하는 용도로만 사용.
  unknownWithdrawFallbackPct?: number;
}

export function computeNet(input: ComputeNetInput): NetResult {
  const { buyLevels, sellLevels, minNotional, buyFeeBps, sellFeeBps, withdrawFee, unknownWithdrawFallbackPct } = input;

  // 1. 매수측을 최소주문 규모(minNotional)만큼 VWAP로 채운다
  const buyResult = vwapForNotional(buyLevels, minNotional);

  // 2. 매수 체결 수량과 동일한 수량을 매도측 bid로 채워 VWAP를 구한다 (수량 매칭 — notional 매칭 아님)
  const matchedQty = buyResult.vwap > 0 ? buyResult.filledNotional / buyResult.vwap : 0;
  const sellResult = vwapForQuantity(sellLevels, matchedQty);

  const depthOk = buyResult.ok && sellResult.ok;
  const buyVwap = buyResult.vwap;
  const sellVwap = sellResult.vwap;

  const grossSpreadPct = buyVwap > 0 ? ((sellVwap - buyVwap) / buyVwap) * 100 : 0;
  const tradingFeePct = (buyFeeBps + sellFeeBps) / 100;

  let withdrawFeePct = 0;
  let withdrawFeeKnown = false;
  if (withdrawFee) {
    if (typeof withdrawFee.rate === 'number') {
      withdrawFeePct = withdrawFee.rate * 100;
      withdrawFeeKnown = true;
    } else if (typeof withdrawFee.feeCoin === 'number' && buyResult.filledNotional > 0) {
      withdrawFeePct = (withdrawFee.feeCoin * buyVwap / buyResult.filledNotional) * 100;
      withdrawFeeKnown = true;
    }
  }
  // (H1) 출금료 미확인 시 0으로 통과시키지 않고 보수적 폴백률을 적용 — withdrawFeeKnown은 false 유지(메시지 구분용)
  if (!withdrawFeeKnown && typeof unknownWithdrawFallbackPct === 'number') {
    withdrawFeePct = unknownWithdrawFallbackPct;
  }

  const netSpreadPct = grossSpreadPct - tradingFeePct - withdrawFeePct;

  return {
    filledNotional: Math.min(buyResult.filledNotional, sellResult.filledNotional),
    depthOk,
    buyVwap,
    sellVwap,
    grossSpreadPct,
    tradingFeePct,
    withdrawFeePct,
    withdrawFeeKnown,
    netSpreadPct,
  };
}

// 호가 레벨을 목표 "수량"만큼 순서대로 누적 소비하여 VWAP·충족여부를 계산 (vwapForNotional의 수량판)
function vwapForQuantity(levels: BookLevel[], targetQty: number): { vwap: number; filledNotional: number; ok: boolean } {
  if (levels.length === 0 || targetQty <= 0) return { vwap: 0, filledNotional: 0, ok: false };

  let filledQty = 0;
  let filledNotional = 0;

  for (const level of levels) {
    if (filledQty >= targetQty) break;
    const remainingQty = targetQty - filledQty;
    const takeQty = Math.min(level.qty, remainingQty);
    filledQty += takeQty;
    filledNotional += takeQty * level.price;
  }

  const ok = filledQty >= targetQty * 0.999;
  const vwap = filledQty > 0 ? filledNotional / filledQty : 0;
  return { vwap, filledNotional, ok };
}
