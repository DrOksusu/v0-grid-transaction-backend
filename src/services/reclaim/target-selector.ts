export interface SelectTargetsInput {
  holdings: Record<string, number>;       // 빗썸 보유 {symbol: qty}
  upbitMarkets: Set<string>;              // 업비트 KRW 공통상장 심볼
  withdrawFeePct: Record<string, number>; // 출금수수료율(%) {symbol: pct}. 미확인은 키 없음
  thresholdPct: number;                   // 이 값 초과(전송 비쌈)만 대상
}

/**
 * 되돌림 대상 = 빗썸 보유량>0 × 업비트 공통상장 × (출금수수료율 > 임계 또는 미확인).
 * 전송이 싼(임계 이하) 코인은 전송이 답이므로 제외.
 */
export function selectReclaimTargets(i: SelectTargetsInput): string[] {
  const out: string[] = [];
  for (const [sym, qty] of Object.entries(i.holdings)) {
    if (!(qty > 0)) continue;
    if (!i.upbitMarkets.has(sym)) continue;
    const fee = i.withdrawFeePct[sym];
    if (fee != null && fee <= i.thresholdPct) continue; // 전송이 싸면 제외
    out.push(sym);
  }
  return out;
}
