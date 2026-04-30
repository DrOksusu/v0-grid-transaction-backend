/**
 * 수익성 gating — makerCoin 호가의 (bestAsk - bestBid) 가 임계값 이상일 때만 maker 주문 허용.
 *
 * 근거: Canary Stage 2 (2026-04-30) 종료 시 spread=1 KRW (~6.7bps) < fees(10bps) 로 항상 손실.
 * 메모리 `project_canary_stage_2_complete_2026_04_30.md` § "수익성 미확보" 참조.
 *
 * 정책 결정은 호출자(agent)가 함 — live executor 는 spec § 2 정합 순수 함수 유지.
 */
import type { OrderbookTop } from './upbit-price-manager';

/** isSpreadProfitable 반환 타입 */
export interface SpreadGateResult {
  /** 수익성 gating 통과 여부 */
  ok: boolean;
  /** 현재 스프레드 (KRW): bestAsk - bestBid */
  spreadKrw: number;
  /** ok=false 일 때 사유 문자열 */
  reason?: string;
}

/**
 * 호가 스프레드가 최소 임계값 이상인지 검사하는 순수 함수.
 *
 * @param makerBook  maker 코인의 최우선 호가 스냅샷 (업비트 OrderbookTop)
 * @param minSpreadKrw  최소 수익성 스프레드 (KRW). 0이면 게이팅 비활성.
 * @returns SpreadGateResult — ok=true 이면 주문 진행 가능
 */
export function isSpreadProfitable(
  makerBook: OrderbookTop,
  minSpreadKrw: number,
): SpreadGateResult {
  // 현재 스프레드 계산 (음수 가능: ask < bid 비정상 입력)
  const spreadKrw = makerBook.ask.price - makerBook.bid.price;

  // minSpreadKrw === 0 → 게이팅 비활성, 항상 통과
  if (minSpreadKrw === 0) {
    return { ok: true, spreadKrw };
  }

  // 스프레드가 임계값 미달이면 수익성 없음으로 판단
  if (spreadKrw < minSpreadKrw) {
    return {
      ok: false,
      spreadKrw,
      reason: `spread ${spreadKrw} KRW < minSpreadKrw ${minSpreadKrw} (수익성 미달)`,
    };
  }

  // 스프레드 >= 임계값 → 통과
  return { ok: true, spreadKrw };
}
