// 순수 함수: 업비트·빗썸 호가 → 수익 가능한 크로스 스프레드 1건 (없으면 null)
// 다단계 depth를 walk해 "마진 스프레드 ≥ minSpreadBps"인 구간까지 체결가능 수량을 누적한다(spec §6).
// 레벨 배열(bids/asks)이 없으면 최우선 1단계로 폴백(하위호환).
import type { BookTop, BookLevel, SpreadOpportunity } from './types';

const EPS = 1e-12;

function validBook(b: BookTop): boolean {
  return b.bid > 0 && b.ask > 0 && b.bidQty > 0 && b.askQty > 0;
}

/** bid 레벨 배열 (내림차순). 없으면 최우선 1단계로 폴백 */
function bidLevels(b: BookTop): BookLevel[] {
  return b.bids && b.bids.length > 0 ? b.bids : [{ price: b.bid, qty: b.bidQty }];
}

/** ask 레벨 배열 (오름차순). 없으면 최우선 1단계로 폴백 */
function askLevels(b: BookTop): BookLevel[] {
  return b.asks && b.asks.length > 0 ? b.asks : [{ price: b.ask, qty: b.askQty }];
}

interface DepthResult {
  qty: number; // 마진 스프레드 ≥ 임계 인 구간까지 누적 체결가능 수량
  worstSellPrice: number; // 소비한 최저 매도(bid) 체결가 (priceHint용)
  worstBuyPrice: number; // 소비한 최고 매수(ask) 체결가 (priceHint용)
}

/**
 * 매도측 bid 레벨(내림차순)과 매수측 ask 레벨(오름차순)을 매칭하며,
 * 각 레벨쌍의 마진 스프레드(sellBid/buyAsk - 1)가 minSpreadBps 이상인 동안 수량을 누적한다.
 */
function walkDepth(sellBids: BookLevel[], buyAsks: BookLevel[], minSpreadRatio: number): DepthResult {
  let i = 0;
  let j = 0;
  let sRem = sellBids[0].qty;
  let bRem = buyAsks[0].qty;
  let qty = 0;
  let worstSellPrice = sellBids[0].price;
  let worstBuyPrice = buyAsks[0].price;

  while (i < sellBids.length && j < buyAsks.length) {
    const spread = sellBids[i].price / buyAsks[j].price - 1;
    if (spread < minSpreadRatio) break;

    const lot = Math.min(sRem, bRem);
    if (lot <= EPS) break;

    qty += lot;
    worstSellPrice = sellBids[i].price;
    worstBuyPrice = buyAsks[j].price;
    sRem -= lot;
    bRem -= lot;

    if (sRem <= EPS) {
      i++;
      if (i < sellBids.length) sRem = sellBids[i].qty;
    }
    if (bRem <= EPS) {
      j++;
      if (j < buyAsks.length) bRem = buyAsks[j].qty;
    }
  }

  return { qty, worstSellPrice, worstBuyPrice };
}

/**
 * 크로스 스프레드 감지. 두 방향 중 수익(최우선호가 기준)인 쪽을 반환.
 * @param minSpreadBps depth walk 시 "여기까지 채운다"는 마진 임계 (기본 0 = 양수 스프레드 전 구간).
 *   진입 게이트(FeasibilityGate)가 별도로 spreadBps ≥ minSpreadBps를 재확인하므로, 여기선 사이징 용도.
 */
export function detectOpportunity(
  upbit: BookTop,
  bithumb: BookTop,
  minSpreadBps: number = 0,
): SpreadOpportunity | null {
  if (!validBook(upbit) || !validBook(bithumb)) return null;

  const minRatio = minSpreadBps / 10000;
  const candidates: SpreadOpportunity[] = [];

  // 방향 1: 업비트에서 사서(ask) 빗썸에서 판다(bid) — 매도측=빗썸 bid, 매수측=업비트 ask
  if (bithumb.bid > upbit.ask) {
    const d = walkDepth(bidLevels(bithumb), askLevels(upbit), minRatio);
    if (d.qty > EPS) {
      candidates.push({
        direction: 'buy_upbit_sell_bithumb',
        buyExchange: 'upbit',
        sellExchange: 'bithumb',
        buyPrice: d.worstBuyPrice,
        sellPrice: d.worstSellPrice,
        spreadBps: Math.floor((bithumb.bid / upbit.ask - 1) * 10000),
        maxQtyByDepth: d.qty,
      });
    }
  }

  // 방향 2: 빗썸에서 사서(ask) 업비트에서 판다(bid) — 매도측=업비트 bid, 매수측=빗썸 ask
  if (upbit.bid > bithumb.ask) {
    const d = walkDepth(bidLevels(upbit), askLevels(bithumb), minRatio);
    if (d.qty > EPS) {
      candidates.push({
        direction: 'buy_bithumb_sell_upbit',
        buyExchange: 'bithumb',
        sellExchange: 'upbit',
        buyPrice: d.worstBuyPrice,
        sellPrice: d.worstSellPrice,
        spreadBps: Math.floor((upbit.bid / bithumb.ask - 1) * 10000),
        maxQtyByDepth: d.qty,
      });
    }
  }

  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.spreadBps - a.spreadBps)[0];
}
