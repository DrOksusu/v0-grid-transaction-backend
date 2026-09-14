// 가격 sanity check — 티커 충돌/단위 이상치 방어 (Task 12)
// 배경: 통합 검증 스모크에서 TROLL 27억% / ARC 6,545% / XEM 2,950% 같은 비현실적 괴리 발견.
//   원인은 실제 차익이 아니라 같은 티커가 거래소마다 다른 코인을 가리키는 "티커 충돌"
//   (예: TROLL이 MEXC 1.6e-9 vs Gate 0.046) 또는 시세 단위 파싱 차이.
// 방어: 각 후보의 매수/매도 가격이 글로벌 기준가(바이낸스 USDT) 대비 상식 범위 안인지 검사.
//   KRW권 후보는 기준가 × (KRW/USDT 환율)로 원화 환산해 비교.
//   기준가를 못 구하면 폴백으로 스프레드 상한 검사.
// 주의: 정상적인 거래소 간 차익(수%~수십%)은 반드시 통과해야 하므로 범위를 넉넉히 둔다.
// 순수함수 — 외부 I/O 없음
import { PriceMap, SpreadCandidate } from './multi-arb-types';

// 기준가 대비 허용 배수 하한/상한 (env 조정 가능)
// 0.5~2.0x: 김프(수%~수십%)·정상 차익은 여유 있게 통과하고,
// 티커 충돌(수십~수백만배 괴리)만 걸러내는 보수적 범위
export const SANITY_MIN_RATIO = Number(process.env.MULTI_ARB_SANITY_MIN_RATIO ?? '0.5');
export const SANITY_MAX_RATIO = Number(process.env.MULTI_ARB_SANITY_MAX_RATIO ?? '2.0');

// 기준가 없음 폴백: 스프레드 상한(%) — 같은 코인이 거래소 간 100% 넘게 벌어지는 일은
// 사실상 없고(2026-09-13 LSK 142%조차 전송불가 함정), 초과분은 티커 충돌 가능성이 지배적
export const SANITY_MAX_SPREAD_PCT = Number(process.env.MULTI_ARB_SANITY_MAX_SPREAD_PCT ?? '100');

export interface SanityCheckResult {
  ok: boolean;
  reason: string | null; // 제외 사유 (ok=false일 때만; 오케스트레이터 warn 로깅용)
}

// 배수 표기: 아주 작거나 큰 값도 읽을 수 있게 유효숫자 3자리
function formatRatio(ratio: number): string {
  return `${ratio.toPrecision(3)}x`;
}

/**
 * 후보의 매수/매도 가격이 글로벌 기준가 대비 상식 범위인지 판정한다.
 * @param candidate       스프레드 후보
 * @param binancePrices   바이낸스 USDT 시세 맵 (조회 실패 시 undefined)
 * @param krwPerUsdt      KRW/USDT 환율 (KRW권 환산용, 실패 시 null)
 */
export function checkPriceSanity(
  candidate: SpreadCandidate,
  binancePrices: PriceMap | undefined,
  krwPerUsdt: number | null,
): SanityCheckResult {
  // 기준가 결정: 바이낸스 USDT 가격 (KRW권은 환율 환산)
  const refUsdt = binancePrices?.get(candidate.symbol);
  let reference: number | null = null;
  if (typeof refUsdt === 'number' && refUsdt > 0) {
    if (candidate.currencyZone === 'KRW') {
      // 환율이 없으면 원화 환산 불가 → 기준가 없음 폴백으로 전환
      reference = krwPerUsdt !== null && krwPerUsdt > 0 ? refUsdt * krwPerUsdt : null;
    } else {
      reference = refUsdt;
    }
  }

  // 폴백: 기준가 없음 → 스프레드 상한 검사
  if (reference === null) {
    if (candidate.spreadPct > SANITY_MAX_SPREAD_PCT) {
      return {
        ok: false,
        reason: `기준가 없음 + 스프레드 ${candidate.spreadPct.toFixed(1)}% > 상한 ${SANITY_MAX_SPREAD_PCT}%`,
      };
    }
    return { ok: true, reason: null };
  }

  // 매수/매도 어느 한쪽이라도 기준가 대비 허용 배수 범위 밖이면 이상치
  const buyRatio = candidate.buyPrice / reference;
  const sellRatio = candidate.sellPrice / reference;
  const outliers: string[] = [];
  if (buyRatio < SANITY_MIN_RATIO || buyRatio > SANITY_MAX_RATIO) {
    outliers.push(`buy=${candidate.buyExchange} ${formatRatio(buyRatio)}`);
  }
  if (sellRatio < SANITY_MIN_RATIO || sellRatio > SANITY_MAX_RATIO) {
    outliers.push(`sell=${candidate.sellExchange} ${formatRatio(sellRatio)}`);
  }
  if (outliers.length > 0) {
    return {
      ok: false,
      reason: `기준가 대비 이상(${outliers.join(', ')}) — 허용 ${SANITY_MIN_RATIO}~${SANITY_MAX_RATIO}x`,
    };
  }
  return { ok: true, reason: null };
}
