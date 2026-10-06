// 순수 함수: 스프레드/anomaly/재고/잔고/일일한도 → 최종 주문 수량 결정
import type { FeasibilityInput, FeasibilityResult } from './types';

const MIN_ORDER_KRW = 5000; // 업비트·빗썸 공통 최소 주문금액

export function evaluateFeasibility(input: FeasibilityInput): FeasibilityResult {
  const {
    opp, minSpreadBps, anomalyMaxBps, maxOrderKrw, dailyMaxKrw, dailyMaxCount,
    todayNotionalKrw, todayCount, sellCoinBalance, buyKrwBalance, buyFeeBps,
    krwSafetyFactor,
  } = input;

  const fail = (reason: string): FeasibilityResult => ({ ok: false, qty: 0, notionalKrw: 0, reason });

  // 0. 가격 유효성 (독립 호출 방어 — detector가 보장하나 게이트 자체 불변식 강제)
  if (opp.buyPrice <= 0) return fail(`invalid buyPrice ${opp.buyPrice}`);

  // 1. 스프레드 게이트
  if (opp.spreadBps < minSpreadBps) {
    return fail(`spread ${opp.spreadBps}bp < min ${minSpreadBps}bp`);
  }
  // 2. anomaly 가드
  if (opp.spreadBps > anomalyMaxBps) {
    return fail(`anomaly: spread ${opp.spreadBps}bp > max ${anomalyMaxBps}bp`);
  }
  // 3. 일일 건수 한도
  if (dailyMaxCount != null && todayCount >= dailyMaxCount) {
    return fail(`daily count limit reached (${todayCount}/${dailyMaxCount})`);
  }

  // 4. KRW 예산 한도 계산 (per-order + daily 잔여 중 작은 값)
  let krwBudget = maxOrderKrw;
  if (dailyMaxKrw != null) {
    const remaining = dailyMaxKrw - todayNotionalKrw;
    if (remaining <= 0) return fail(`daily notional limit reached (used ${todayNotionalKrw}/${dailyMaxKrw})`);
    krwBudget = Math.min(krwBudget, remaining);
  }

  // 5. qty = min(depth, KRW예산/가격, 매도재고, 매수KRW/가격(수수료포함))
  const feeFactor = 1 + buyFeeBps / 10000;
  const qtyByBudget = krwBudget / opp.buyPrice;
  const qtyByKrwBalance = buyKrwBalance / (opp.buyPrice * feeFactor);
  const rawQty = Math.min(opp.maxQtyByDepth, qtyByBudget, sellCoinBalance, qtyByKrwBalance);

  // 소수점 8자리로 floor (거래소 수량 정밀도)
  const qty = Math.floor(rawQty * 1e8) / 1e8;
  const notionalKrw = qty * opp.buyPrice;

  // 6. 최소주문 검사
  if (notionalKrw < MIN_ORDER_KRW) {
    return fail(`notional ${Math.round(notionalKrw)} < min order ${MIN_ORDER_KRW}`);
  }

  // 7. 매수측 KRW 안전마진 — 가용 KRW가 (주문비용 × 마진)보다 적으면 사이징 대신 스킵.
  //    가용 KRW에 딱 맞춰 주문하면, 체크~체결 사이 타봇(그리드·스테이블 등)이 KRW를 소진·락할 때
  //    빗썸 매수만 거부되고 업비트 매도는 체결돼 한쪽 노출(flatten_failed→killSwitch)이 난다.
  //    KRW가 binding 제약이면 여기서 걸러 아예 시도하지 않는다. (미지정/1 = 기존 무버퍼 동작)
  const safety = krwSafetyFactor ?? 1;
  const needKrw = notionalKrw * feeFactor * safety;
  if (buyKrwBalance < needKrw) {
    return fail(`buy-side KRW ${Math.round(buyKrwBalance)} < 필요 ${Math.round(needKrw)} (안전마진 ${safety}) — 한쪽체결 방지 스킵`);
  }

  return { ok: true, qty, notionalKrw };
}
