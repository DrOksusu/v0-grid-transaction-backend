// KOSPI/KOSDAQ 호가 단위 (2026년 기준, 한국거래소 공식)
// 가격이 max 미만일 때 해당 tick 단위 사용
const TICK_TABLE: Array<{ max: number; tick: number }> = [
  { max: 2000, tick: 1 },
  { max: 5000, tick: 5 },
  { max: 20000, tick: 10 },
  { max: 50000, tick: 50 },
  { max: 200000, tick: 100 },
  { max: 500000, tick: 500 },
  { max: Infinity, tick: 1000 },
];

/**
 * 가격에 해당하는 호가 단위 반환
 * 예: 75000원 → 100원, 30000원 → 50원
 */
export function getTickSize(price: number): number {
  for (const row of TICK_TABLE) {
    if (price < row.max) return row.tick;
  }
  return 1000;
}

/**
 * 가격을 호가 단위에 맞춰 반올림
 * 예: 75123원 → 75100원, 75150원 → 75200원 (반올림)
 */
export function snapToTickSize(price: number): number {
  const tick = getTickSize(price);
  return Math.round(price / tick) * tick;
}
