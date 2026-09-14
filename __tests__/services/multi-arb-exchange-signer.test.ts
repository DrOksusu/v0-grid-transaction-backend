// 공용 서명 모듈 단위테스트 — HMAC 서명 결정성 + 업비트 JWT payload 구조 검증
import jwt from 'jsonwebtoken';
import { hmacSign, generateUpbitJwt, BINANCE, MEXC, GATEIO_BASE } from '../../src/services/exchange/exchange-signer';

describe('exchange-signer', () => {
  describe('hmacSign (Binance/MEXC HMAC-SHA256)', () => {
    it('64자 hex 서명을 생성한다', () => {
      const sig = hmacSign('test-secret', { symbol: 'BTCUSDT', timestamp: '1726300000000' });
      expect(sig).toMatch(/^[0-9a-f]{64}$/);
    });

    it('같은 입력 → 같은 서명 (결정성)', () => {
      const params = { symbol: 'BTCUSDT', timestamp: '1726300000000' };
      expect(hmacSign('k', params)).toBe(hmacSign('k', params));
    });

    it('시크릿이 다르면 서명이 달라진다', () => {
      const params = { a: '1' };
      expect(hmacSign('k1', params)).not.toBe(hmacSign('k2', params));
    });
  });

  describe('generateUpbitJwt', () => {
    it('secretKey로 검증 가능한 JWT를 생성하고 access_key/nonce를 포함한다', () => {
      const token = generateUpbitJwt('my-access', 'my-secret');
      const payload = jwt.verify(token, 'my-secret') as any;
      expect(payload.access_key).toBe('my-access');
      expect(typeof payload.nonce).toBe('string');
      expect(payload.query_hash).toBeUndefined();
    });

    it('queryString 전달 시 SHA512 query_hash를 포함한다', () => {
      const token = generateUpbitJwt('my-access', 'my-secret', 'currency=BTC');
      const payload = jwt.verify(token, 'my-secret') as any;
      expect(payload.query_hash).toMatch(/^[0-9a-f]{128}$/);
      expect(payload.query_hash_alg).toBe('SHA512');
    });
  });

  describe('거래소 상수', () => {
    it('기존 listing-auto-trader와 동일한 값을 유지한다 (추출 회귀 방지)', () => {
      expect(BINANCE).toEqual({ baseUrl: 'https://api.binance.com', apiKeyHeader: 'X-MBX-APIKEY', paramsInBody: true });
      expect(MEXC).toEqual({ baseUrl: 'https://api.mexc.com', apiKeyHeader: 'X-MEXC-APIKEY', paramsInBody: false });
      expect(GATEIO_BASE).toBe('https://api.gateio.ws');
    });
  });
});
