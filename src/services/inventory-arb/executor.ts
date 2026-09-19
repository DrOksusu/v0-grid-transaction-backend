// 재고형 아비 실행 엔진: 양쪽 동시 IOC + 부분체결 flatten
// - flatten 실패 = 터미널(flatten_failed) → 호출자가 killSwitch + 긴급 알림
// - 재시도 루프 없음
import type { ExchangeLeg } from '../exchange-leg';
import type { ExecutorResult } from './types';

const MIN_ORDER_KRW = 5000;
/** 완전체결 판정 tolerance band (fee-in-coin 흡수). buyQty/sellQty 차이가 이 비율 이내면 매칭 간주 */
const IMBALANCE_BAND = 0.01; // 1%

export interface ExecuteArbInput {
  buyLeg: ExchangeLeg; // 매수 거래소
  sellLeg: ExchangeLeg; // 매도 거래소
  symbol: string; // base 심볼 (예: 'XRP')
  qty: number; // 목표 수량
  buyPrice: number; // 매수 거래소 ask (priceHint)
  sellPrice: number; // 매도 거래소 bid (priceHint)
  fallbackMode: 'market_flatten' | 'hold';
  buyExchangeCoinBalance: number; // flatten 매도 가능 여부 확인용 (매수 거래소 코인 잔고, 방금 매수분 포함 안 될 수 있음 → 캐시값)
  sellExchangeKrwBalance: number; // flatten 매수 가능 여부 확인용 (매도 거래소 KRW)
}

function fillQty(r: { filledQty: number } | null): number {
  return r?.filledQty ?? 0;
}

export async function executeArb(input: ExecuteArbInput): Promise<ExecutorResult> {
  const { buyLeg, sellLeg, symbol, qty, buyPrice, sellPrice, fallbackMode } = input;

  // 1. 양쪽 동시 발주 (record-before-fire는 호출자가 처리)
  const [sellSettled, buySettled] = await Promise.allSettled([
    sellLeg.sellIoc(symbol, qty, sellPrice),
    buyLeg.buyIoc(symbol, qty, buyPrice, undefined),
  ]);

  const sellRes = sellSettled.status === 'fulfilled' ? sellSettled.value : null;
  const buyRes = buySettled.status === 'fulfilled' ? buySettled.value : null;

  const sellQty = fillQty(sellRes);
  const buyQty = fillQty(buyRes);

  // 2. 양쪽 미체결
  if (sellQty === 0 && buyQty === 0) {
    return { kind: 'failed', reason: 'both legs unfilled' };
  }

  const buyGrossKrw = buyRes?.grossKrw ?? 0;
  const sellGrossKrw = sellRes?.grossKrw ?? 0;
  const legFeeKrw = (buyRes?.feeKrw ?? 0) + (sellRes?.feeKrw ?? 0);

  // 3. 개수 불균형 (netImbalance > 0 = 매수과다 net long, < 0 = 매도과다 net short)
  const netImbalance = buyQty - sellQty;
  const absImbalance = Math.abs(netImbalance);
  const matchedQty = Math.min(buyQty, sellQty);

  // 4. tolerance band 내 → 완전 체결로 간주
  const withinBand = matchedQty > 0 && absImbalance <= qty * IMBALANCE_BAND;
  if (withinBand) {
    const netKrw = sellGrossKrw - buyGrossKrw - legFeeKrw;
    return {
      kind: 'filled',
      buyQty, sellQty, buyGrossKrw, sellGrossKrw, feeKrw: legFeeKrw,
      netKrw: +netKrw.toFixed(6),
      note: absImbalance > 0 ? `matched within band (imbalance=${absImbalance})` : 'exact match',
    };
  }

  // 5. dust 판정: 상쇄분이 최소주문 미만이면 flatten 불가 → 수용 + 로그
  const referencePrice = netImbalance > 0 ? buyPrice : sellPrice;
  if (absImbalance * referencePrice < MIN_ORDER_KRW) {
    const netKrw = sellGrossKrw - buyGrossKrw - legFeeKrw;
    return {
      kind: 'filled',
      buyQty, sellQty, buyGrossKrw, sellGrossKrw, feeKrw: legFeeKrw,
      netKrw: +netKrw.toFixed(6),
      note: `dust imbalance ${absImbalance} accepted (< ${MIN_ORDER_KRW} KRW)`,
    };
  }

  // 6. hold 모드 → 재고로 보류
  if (fallbackMode === 'hold') {
    return { kind: 'partial_hold', imbalanceQty: netImbalance, note: `hold imbalance=${netImbalance}` };
  }

  // 7. market_flatten
  const roundedImbalance = Math.floor(absImbalance * 1e8) / 1e8;
  if (netImbalance > 0) {
    // net long: 매수 거래소에 초과 코인 → 매수 거래소에서 시장가 매도
    if (input.buyExchangeCoinBalance < roundedImbalance) {
      return { kind: 'flatten_failed', imbalanceQty: netImbalance, note: `net long but buyExchange coin balance ${input.buyExchangeCoinBalance} < ${roundedImbalance}` };
    }
    const flat = await buyLeg.sellIoc(symbol, roundedImbalance, buyPrice);
    if (!flat || flat.filledQty < roundedImbalance * (1 - IMBALANCE_BAND)) {
      return { kind: 'flatten_failed', imbalanceQty: netImbalance, note: `flatten sell failed (filled=${flat?.filledQty ?? 0}/${roundedImbalance})` };
    }
    const feeKrw = legFeeKrw + (flat.feeKrw ?? 0);
    const netKrw = sellGrossKrw + flat.grossKrw - buyGrossKrw - feeKrw;
    return {
      kind: 'partial_flattened',
      buyQty, sellQty, flattenSide: 'sell', flattenQty: roundedImbalance,
      buyGrossKrw, sellGrossKrw, feeKrw, netKrw: +netKrw.toFixed(6),
      note: `flattened net long ${roundedImbalance} via sell on buyExchange`,
    };
  } else {
    // net short: 매도 거래소에서 과다 매도 → 매도 거래소에서 시장가 매수로 복원
    const requiredKrw = roundedImbalance * sellPrice;
    if (input.sellExchangeKrwBalance < requiredKrw) {
      return { kind: 'flatten_failed', imbalanceQty: netImbalance, note: `net short but sellExchange KRW ${input.sellExchangeKrwBalance} < ${requiredKrw}` };
    }
    const flat = await sellLeg.buyIoc(symbol, roundedImbalance, sellPrice, undefined);
    if (!flat || flat.filledQty < roundedImbalance * (1 - IMBALANCE_BAND)) {
      return { kind: 'flatten_failed', imbalanceQty: netImbalance, note: `flatten buy failed (filled=${flat?.filledQty ?? 0}/${roundedImbalance})` };
    }
    const feeKrw = legFeeKrw + (flat.feeKrw ?? 0);
    // 되산 것은 비용 → sell 수익에서 차감
    const netKrw = sellGrossKrw - buyGrossKrw - flat.grossKrw - feeKrw;
    return {
      kind: 'partial_flattened',
      buyQty, sellQty, flattenSide: 'buy', flattenQty: roundedImbalance,
      buyGrossKrw, sellGrossKrw, feeKrw, netKrw: +netKrw.toFixed(6),
      note: `flattened net short ${roundedImbalance} via buy on sellExchange`,
    };
  }
}
