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
  const numerator = direction === 'UB' ? snapshot.upbitBid : snapshot.bithumbBid;
  const denominator = direction === 'UB' ? snapshot.bithumbAsk : snapshot.upbitAsk;

  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    numerator <= 0 ||
    denominator <= 0
  ) {
    return {
      ok: false,
      spreadBps: 0,
      reason: `invalid orderbook (${direction}): numerator=${numerator}, denominator=${denominator}`,
    };
  }

  const ratio = numerator / denominator;
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
