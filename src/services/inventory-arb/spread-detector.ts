// 순수 함수: 업비트·빗썸 최우선 호가 → 수익 가능한 크로스 스프레드 1건 (없으면 null)
import type { BookTop, SpreadOpportunity } from './types';

function validBook(b: BookTop): boolean {
  return b.bid > 0 && b.ask > 0 && b.bidQty > 0 && b.askQty > 0;
}

/**
 * 크로스 스프레드 감지. 두 방향 중 수익(sellPrice > buyPrice)인 쪽을 반환.
 * 두 방향 동시 수익은 정상 시장에서 불가능하나, 방어적으로 spread 큰 쪽 선택.
 */
export function detectOpportunity(upbit: BookTop, bithumb: BookTop): SpreadOpportunity | null {
  if (!validBook(upbit) || !validBook(bithumb)) return null;

  const candidates: SpreadOpportunity[] = [];

  // 방향 1: 업비트에서 사서(ask) 빗썸에서 판다(bid)
  if (bithumb.bid > upbit.ask) {
    candidates.push({
      direction: 'buy_upbit_sell_bithumb',
      buyExchange: 'upbit',
      sellExchange: 'bithumb',
      buyPrice: upbit.ask,
      sellPrice: bithumb.bid,
      spreadBps: Math.floor((bithumb.bid / upbit.ask - 1) * 10000),
      maxQtyByDepth: Math.min(upbit.askQty, bithumb.bidQty),
    });
  }

  // 방향 2: 빗썸에서 사서(ask) 업비트에서 판다(bid)
  if (upbit.bid > bithumb.ask) {
    candidates.push({
      direction: 'buy_bithumb_sell_upbit',
      buyExchange: 'bithumb',
      sellExchange: 'upbit',
      buyPrice: bithumb.ask,
      sellPrice: upbit.bid,
      spreadBps: Math.floor((upbit.bid / bithumb.ask - 1) * 10000),
      maxQtyByDepth: Math.min(bithumb.askQty, upbit.bidQty),
    });
  }

  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.spreadBps - a.spreadBps)[0];
}
