export interface OrderbookSnapshot {
  upbitBid: number;
  upbitAsk: number;
  bithumbBid: number;
  bithumbAsk: number;
}

export interface SpreadGateResult {
  ok: boolean;
  spreadBps: number;
  reason?: string;
}

export function isSpreadProfitable(
  snapshot: OrderbookSnapshot,
  direction: 'UB' | 'BU',
  minSpreadBps: number,
): SpreadGateResult {
  const ratio = direction === 'UB'
    ? snapshot.upbitBid / snapshot.bithumbAsk
    : snapshot.bithumbBid / snapshot.upbitAsk;
  const spreadBps = Math.floor((ratio - 1) * 10000);
  if (spreadBps < minSpreadBps) {
    return {
      ok: false,
      spreadBps,
      reason: `spread ${spreadBps} bps < min ${minSpreadBps} (${direction} direction, 수익성 미달)`,
    };
  }
  return { ok: true, spreadBps };
}
