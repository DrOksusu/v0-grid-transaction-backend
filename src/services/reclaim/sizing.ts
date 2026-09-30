export interface ReclaimSizingInput {
  bithumbBidQty: number;   // 빗썸 최우선 매수호가 물량 (내가 매도 가능한 수량)
  upbitAskQty: number;     // 업비트 최우선 매도호가 물량 (내가 매수 가능한 수량)
  bithumbHolding: number;  // 빗썸 보유 재고
  upbitKrw: number;        // 업비트 KRW 잔고
  upbitAsk: number;        // 업비트 매수 체결 가격
  maxOrderKrw: number;     // 1회 한도
  feeBps: number;          // 업비트 매수 수수료(bps) — 예산 보정용
}

/**
 * 되돌림 주문 수량 = min(빗썸 bid 물량, 업비트 ask 물량, 빗썸 재고, 한도/가격, 업비트KRW/가격).
 * 최우선호가 물량 이내로 잡아 양쪽 완전체결 + 슬리피지 0을 목표.
 */
export function computeReclaimQty(i: ReclaimSizingInput): number {
  if (!(i.upbitAsk > 0)) return 0;
  const feeFactor = 1 + i.feeBps / 10000;
  const qtyByMaxOrder = i.maxOrderKrw / i.upbitAsk;
  const qtyByUpbitKrw = i.upbitKrw / (i.upbitAsk * feeFactor);
  const raw = Math.min(i.bithumbBidQty, i.upbitAskQty, i.bithumbHolding, qtyByMaxOrder, qtyByUpbitKrw);
  return Math.max(0, Math.floor(raw * 1e8) / 1e8);
}
