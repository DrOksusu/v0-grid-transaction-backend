import { snapToTickSize } from '../utils/korean-stock-tick-size';

export interface GridPricesInput {
  lowerPrice: number;
  upperPrice: number;
  gridCount: number;
}

/**
 * 그리드 가격 N+1개 등분할 + 호가 단위 자동 보정
 * 양 끝 (lowerPrice, upperPrice)도 호가 단위로 snap
 */
export function calculateGridPrices(input: GridPricesInput): number[] {
  const { lowerPrice, upperPrice, gridCount } = input;
  if (gridCount < 2) throw new Error('gridCount must be >= 2');
  if (lowerPrice >= upperPrice) throw new Error('lowerPrice must be < upperPrice');

  const step = (upperPrice - lowerPrice) / gridCount;
  const prices: number[] = [];
  for (let i = 0; i <= gridCount; i++) {
    const raw = lowerPrice + step * i;
    prices.push(snapToTickSize(raw));
  }
  // 양 끝은 사용자 입력값(snap 적용)을 명시적으로 고정
  prices[0] = snapToTickSize(lowerPrice);
  prices[gridCount] = snapToTickSize(upperPrice);
  return prices;
}

export interface GridRangeInput {
  lowerPrice: number;
  upperPrice: number;
  prevClose: number;
}

/**
 * 그리드 가격 범위가 상하한가(±30%) 안에 있는지 검증
 * lowerPrice < upperPrice 도 함께 확인
 */
export function validateGridRange(input: GridRangeInput): { ok: boolean; reason?: string } {
  const { lowerPrice, upperPrice, prevClose } = input;
  if (lowerPrice >= upperPrice) {
    return { ok: false, reason: 'lowerPrice가 upperPrice보다 작아야 함' };
  }
  const limitLow = prevClose * 0.7;
  const limitHigh = prevClose * 1.3;
  if (lowerPrice < limitLow) {
    return { ok: false, reason: `하한가 ${Math.ceil(limitLow).toLocaleString()}원 미만` };
  }
  if (upperPrice > limitHigh) {
    return { ok: false, reason: `상한가 ${Math.floor(limitHigh).toLocaleString()}원 초과` };
  }
  return { ok: true };
}
