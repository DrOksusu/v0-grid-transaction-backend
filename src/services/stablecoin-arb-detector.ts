import { OrderbookTop } from './upbit-price-manager';

// 스테이블코인 차익 거래 기회 정보
export interface ArbOpportunity {
  soldCoin: string;      // 매도 코인 심볼 (예: 'USDT')
  boughtCoin: string;    // 매수 코인 심볼 (예: 'USDC')
  bidSoldKrw: number;    // 매도 코인 최우선 매수호가 (KRW)
  askBoughtKrw: number;  // 매수 코인 최우선 매도호가 (KRW)
  bidSoldSize: number;   // 매도 대상 1호가 잔량 (팔 수 있는 최대 수량)
  askBoughtSize: number; // 매수 대상 1호가 잔량 (살 수 있는 최대 수량)
  spreadBps: number;     // (bid_X / ask_Y - 1) * 10000, floor
  detectedAt: number;    // ms 타임스탬프
}

/**
 * bid_X / ask_Y 의 bp 단위 스프레드 (수수료·슬리피지 고려 전 순수 가격차).
 *
 * 양수 = X를 팔고 Y를 사면 이득 가능한 상태.
 * 둘 중 하나라도 0 이하면 방어적으로 0 반환.
 *
 * @param bidX 매도 측 최우선 매수호가 (X를 팔 때 받을 KRW 단가)
 * @param askY 매수 측 최우선 매도호가 (Y를 살 때 지불할 KRW 단가)
 */
export function computeSpreadBps(bidX: number, askY: number): number {
  if (bidX <= 0 || askY <= 0) return 0;
  return Math.floor((bidX / askY - 1) * 10000);
}

/**
 * 활성 코인 쌍 중 임계값 초과 최고 기회 1건 반환.
 * 기회 없으면 null.
 *
 * @param books market→OrderbookTop 맵 (upbit-price-manager.getAllStablecoinOrderbooks())
 * @param coinsEnabled 활성화된 코인 심볼 목록 (예: ['USDT','USDC',...])
 * @param thresholdBps 진입 스프레드 최소값 (bp)
 */
export function findBestOpportunity(
  books: ReadonlyMap<string, OrderbookTop>,
  coinsEnabled: string[],
  thresholdBps: number
): ArbOpportunity | null {
  let best: ArbOpportunity | null = null;

  for (const sold of coinsEnabled) {
    const bookX = books.get(`KRW-${sold}`);
    if (!bookX) continue; // 호가 누락 → 스킵

    for (const bought of coinsEnabled) {
      if (sold === bought) continue; // 동일 코인 쌍 제외

      const bookY = books.get(`KRW-${bought}`);
      if (!bookY) continue; // 상대 호가 누락 → 스킵

      const spread = computeSpreadBps(bookX.bid.price, bookY.ask.price);
      if (spread < thresholdBps) continue; // 임계값 미만 → 제외

      // 더 높은 스프레드가 발견되면 교체
      if (best === null || spread > best.spreadBps) {
        best = {
          soldCoin: sold,
          boughtCoin: bought,
          bidSoldKrw: bookX.bid.price,
          askBoughtKrw: bookY.ask.price,
          bidSoldSize: bookX.bid.size,
          askBoughtSize: bookY.ask.size,
          spreadBps: spread,
          detectedAt: Date.now(),
        };
      }
    }
  }

  return best;
}
