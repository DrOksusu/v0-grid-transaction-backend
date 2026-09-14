// 거래소 API 서명 공용 모듈
// listing-auto-trader.service.ts에서 추출 (2026-09-14, multi-exchange-arb-alert Task 1)
// - Binance/MEXC: HMAC-SHA256 (signedGet/signedPost/mexcPost)
// - Gate.io: HMAC-SHA512 (gateioRequest)
// - 업비트: JWT HS256 (generateUpbitJwt) — upbit.service.ts generateToken과 동일 규격
// 빗썸 JWT는 bithumb-client.ts의 generateBithumbJwt 사용 (query_hash 규격이 달라 별도 유지)

import axios from 'axios';
import crypto from 'crypto';
import https from 'https';
import jwt from 'jsonwebtoken';

export const BINANCE = { baseUrl: 'https://api.binance.com', apiKeyHeader: 'X-MBX-APIKEY', paramsInBody: true };
export const MEXC = { baseUrl: 'https://api.mexc.com', apiKeyHeader: 'X-MEXC-APIKEY', paramsInBody: false };
export const GATEIO_BASE = 'https://api.gateio.ws';

// ── Binance / MEXC 공통 HMAC-SHA256 ────────────────────────────────────────

export function hmacSign(secretKey: string, params: Record<string, string>): string {
  return crypto.createHmac('sha256', secretKey).update(new URLSearchParams(params).toString()).digest('hex');
}

export async function signedGet(
  baseUrl: string,
  apiKeyHeader: string,
  apiKey: string,
  secretKey: string,
  endpoint: string,
  params: Record<string, string> = {},
) {
  const timestamp = Date.now().toString();
  const allParams = { ...params, timestamp };
  const signature = hmacSign(secretKey, allParams);
  const qs = new URLSearchParams({ ...allParams, signature }).toString();
  const res = await axios.get(`${baseUrl}${endpoint}?${qs}`, {
    headers: { [apiKeyHeader]: apiKey },
    timeout: 10000,
  });
  return res.data;
}

// paramsInBody: Binance = true (body), MEXC = false (querystring)
export async function signedPost(
  baseUrl: string,
  apiKeyHeader: string,
  apiKey: string,
  secretKey: string,
  endpoint: string,
  params: Record<string, string>,
  paramsInBody = true,
) {
  const timestamp = Date.now().toString();
  const allParams = { ...params, timestamp };
  const signature = hmacSign(secretKey, allParams);
  const qs = new URLSearchParams({ ...allParams, signature }).toString();

  if (paramsInBody) {
    const res = await axios.post(`${baseUrl}${endpoint}`, qs, {
      headers: { [apiKeyHeader]: apiKey, 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });
    return res.data;
  } else {
    // MEXC: 파라미터를 querystring으로 전달, body 없음
    // axios가 body=null이어도 Content-Type을 자동 추가하므로 명시적으로 제거
    const res = await axios.post(`${baseUrl}${endpoint}?${qs}`, null, {
      headers: { [apiKeyHeader]: apiKey, 'Content-Type': undefined },
      timeout: 10000,
      transformRequest: [(data: any, headers: any) => {
        delete headers['Content-Type'];
        delete headers['content-type'];
        return data;
      }],
    });
    return res.data;
  }
}

// Gate.io HMAC-SHA512 서명 (method + path + querystring + body_hash + timestamp)
export async function gateioRequest(apiKey: string, secretKey: string, method: string, path: string, queryString = '', body = ''): Promise<any> {
  const timestamp = Math.floor(Date.now() / 1000);
  const bodyHash = crypto.createHash('sha512').update(body).digest('hex');
  const message = `${method}\n${path}\n${queryString}\n${bodyHash}\n${timestamp}`;
  const sign = crypto.createHmac('sha512', secretKey).update(message).digest('hex');
  const url = `${GATEIO_BASE}${path}${queryString ? '?' + queryString : ''}`;
  const res = await axios({
    method: method.toLowerCase() as 'get' | 'post',
    url,
    data: body || undefined,
    headers: { 'KEY': apiKey, 'Timestamp': String(timestamp), 'SIGN': sign, 'Content-Type': 'application/json' },
    timeout: 10000,
  });
  return res.data;
}

// MEXC POST: axios가 Content-Type을 강제 추가하므로 Node.js https 모듈 직접 사용
export function mexcPost(apiKey: string, secretKey: string, endpoint: string, params: Record<string, string>): Promise<any> {
  const timestamp = Date.now().toString();
  const allParams = { ...params, timestamp };
  const signature = hmacSign(secretKey, allParams);
  const qs = new URLSearchParams({ ...allParams, signature }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.mexc.com',
      path: `${endpoint}?${qs}`,
      method: 'POST',
      headers: { 'X-MEXC-APIKEY': apiKey },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', (c: string) => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // MEXC는 비즈니스 에러(잔고 부족 등)를 HTTP 200으로 반환하면서 body에 code 필드로 구분
          const isHttpError = res.statusCode && res.statusCode >= 400;
          const isBodyError = parsed.code && parsed.code !== 200 && !parsed.orderId;
          if (isHttpError || isBodyError) {
            const err: any = new Error(parsed.msg ?? `MEXC 오류 code=${parsed.code}`);
            err.response = { data: parsed };
            reject(err);
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`MEXC 파싱 실패: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('MEXC timeout')); });
    req.end();
  });
}

// ── 업비트 JWT HS256 (GET /v1/status/wallet 등 인증 API용) ──────────────────

export function generateUpbitJwt(accessKey: string, secretKey: string, queryString?: string): string {
  const payload: Record<string, unknown> = {
    access_key: accessKey,
    nonce: crypto.randomUUID(),
  };
  if (queryString) {
    payload.query_hash = crypto.createHash('sha512').update(queryString, 'utf-8').digest('hex');
    payload.query_hash_alg = 'SHA512';
  }
  return jwt.sign(payload as object, secretKey);
}
