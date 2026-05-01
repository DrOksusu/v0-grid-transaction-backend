// Task 3: UpbitClient smoke test
// 통합 테스트(실제 Upbit API 호출)는 Task 18에서 진행. 여기서는 어댑터 생성 + exchangeName 검증만.

import { UpbitClient } from '../../../src/services/exchange/upbit-client';

describe('UpbitClient', () => {
  it('exchangeName 이 upbit 이다', () => {
    const c = new UpbitClient({ accessKey: 'k', secretKey: 's' });
    expect(c.exchangeName).toBe('upbit');
  });
});
