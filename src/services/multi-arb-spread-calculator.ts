// 같은 통화권 내 코인별 호가 순서쌍(매수측 ask ↔ 매도측 bid) 실현 스프레드 계산 (spec §4 SpreadCalculator, §5 step 3)
// 순수함수 — 외부 I/O 없음
import { BookMap, CurrencyZone, MultiArbExchange, SpreadCandidate } from './multi-arb-types';

export function calculateSpreads(
  currencyZone: CurrencyZone,
  symbols: string[],
  books: Partial<Record<MultiArbExchange, BookMap>>,
  zoneExchanges: MultiArbExchange[],
): SpreadCandidate[] {
  const candidates: SpreadCandidate[] = [];

  for (const symbol of symbols) {
    // 이번 사이클에 호가가 있는 거래소만 수집 (조회 실패 거래소는 books에 키 없음 — spec §9)
    const quotes: Array<{ exchange: MultiArbExchange; ask: number; bid: number }> = [];
    for (const exchange of zoneExchanges) {
      const top = books[exchange]?.get(symbol);
      if (top && top.ask > 0 && top.bid > 0) quotes.push({ exchange, ask: top.ask, bid: top.bid });
    }
    if (quotes.length < 2) continue; // 비교 쌍이 성립하지 않음

    // 순서쌍 전수비교: 모든 (buy, sell) 조합에서 실현 스프레드가 최대 양수인 쌍을 채택
    // (min-ask/max-bid 단축 금지 — 한 거래소가 최저ask+최고bid를 동시 보유하면 그 조합은 자기쌍이라 무효)
    let best: { buy: typeof quotes[number]; sell: typeof quotes[number]; realized: number } | null = null;
    for (const buy of quotes) {
      for (const sell of quotes) {
        if (buy.exchange === sell.exchange) continue;
        const realized = (sell.bid - buy.ask) / buy.ask;
        if (realized > 0 && (best === null || realized > best.realized)) {
          best = { buy, sell, realized };
        }
      }
    }
    if (best === null) continue; // 양수 실현 스프레드 쌍 없음

    candidates.push({
      symbol,
      currencyZone,
      buyExchange: best.buy.exchange,
      buyPrice: best.buy.ask,
      askPrice: best.buy.ask,
      sellExchange: best.sell.exchange,
      sellPrice: best.sell.bid,
      bidPrice: best.sell.bid,
      spreadPct: best.realized * 100,
    });
  }

  return candidates;
}
