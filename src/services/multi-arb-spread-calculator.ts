// 같은 통화권 내 코인별 최저매수 ↔ 최고매도 쌍 스프레드 계산 (spec §4 SpreadCalculator, §5 step 3)
// 순수함수 — 외부 I/O 없음
import { CurrencyZone, MultiArbExchange, PriceMap, SpreadCandidate } from './multi-arb-types';

export function calculateSpreads(
  currencyZone: CurrencyZone,
  symbols: string[],
  prices: Partial<Record<MultiArbExchange, PriceMap>>,
  zoneExchanges: MultiArbExchange[],
): SpreadCandidate[] {
  const candidates: SpreadCandidate[] = [];

  for (const symbol of symbols) {
    // 이번 사이클에 시세가 있는 거래소만 수집 (조회 실패 거래소는 prices에 키 없음 — spec §9)
    const quotes: Array<{ exchange: MultiArbExchange; price: number }> = [];
    for (const exchange of zoneExchanges) {
      const price = prices[exchange]?.get(symbol);
      if (typeof price === 'number' && price > 0) quotes.push({ exchange, price });
    }
    if (quotes.length < 2) continue; // 비교 쌍이 성립하지 않음

    let buy = quotes[0];
    let sell = quotes[0];
    for (const q of quotes) {
      if (q.price < buy.price) buy = q;
      if (q.price > sell.price) sell = q;
    }
    if (buy.exchange === sell.exchange || sell.price <= buy.price) continue; // 스프레드 없음

    candidates.push({
      symbol,
      currencyZone,
      buyExchange: buy.exchange,
      buyPrice: buy.price,
      sellExchange: sell.exchange,
      sellPrice: sell.price,
      spreadPct: ((sell.price - buy.price) / buy.price) * 100,
    });
  }

  return candidates;
}
