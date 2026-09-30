// 되돌림(빗썸 매도 + 업비트 매수) 순차익 계산.
// ⚠️ 수수료 기본값은 코드 가정(빗썸 taker 0.04% + 업비트 taker 0.05%). 실제 빗썸 등급이 높으면
//    순차익≥0이 실제로는 손해가 될 수 있음 — 배포 전 실제 taker 등급으로 조정할 것.
export const RECLAIM_FEE_BPS = 9; // 0.09% (빗썸 4 + 업비트 5)

/** 되돌림 순차익(%) = (빗썸bid - 업비트ask)/업비트ask × 100 - 수수료% */
export function reclaimNetPct(bithumbBid: number, upbitAsk: number, feeBps = RECLAIM_FEE_BPS): number {
  if (!(upbitAsk > 0)) return -Infinity;
  const grossPct = ((bithumbBid - upbitAsk) / upbitAsk) * 100;
  return grossPct - feeBps / 100;
}

/** 순차익이 최소 임계 이상이면 실행 */
export function shouldReclaim(bithumbBid: number, upbitAsk: number, minNetPct: number, feeBps = RECLAIM_FEE_BPS): boolean {
  return reclaimNetPct(bithumbBid, upbitAsk, feeBps) >= minNetPct;
}
