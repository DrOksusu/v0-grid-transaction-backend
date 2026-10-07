// 거래소별 호가통화(quote) 판정 + KRW/USDT 손익 분리.
export function isUsdtQuote(exchange: string): boolean {
  return exchange === 'mexc';
}

export function splitByQuote<T extends { exchange: string; currentProfit?: number }>(
  bots: T[],
): { krwProfit: number; usdtProfit: number } {
  let krwProfit = 0, usdtProfit = 0;
  for (const b of bots) {
    const p = b.currentProfit ?? 0;
    if (isUsdtQuote(b.exchange)) usdtProfit += p;
    else krwProfit += p;
  }
  return { krwProfit, usdtProfit };
}
