import { computeReconnectDelay } from '../../src/services/upbit-price-manager';

describe('computeReconnectDelay (업비트 WS 재연결 지연)', () => {
  it('초반은 지수 백오프 1s→2s→4s', () => {
    expect(computeReconnectDelay(0)).toBe(1000);
    expect(computeReconnectDelay(1)).toBe(2000);
    expect(computeReconnectDelay(2)).toBe(4000);
  });
  it('빠른 재시도 구간은 최대 30초', () => {
    expect(computeReconnectDelay(9)).toBe(30000);
  });
  it('빠른 재시도 한도 이후에도 포기하지 않고 60초 간격 (장시간 점검 대비)', () => {
    expect(computeReconnectDelay(10)).toBe(60000);
    expect(computeReconnectDelay(500)).toBe(60000);
  });
});
