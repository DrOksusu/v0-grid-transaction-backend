import { buildBullishDivergenceMsg } from '../../src/services/btc-rsi-message';

describe('buildBullishDivergenceMsg (상승 다이버전스 알림 메시지)', () => {
  const params = {
    // 실제 현재가/RSI (마지막 캔들 기준)
    currentPrice: 62150.5,
    currentRsi: 42.18,
    prev: { price: 61184, rsi: 37.31, openTime: Date.UTC(2026, 5, 7, 16, 0) },
    recent: { price: 60755, rsi: 38.69, openTime: Date.UTC(2026, 5, 10, 8, 0) },
  };

  test('현재가는 저점 가격이 아니라 마지막 캔들 종가를 표시한다', () => {
    // 2026-06-12 실제 버그: 현재가에 최근 저점(60,755)이 그대로 출력됨
    const msg = buildBullishDivergenceMsg(params);
    expect(msg).toContain('현재가: $62,150.5');
    expect(msg).not.toContain('현재가: $60,755');
  });

  test('현재 RSI는 저점 RSI가 아니라 마지막 캔들 RSI를 표시한다', () => {
    const msg = buildBullishDivergenceMsg(params);
    expect(msg).toContain('현재 RSI: 42.18');
    expect(msg).not.toContain('현재 RSI: 38.69');
  });

  test('저점 비교 라인은 기존 형식을 유지한다', () => {
    const msg = buildBullishDivergenceMsg(params);
    expect(msg).toContain('이전 저점 ($61,184 @ 2026-06-07T16:00, RSI 37.31)');
    expect(msg).toContain('최근 저점 ($60,755 @ 2026-06-10T08:00, RSI 38.69)');
    expect(msg).toContain('매수 시그널');
    expect(msg).toContain('https://v0-grid-transaction.vercel.app/admin/btc-rsi');
  });
});
