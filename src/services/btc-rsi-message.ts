/**
 * BTC RSI 상승 다이버전스 알림 메시지 생성
 *
 * 현재가/현재 RSI는 마지막 캔들 값을 사용한다 — 스윙 저점은 확정에 최소 3봉(12시간)이
 * 걸려 항상 과거 시점이므로, 저점 값을 "현재"로 표시하면 오인 발생 (2026-06-12 사례:
 * 이틀 전 저점 $60,755가 현재가로 출력됨).
 */

interface DivergencePoint {
  price: number;
  rsi: number;
  openTime: number;
}

export function buildBullishDivergenceMsg(params: {
  currentPrice: number;
  currentRsi: number;
  prev: DivergencePoint;
  recent: DivergencePoint;
}): string {
  const { currentPrice, currentRsi, prev, recent } = params;
  const prevDate = new Date(prev.openTime).toISOString().slice(0, 16);
  const recentDate = new Date(recent.openTime).toISOString().slice(0, 16);

  return (
    `[BTC RSI 상승 다이버전스]\n` +
    `현재가: $${currentPrice.toLocaleString()}\n` +
    `현재 RSI: ${currentRsi.toFixed(2)}\n` +
    `이전 저점 ($${prev.price.toLocaleString()} @ ${prevDate}, RSI ${prev.rsi.toFixed(2)}) ↔ ` +
    `최근 저점 ($${recent.price.toLocaleString()} @ ${recentDate}, RSI ${recent.rsi.toFixed(2)})\n` +
    `⬇️ 가격 하락 / ⬆️ RSI 상승 → 매수 시그널\n` +
    `https://v0-grid-transaction.vercel.app/admin/btc-rsi`
  );
}
