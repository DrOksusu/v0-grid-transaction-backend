import axios from 'axios';

const BITHUMB_API_URL = 'https://api.bithumb.com/public';
const TIMEOUT_MS = 5000;

/** Bithumb 단일 마켓 최우선 호가 */
export interface BithumbOrderbookTop {
  market: string;    // 코인 심볼 (예: "USDT", KRW 제외)
  bid: number;       // 최우선 매수호가 (KRW)
  ask: number;       // 최우선 매도호가 (KRW)
  timestamp: number; // 조회 시각 (ms)
}

/**
 * Bithumb 단일 마켓 최우선 호가 조회
 * 엔드포인트: GET /public/orderbook/{symbol}_KRW
 *
 * @param symbol 코인 심볼 ("USDT" 등, KRW 접미사 제외)
 * @returns 최우선 bid/ask. 실패 또는 데이터 없음 시 null.
 */
export async function fetchBithumbOrderbookTop(
  symbol: string
): Promise<BithumbOrderbookTop | null> {
  try {
    const response = await axios.get(
      `${BITHUMB_API_URL}/orderbook/${symbol}_KRW`,
      { timeout: TIMEOUT_MS }
    );
    const data = response.data;

    // 빗썸 API 응답 status 코드 '0000' = 성공
    if (data?.status !== '0000' || !data.data) {
      return null;
    }

    const topBid = data.data.bids?.[0];
    const topAsk = data.data.asks?.[0];
    if (!topBid || !topAsk) return null;

    return {
      market: symbol,
      bid: parseFloat(topBid.price),
      ask: parseFloat(topAsk.price),
      timestamp: Date.now(),
    };
  } catch (err: any) {
    // 개별 심볼 실패 시 에러 격리 — 다른 심볼 조회에 영향 없음
    console.error(`[Bithumb] orderbook ${symbol} 조회 실패:`, err.message);
    return null;
  }
}

/**
 * 여러 마켓의 최우선 호가를 순차 조회.
 * Bithumb rate limit (대략 초당 20 요청)을 여유롭게 처리하기 위해 순차 호출.
 *
 * @param symbols 심볼 배열 (예: ["USDT", "USDC"])
 * @returns 심볼 → 호가 맵. 조회 실패한 심볼은 맵에서 제외.
 */
export async function fetchBithumbOrderbooks(
  symbols: string[]
): Promise<Map<string, BithumbOrderbookTop>> {
  const result = new Map<string, BithumbOrderbookTop>();

  for (const symbol of symbols) {
    const top = await fetchBithumbOrderbookTop(symbol);
    if (top) result.set(symbol, top);
  }

  return result;
}
