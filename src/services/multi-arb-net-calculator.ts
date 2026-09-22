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
  // 발송 임계값(순차익 %). 전달 시 이 임계 이상 유지되는 최대 체결 규모를 계산. 미전달 시 max* 필드는 0/false.
  thresholdPct?: number;
}

export function computeNet(input: ComputeNetInput): NetResult {
  const { buyLevels, sellLevels, minNotional, buyFeeBps, sellFeeBps, withdrawFee, unknownWithdrawFallbackPct, thresholdPct } = input;

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

  // 순차익이 임계값 이상 유지되는 최대 체결 규모 (thresholdPct 전달 시). withdrawFeePct는 이미 확정된 상수 %를 사용.
  const maxExec = typeof thresholdPct === 'number'
    ? computeMaxExecutable(buyLevels, sellLevels, tradingFeePct, withdrawFeePct, thresholdPct)
    : { maxExecBuyNotional: 0, maxExecSellNotional: 0, maxExecDepthLimited: false };

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
    ...maxExec,
  };
}

/**
 * 순차익(gross − 거래수수료 − 출금료)이 thresholdPct 이상 유지되는 최대 체결 규모를 계산.
 * 매수(ask 오름차)·매도(bid 내림차) 호가를 수량 매칭으로 동시에 걸으며 누적 VWAP로 net을 산출한다.
 * withdrawFeePct·tradingFeePct는 상수 %이고 규모가 커질수록 누적 매수VWAP↑·매도VWAP↓ → net은 단조 감소.
 * 그 성질을 이용해 한 스텝(단일 레벨쌍, 가격 고정) 안에서 net==threshold 지점을 이분탐색으로 찾는다.
 */
export function computeMaxExecutable(
  buyLevels: BookLevel[],
  sellLevels: BookLevel[],
  tradingFeePct: number,
  withdrawFeePct: number,
  thresholdPct: number,
): { maxExecBuyNotional: number; maxExecSellNotional: number; maxExecDepthLimited: boolean } {
  const none = { maxExecBuyNotional: 0, maxExecSellNotional: 0, maxExecDepthLimited: false };
  if (buyLevels.length === 0 || sellLevels.length === 0) return none;

  // 매칭 수량 q에서의 순차익 %(누적 VWAP 기준)
  const netAt = (buyN: number, sellN: number, qty: number): number => {
    if (qty <= 0 || buyN <= 0) return 0;
    const bV = buyN / qty, sV = sellN / qty;
    return (sV - bV) / bV * 100 - tradingFeePct - withdrawFeePct;
  };

  let i = 0, j = 0;
  let buyRemain = buyLevels[0].qty, sellRemain = sellLevels[0].qty;
  let cumQty = 0, cumBuyN = 0, cumSellN = 0;
  let best = none;

  while (i < buyLevels.length && j < sellLevels.length) {
    const step = Math.min(buyRemain, sellRemain);
    if (step <= 0) break;
    const bPrice = buyLevels[i].price, sPrice = sellLevels[j].price;
    const nQty = cumQty + step;
    const nBuyN = cumBuyN + step * bPrice;
    const nSellN = cumSellN + step * sPrice;

    if (netAt(nBuyN, nSellN, nQty) >= thresholdPct) {
      // 스텝 전체가 임계 이상 → 채택 후 전진
      cumQty = nQty; cumBuyN = nBuyN; cumSellN = nSellN;
      best = { maxExecBuyNotional: cumBuyN, maxExecSellNotional: cumSellN, maxExecDepthLimited: true };
      buyRemain -= step; sellRemain -= step;
      if (buyRemain <= 0) { i++; buyRemain = buyLevels[i]?.qty ?? 0; }
      if (sellRemain <= 0) { j++; sellRemain = sellLevels[j]?.qty ?? 0; }
    } else {
      // 스텝 중간에 임계 미달 → 단일 레벨쌍(가격 고정) 안에서 이분탐색
      let lo = 0, hi = step;
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        const q = cumQty + mid;
        if (netAt(cumBuyN + mid * bPrice, cumSellN + mid * sPrice, q) >= thresholdPct) lo = mid;
        else hi = mid;
      }
      if (lo > 0) {
        best = {
          maxExecBuyNotional: cumBuyN + lo * bPrice,
          maxExecSellNotional: cumSellN + lo * sPrice,
          maxExecDepthLimited: false,
        };
      } else {
        // 이 스텝 시작점에서 이미 미달 — 지금까지 누적분이 최대 (없으면 0)
        best = cumQty > 0
          ? { maxExecBuyNotional: cumBuyN, maxExecSellNotional: cumSellN, maxExecDepthLimited: false }
          : none;
      }
      return best;
    }
  }
  // 한쪽 호가 소진까지 임계 유지 → depthLimited (best는 마지막 채택분)
  return best;
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
