// Task 4: BithumbClient unit tests
// HMAC 서명 결정성 + base64 형식 + 입력 변경 시 서명 변경 검증 + exchangeName 라이터럴 확인.
// 통합 테스트(실제 Bithumb API 호출)는 추후 task 에서 진행.

import { BithumbClient, signRequest } from '../../../src/services/exchange/bithumb-client';

describe('BithumbClient — HMAC signing', () => {
  it('서명 결과가 결정적이다 (동일 입력 = 동일 서명)', () => {
    const sig1 = signRequest('/info/balance', 'currency=USDE', '1700000000000', 'TEST_SECRET');
    const sig2 = signRequest('/info/balance', 'currency=USDE', '1700000000000', 'TEST_SECRET');
    expect(sig1).toBe(sig2);
  });

  it('서명 결과는 base64 형식이다', () => {
    const sig = signRequest('/info/balance', 'currency=USDE', '1700000000000', 'TEST_SECRET');
    expect(sig).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('다른 입력은 다른 서명을 만든다', () => {
    const sig1 = signRequest('/info/balance', 'currency=USDE', '1700000000000', 'TEST_SECRET');
    const sig2 = signRequest('/info/balance', 'currency=USDT', '1700000000000', 'TEST_SECRET');
    expect(sig1).not.toBe(sig2);
  });
});

describe('BithumbClient — exchangeName', () => {
  it('exchangeName 이 bithumb 이다', () => {
    const c = new BithumbClient({ accessKey: 'k', secretKey: 's' });
    expect(c.exchangeName).toBe('bithumb');
  });
});
