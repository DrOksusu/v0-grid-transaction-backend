// 재고형 아비 실행 엔진: 양쪽 동시 IOC + 부분체결 flatten
// - flatten 실패 = 터미널(flatten_failed) → 호출자가 killSwitch + 긴급 알림
// - 재시도 루프 없음
// - flatten 가능 여부는 사전 잔고가 아니라 실제 flatten 주문 결과로 판정
//   (매수/매도 직후라 상쇄 대상 물량/현금은 정의상 확보됨; imbalance ≤ 방금 체결량. 거래소가 거부하면 null → 터미널)
import type { ExchangeLeg } from '../exchange-leg';
import type { ExecutorResult } from './types';

const MIN_ORDER_KRW = 5000; // 업비트·빗썸 공통 최소 주문금액. 이 미만 imbalance는 상쇄(flatten) 불가 → dust 수용
const FLATTEN_UNDERFILL_TOL = 0.01; // flatten 주문이 목표의 99% 이상 체결되면 성공 간주

export interface ExecuteArbInput {
  buyLeg: ExchangeLeg; // 매수 거래소
  sellLeg: ExchangeLeg; // 매도 거래소
  symbol: string; // base 심볼 (예: 'XRP')
  qty: number; // 목표 수량
  buyPrice: number; // 매수 거래소 ask (priceHint)
  sellPrice: number; // 매도 거래소 bid (priceHint)
  fallbackMode: 'market_flatten' | 'hold';
  // net-short flatten(매도 거래소에서 되사기) 예산 기준가 = 매도 거래소 최우선 ask.
  // 미지정 시 sellPrice 폴백. depth 소비로 sellPrice가 최악 bid로 낮아져도 flatten 예산이 줄지 않도록 top-of-book 사용.
  flattenBuyRefPrice?: number;
  // 상쇄 불가한 dust로 수용할 imbalance notional 상한(quote 통화). 미지정 시 KRW 기본(5000).
  // USDT권(Gate/MEXC)은 거래소 최소주문(예 3 USDT) 전달. imbalance*price가 이 미만이면 flatten 없이 filled 수용.
  minOrderQuote?: number;
}

function fillQty(r: { filledQty: number } | null): number {
  return r?.filledQty ?? 0;
}

export async function executeArb(input: ExecuteArbInput): Promise<ExecutorResult> {
  const { buyLeg, sellLeg, symbol, qty, buyPrice, sellPrice, fallbackMode } = input;
  const minOrder = input.minOrderQuote ?? MIN_ORDER_KRW; // quote 통화 dust 임계 (KRW 기본 5000)

  // 1. 양쪽 동시 발주 (record-before-fire는 호출자가 처리)
  const [sellSettled, buySettled] = await Promise.allSettled([
    sellLeg.sellIoc(symbol, qty, sellPrice),
    buyLeg.buyIoc(symbol, qty, buyPrice, undefined),
  ]);

  const sellRejected = sellSettled.status === 'rejected';
  const buyRejected = buySettled.status === 'rejected';
  const sellRes = sellSettled.status === 'fulfilled' ? sellSettled.value : null;
  const buyRes = buySettled.status === 'fulfilled' ? buySettled.value : null;

  const sellQty = fillQty(sellRes);
  const buyQty = fillQty(buyRes);

  // 2. 한쪽 leg가 throw(rejected)인데 반대편이 체결됨 = 체결 상태 불명 + 방향노출 가능성.
  //    rejected를 0으로 가정하고 flatten하면 이미 체결됐을 수 있어 이중 노출 위험 → 터미널 승격(사람 확인).
  //    (REST staleness 잔여 리스크 — 사후 리컨실은 오케스트레이터/후속 과제)
  if ((sellRejected && buyQty > 0) || (buyRejected && sellQty > 0)) {
    return {
      kind: 'flatten_failed',
      imbalanceQty: buyQty - sellQty,
      note: `leg 예외(sellRejected=${sellRejected} buyRejected=${buyRejected}) + 반대편 체결 — 체결상태 불명, 수동 확인 필요`,
    };
  }

  // 3. 양쪽 미체결
  if (sellQty === 0 && buyQty === 0) {
    return { kind: 'failed', reason: `both legs unfilled (sellRejected=${sellRejected} buyRejected=${buyRejected})` };
  }

  const buyGrossKrw = buyRes?.grossKrw ?? 0;
  const sellGrossKrw = sellRes?.grossKrw ?? 0;
  const legFeeKrw = (buyRes?.feeKrw ?? 0) + (sellRes?.feeKrw ?? 0);

  // 4. 개수 불균형 (netImbalance > 0 = 매수과다 net long, < 0 = 매도과다 net short)
  const netImbalance = buyQty - sellQty;
  const absImbalance = Math.abs(netImbalance);
  const referencePrice = netImbalance > 0 ? buyPrice : sellPrice;

  // 5. 완전 일치 또는 상쇄 불가한 소액(dust: 최소주문 미만) → filled 수용.
  //    fee-in-coin으로 인한 미세 불일치도 여기서 흡수한다(절대 KRW 기준 — 비율 밴드는 대형 주문에서 과다 흡수 위험이라 미사용).
  if (absImbalance === 0 || absImbalance * referencePrice < minOrder) {
    const netKrw = sellGrossKrw - buyGrossKrw - legFeeKrw;
    return {
      kind: 'filled',
      buyQty,
      sellQty,
      buyGrossKrw,
      sellGrossKrw,
      feeKrw: legFeeKrw,
      netKrw: +netKrw.toFixed(6),
      note: absImbalance === 0
        ? 'exact match'
        : `dust imbalance ${absImbalance} accepted (< ${minOrder} quote)`,
    };
  }

  // 6. hold 모드 → 재고로 보류
  if (fallbackMode === 'hold') {
    return { kind: 'partial_hold', imbalanceQty: netImbalance, note: `hold imbalance=${netImbalance}` };
  }

  // 7. market_flatten — 상쇄 대상 물량/현금은 방금 체결로 확보됨(사전 잔고 가드 불필요; imbalance ≤ 방금 체결량).
  //    flatten 가능 여부는 실제 주문 결과(null/미달)로만 판정한다.
  const roundedImbalance = Math.floor(absImbalance * 1e8) / 1e8;
  if (netImbalance > 0) {
    // net long: 매수 거래소에 초과 코인 → 매수 거래소에서 시장가 매도로 상쇄
    // flatten 주문은 bare await 금지 — throw(네트워크/거래소 오류) 시에도 터미널로 매핑해야 함
    // (IOC 메서드는 pollOrder와 달리 예외를 삼키지 않고 던진다)
    let flat: { filledQty: number; grossKrw: number; feeKrw: number } | null;
    try {
      flat = await buyLeg.sellIoc(symbol, roundedImbalance, buyPrice);
    } catch (err: any) {
      return { kind: 'flatten_failed', imbalanceQty: netImbalance, note: `flatten sell threw: ${err?.message ?? err}` };
    }
    if (!flat || flat.filledQty < roundedImbalance * (1 - FLATTEN_UNDERFILL_TOL)) {
      return { kind: 'flatten_failed', imbalanceQty: netImbalance, note: `flatten sell failed (filled=${flat?.filledQty ?? 0}/${roundedImbalance})` };
    }
    const feeKrw = legFeeKrw + (flat.feeKrw ?? 0);
    const netKrw = sellGrossKrw + flat.grossKrw - buyGrossKrw - feeKrw;
    return {
      kind: 'partial_flattened',
      buyQty,
      sellQty,
      flattenSide: 'sell',
      flattenQty: roundedImbalance,
      buyGrossKrw,
      sellGrossKrw,
      feeKrw,
      netKrw: +netKrw.toFixed(6),
      note: `flattened net long ${roundedImbalance} via sell on buyExchange`,
    };
  } else {
    // net short: 매도 거래소에서 과다 매도 → 매도 거래소에서 시장가 매수로 복원
    // net long과 동일하게 throw도 터미널로 매핑
    // 시장가 매수는 ask를 무는데 priceHint(예산 기준)가 낮으면 예산 부족으로 미달→오탐 flatten_failed.
    // 매도 거래소 최우선 ask(top-of-book) 기준 + 5% 헤드룸 → depth 소비로 sellPrice가 낮아져도 예산 충분.
    const flattenBuyPriceHint = (input.flattenBuyRefPrice ?? sellPrice) * 1.05;
    let flat: { filledQty: number; grossKrw: number; feeKrw: number } | null;
    try {
      flat = await sellLeg.buyIoc(symbol, roundedImbalance, flattenBuyPriceHint, undefined);
    } catch (err: any) {
      return { kind: 'flatten_failed', imbalanceQty: netImbalance, note: `flatten buy threw: ${err?.message ?? err}` };
    }
    if (!flat || flat.filledQty < roundedImbalance * (1 - FLATTEN_UNDERFILL_TOL)) {
      return { kind: 'flatten_failed', imbalanceQty: netImbalance, note: `flatten buy failed (filled=${flat?.filledQty ?? 0}/${roundedImbalance})` };
    }
    const feeKrw = legFeeKrw + (flat.feeKrw ?? 0);
    // 되산 것은 비용 → sell 수익에서 차감
    const netKrw = sellGrossKrw - buyGrossKrw - flat.grossKrw - feeKrw;
    return {
      kind: 'partial_flattened',
      buyQty,
      sellQty,
      flattenSide: 'buy',
      flattenQty: roundedImbalance,
      buyGrossKrw,
      sellGrossKrw,
      feeKrw,
      netKrw: +netKrw.toFixed(6),
      note: `flattened net short ${roundedImbalance} via buy on sellExchange`,
    };
  }
}
