// 대형코인 집합 — 스프레드 진폭이 작고 노출이 커서 되돌림 대상에서 기본 제외.
// 명백한 대형주만 포함(HBAR/AVAX/XLM/LINK/INJ 등 좋은 후보는 의도적으로 미포함).
export const MAJOR_SYMBOLS = new Set<string>([
  'BTC', 'ETH', 'XRP', 'SOL', 'USDT', 'USDC', 'BNB', 'ADA', 'DOGE', 'TRX',
]);

export interface SelectTargetsInput {
  holdings: Record<string, number>;       // 빗썸 보유 {symbol: qty}
  upbitMarkets: Set<string>;              // 업비트 KRW 공통상장 심볼
  withdrawFeePct: Record<string, number>; // 출금수수료율(%) {symbol: pct}. 미확인은 키 없음
  thresholdPct: number;                   // 이 값 초과(전송 비쌈)만 대상
  excludeMajors: boolean;                 // true면 대형코인(MAJOR_SYMBOLS) 제외
}

/**
 * 되돌림 대상 = 빗썸 보유량>0 × 업비트 공통상장 × (출금수수료율 > 임계 또는 미확인) × (excludeMajors면 비대형).
 * 전송이 싼(임계 이하) 코인은 전송이 답이므로 제외. 대형코인은 스프레드가 얇아 기본 제외.
 */
export function selectReclaimTargets(i: SelectTargetsInput): string[] {
  const out: string[] = [];
  for (const [sym, qty] of Object.entries(i.holdings)) {
    if (!(qty > 0)) continue;
    if (!i.upbitMarkets.has(sym)) continue;
    if (i.excludeMajors && MAJOR_SYMBOLS.has(sym)) continue; // 대형코인 제외
    const fee = i.withdrawFeePct[sym];
    if (fee != null && fee <= i.thresholdPct) continue; // 전송이 싸면 제외
    out.push(sym);
  }
  return out;
}
