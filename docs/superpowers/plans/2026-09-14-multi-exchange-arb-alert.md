# 멀티 거래소 차익거래 알림 (Multi-Exchange Arbitrage Alert) 구현 계획

> **For agentic workers: REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`**
> 각 Task는 독립 커밋 단위다. Task 완료 시마다 스펙 준수 리뷰 → 코드 품질 리뷰를 거친 뒤 다음 Task로 진행할 것.
> 근거 spec: `docs/superpowers/specs/2026-09-14-multi-exchange-arb-alert-design.md` (§ 번호는 이 spec 기준)

**Goal(한 문장)**: 업비트·빗썸·바이낸스·MEXC·Gate.io 5개 거래소의 공통 상장 코인을 60초 주기로 스캔해, 네트워크 일치·입출금 정상 여부까지 검증한 "실현 가능한" 차익 기회만 카카오톡으로 알린다 (알림 전용, 주문 없음).

**Architecture**: 기존 `general-arb-scanner`(업비트↔빗썸 이벤트 드리븐)는 그대로 두고, `BaseAgent` 상속 `MultiExchangeArbAgent`(60초 폴링) → `MultiExchangeArbScanner` 오케스트레이터가 6개 단일책임 모듈(PriceSource / SymbolUniverse / WalletStatusProvider / SpreadCalculator / FeasibilityFilter / Notifier)을 조합하는 새 경로를 추가한다. `listing-auto-trader.service.ts`에 박혀 있던 Binance/MEXC HMAC-SHA256·Gate.io HMAC-SHA512 서명 로직을 공용 모듈로 추출해 재사용한다. 이력·쿨다운 근거는 신규 `MultiArbOpportunity` 테이블에 기록한다.

**Tech Stack**: Express 5 + TypeScript, Prisma(MySQL), axios, jsonwebtoken(업비트 JWT), crypto(HMAC/빗썸 JWT), jest 30 + ts-jest, 기존 `kakao-notify.service.ts`(카카오 나에게 보내기).

---

## 파일 구조 맵

| 구분 | 파일 | 단일 책임 |
|---|---|---|
| Create | `src/services/exchange/exchange-signer.ts` | Binance/MEXC HMAC-SHA256, Gate.io HMAC-SHA512, 업비트 JWT 서명 공용 함수 (listing-auto-trader에서 추출) |
| Create | `src/services/admin-credentials.ts` | userId=2 관리자 Credential 조회+복호화 공용 헬퍼 (gateio env fallback 포함) |
| Modify | `src/services/listing-auto-trader.service.ts` (L86~208, L745~783) | 서명/자격증명 로직 제거 → 공용 모듈 import로 대체 |
| Modify | `src/services/exchange/bithumb-client.ts` (L29) | `generateJwt` → `generateBithumbJwt`로 export (지갑 상태 조회 재사용) |
| Modify | `prisma/schema.prisma` (파일 끝, L814 뒤) | `MultiArbOpportunity` 모델 추가 |
| Modify | `__mocks__/database.ts` | `multiArbOpportunity` mock 추가 |
| Create | `src/services/multi-arb-types.ts` | 공용 타입/상수 (거래소·통화권·태그·맵 타입) |
| Create | `src/services/multi-arb-wallet-status.service.ts` | 거래소별 코인→네트워크·입출금 상태 맵 (5분 캐시) + 파싱 순수함수 |
| Create | `src/services/multi-arb-price-source.service.ts` | 거래소별 배치 시세 조회 어댑터 + KRW/USDT 환율 |
| Create | `src/services/multi-arb-symbol-universe.service.ts` | 5개 거래소 상장 목록 → 통화권별 공통 심볼 교집합 (1시간 캐시) |
| Create | `src/services/multi-arb-spread-calculator.ts` | (순수) 통화권 내 최저매수↔최고매도 스프레드 계산 |
| Create | `src/services/multi-arb-feasibility-filter.ts` | (순수) 네트워크 일치/입출금 3단 실현가능성 판정 |
| Create | `src/services/multi-arb-notifier.service.ts` | 쿨다운(30분) + 카카오톡 발송 + DB 기록, 메시지 포맷 순수함수 |
| Create | `src/services/multi-exchange-arb-scanner.service.ts` | 오케스트레이터 (spec §5 데이터 흐름 + 김프 계산) |
| Create | `src/agents/multi-exchange-arb-agent.ts` | BaseAgent 상속, 60초 사이클 |
| Modify | `src/agents/index.ts` (파일 끝) | 새 에이전트 export |
| Modify | `src/index.ts` (L14, L99~100) | import + `agentManager.register` |
| Test | `__tests__/services/multi-arb-exchange-signer.test.ts` | 서명 함수 단위테스트 |
| Test | `__tests__/services/multi-arb-wallet-status.test.ts` | 5개 거래소 응답 파싱 검증 (spec §11) |
| Test | `__tests__/services/multi-arb-price-source.test.ts` | 배치 시세 파싱 검증 |
| Test | `__tests__/services/multi-arb-symbol-universe.test.ts` | 교집합 계산 검증 |
| Test | `__tests__/services/multi-arb-spread-calculator.test.ts` | 최저매수/최고매도 쌍 선택 검증 (spec §11) |
| Test | `__tests__/services/multi-arb-feasibility-filter.test.ts` | **LSK 회귀 테스트** 포함 3단 필터 검증 (spec §11) |
| Test | `__tests__/services/multi-arb-notifier.test.ts` | 쿨다운 30분 억제 + 발송 성공 시에만 notifiedAt 갱신 (spec §9, §11) |
| Test | `__tests__/services/multi-exchange-arb-scanner.test.ts` | 오케스트레이터 흐름 (모킹 통합) |

작업 디렉토리: 모든 명령은 `D:\ExpressProject\Grid_project\v0-grid-tranasction-backend`에서 실행.
브랜치: `git checkout -b feat/multi-exchange-arb-alert` (main에서 분기, 첫 Task 시작 전 1회).

---

## Task 1: 서명 인프라 공용 추출 (exchange-signer + admin-credentials)

**Files:**
- Create: `src/services/exchange/exchange-signer.ts`
- Create: `src/services/admin-credentials.ts`
- Modify: `src/services/listing-auto-trader.service.ts` (L86~208 서명 블록 제거, L745~783 자격증명 4개 함수 위임, L1~12 import 정리)
- Modify: `src/services/exchange/bithumb-client.ts` (L29 `function generateJwt` → export)
- Test: `__tests__/services/multi-arb-exchange-signer.test.ts`

### Step 1.1: 실패 테스트 작성

`__tests__/services/multi-arb-exchange-signer.test.ts` 생성:

```typescript
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
```

### Step 1.2: 실패 확인

```bash
npx jest __tests__/services/multi-arb-exchange-signer.test.ts
```
기대 출력: `Cannot find module '../../src/services/exchange/exchange-signer'` — FAIL.

### Step 1.3: `exchange-signer.ts` 구현 (listing-auto-trader L86~208에서 이동 + 업비트 JWT 추가)

`src/services/exchange/exchange-signer.ts` 생성:

```typescript
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
```

### Step 1.4: `admin-credentials.ts` 구현 (listing-auto-trader L745~783에서 일반화)

`src/services/admin-credentials.ts` 생성 (⚠️ `src/services/` 직속에 두어야 함 — jest `moduleNameMapper`가 `^../config/database$` 경로만 mock으로 매핑하므로 하위 폴더 금지):

```typescript
// 관리자(userId=2) 거래소 API 자격증명 공용 조회 헬퍼
// listing-auto-trader.service.ts의 getBinanceCreds/getMexcCreds/getGateioCreds/getBithumbCreds에서 추출·일반화
import prisma from '../config/database';
import { decrypt } from '../utils/encryption';

export const ADMIN_USER_ID = 2; // Binance/Bithumb 등 인증정보 소유 유저

export interface ExchangeCreds {
  apiKey: string;
  secretKey: string;
}

export type AdminCredExchange = 'upbit' | 'binance' | 'bithumb' | 'mexc' | 'gateio';

export async function getAdminCreds(exchange: AdminCredExchange): Promise<ExchangeCreds | null> {
  const row = await prisma.credential.findFirst({
    where: { userId: ADMIN_USER_ID, exchange: exchange as any },
    select: { apiKey: true, secretKey: true },
  });
  if (row) return { apiKey: decrypt(row.apiKey), secretKey: decrypt(row.secretKey) };

  // Gate.io만 DB에 없으면 환경변수 fallback (GATEWAY_API_KEY / GATEWAY_SECRET_KEY) — spec §3
  if (exchange === 'gateio') {
    const envKey = process.env.GATEWAY_API_KEY;
    const envSecret = process.env.GATEWAY_SECRET_KEY;
    if (envKey && envSecret) return { apiKey: envKey, secretKey: envSecret };
  }
  return null;
}
```

### Step 1.5: `bithumb-client.ts` — JWT 생성 함수 export

`src/services/exchange/bithumb-client.ts` L29를 수정 (함수 본문은 그대로, export + 이름만 변경):

```typescript
// 변경 전 (L29)
function generateJwt(accessKey: string, secretKey: string, queryString?: string): string {
// 변경 후
export function generateBithumbJwt(accessKey: string, secretKey: string, queryString?: string): string {
```

같은 파일 L56의 내부 호출도 변경: `generateJwt(` → `generateBithumbJwt(`.

### Step 1.6: `listing-auto-trader.service.ts` 리팩토링 (외과적 — 기능 변경 없음)

1. L1~12 import 블록 수정:
   - `import crypto from 'crypto';` 삭제 (hmacSign/gateioRequest 이동으로 미사용)
   - 추가:
   ```typescript
   import { hmacSign, signedGet, signedPost, mexcPost, gateioRequest, BINANCE, MEXC } from './exchange/exchange-signer';
   import { getAdminCreds } from './admin-credentials';
   ```
   - `import https from 'https';`는 유지 (`cancelMexcOrder` L718~741이 직접 사용)
   - `import axios ...` 유지 (`fetchBithumbCurrentPrice`, `fetchKrwPerUsdt` 사용)
2. L86~167의 `hmacSign`/`signedGet`/`signedPost`/`gateioRequest` 함수 정의와 L148~150 상수 `BINANCE`/`MEXC`/`GATEIO_BASE`, L169~208 `mexcPost` 정의 삭제 (import로 대체됨). `GATEIO_BASE`는 이 파일에서 직접 참조가 없으므로 import 불필요.
3. L745~783 자격증명 4개 함수를 위임으로 축소:
   ```typescript
   private async getBinanceCreds(): Promise<{ apiKey: string; secretKey: string } | null> {
     return getAdminCreds('binance');
   }

   private async getBithumbCreds(): Promise<{ apiKey: string; secretKey: string } | null> {
     return getAdminCreds('bithumb');
   }

   private async getMexcCreds(): Promise<{ apiKey: string; secretKey: string } | null> {
     return getAdminCreds('mexc');
   }

   private async getGateioCreds(): Promise<{ apiKey: string; secretKey: string } | null> {
     return getAdminCreds('gateio');
   }
   ```
   (`ADMIN_USER_ID` 상수 L13은 다른 참조가 없으면 삭제, 있으면 유지 — 삭제 시 `admin-credentials.ts`의 것을 사용)

### Step 1.7: 통과 + 회귀 확인

```bash
npx tsc --noEmit
npx jest __tests__/services/multi-arb-exchange-signer.test.ts __tests__/services/listing-auto-trader-source-routing.test.ts __tests__/services/listing-auto-seller-source-routing.test.ts
```
기대 출력: 타입 에러 0개, `Tests: N passed` (신규 6개 + 기존 source-routing 전부 PASS).

### Step 1.8: 커밋

```bash
git add src/services/exchange/exchange-signer.ts src/services/admin-credentials.ts src/services/exchange/bithumb-client.ts src/services/listing-auto-trader.service.ts __tests__/services/multi-arb-exchange-signer.test.ts
git commit -m "refactor: 거래소 서명·자격증명 로직 공용 모듈로 추출"
```

---

## Task 2: Prisma `MultiArbOpportunity` 모델 + 마이그레이션

**Files:**
- Modify: `prisma/schema.prisma` (파일 끝 L814 `BtcDormantSnapshot` 모델 뒤에 추가)
- Modify: `__mocks__/database.ts` (mock 테이블 추가)
- Create: `prisma/migrations/<timestamp>_add_multi_arb_opportunity/migration.sql` (CLI 생성)

### Step 2.1: 스키마 추가 (spec §8 그대로)

`prisma/schema.prisma` 맨 끝에 추가:

```prisma
// 멀티 거래소 차익거래 기회 이력 (알림 쿨다운 근거 포함) — spec 2026-09-14 §8
model MultiArbOpportunity {
  id           Int      @id @default(autoincrement())
  symbol       String                    // base 심볼 (예: "BTC")
  currencyZone String                    // "KRW" | "USDT"
  buyExchange  String
  buyPrice     Float
  sellExchange String
  sellPrice    Float
  spreadPct    Float
  feasibility  String                    // "feasible" | "network_mismatch" | "deposit_halt" | "notice_warning" | "unverified"
  networkMatch Boolean?                  // 네트워크 일치 여부 (판정 가능한 경우)
  matchedNetwork String?                 // 교집합 네트워크 (예: "ETH")
  note         String?                   // 사람이 읽을 요약/경고
  kimchiPct    Float?                    // 참고 김프(%)
  detectedAt   DateTime @default(now())
  notifiedAt   DateTime?                 // 카톡 발송 시각 (null이면 미발송)

  @@index([symbol, currencyZone, notifiedAt])   // 쿨다운 조회
  @@index([detectedAt])
  @@map("multi_arb_opportunities")
}
```

### Step 2.2: 마이그레이션 생성 (⚠️ Prisma CLI garbage 버그 대응 — `--create-only` 후 SQL 검사 필수)

```bash
npx prisma migrate dev --create-only --name add_multi_arb_opportunity
```

생성된 `prisma/migrations/*_add_multi_arb_opportunity/migration.sql`을 검사 (박스문자 `─` 등 혼입 버그):

```bash
tail -5 prisma/migrations/*_add_multi_arb_opportunity/migration.sql
grep -n '─\|│\|┌' prisma/migrations/*_add_multi_arb_opportunity/migration.sql || echo "CLEAN"
```
기대 출력: `CLEAN`. SQL 마지막 줄이 `CREATE INDEX`문의 정상 종결(`;`)인지 육안 확인. 혼입 시 해당 줄 수동 삭제.

기대 SQL 골자:
```sql
CREATE TABLE `multi_arb_opportunities` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `symbol` VARCHAR(191) NOT NULL,
    `currencyZone` VARCHAR(191) NOT NULL,
    `buyExchange` VARCHAR(191) NOT NULL,
    `buyPrice` DOUBLE NOT NULL,
    `sellExchange` VARCHAR(191) NOT NULL,
    `sellPrice` DOUBLE NOT NULL,
    `spreadPct` DOUBLE NOT NULL,
    `feasibility` VARCHAR(191) NOT NULL,
    `networkMatch` BOOLEAN NULL,
    `matchedNetwork` VARCHAR(191) NULL,
    `note` VARCHAR(191) NULL,
    `kimchiPct` DOUBLE NULL,
    `detectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `notifiedAt` DATETIME(3) NULL,
    INDEX `multi_arb_opportunities_symbol_currencyZone_notifiedAt_idx`(`symbol`, `currencyZone`, `notifiedAt`),
    INDEX `multi_arb_opportunities_detectedAt_idx`(`detectedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### Step 2.3: dev DB 적용 + client 재생성

⚠️ 실행 전 `.env`의 `DATABASE_URL`이 **dev DB**(Docker)를 가리키는지 확인 (production 금지 — 2026-06-21 사고 규칙). production 적용은 배포 워크플로우의 `prisma migrate deploy`가 담당.

```bash
node -e "require('dotenv').config(); const u=process.env.DATABASE_URL||''; console.log(u.includes('localhost')||u.includes('127.0.0.1') ? 'DEV OK' : 'STOP: production 의심 — 사용자 확인 필요')"
npx prisma migrate dev
npx prisma generate
```
기대 출력: `DEV OK` → `migrate dev` 적용 성공, `Generated Prisma Client`.

### Step 2.4: mock 테이블 추가

`__mocks__/database.ts`의 `prisma` 객체 (마지막 `listingAutoOrder` 항목 뒤)에 추가:

```typescript
  // 멀티 거래소 차익 기회 이력 (쿨다운 조회 + 발송 기록)
  multiArbOpportunity: {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
  },
```

### Step 2.5: 확인 + 커밋

```bash
npx tsc --noEmit
npx jest
```
기대 출력: 타입 에러 0, 기존 테스트 전부 PASS.

```bash
git add prisma/schema.prisma prisma/migrations __mocks__/database.ts
git commit -m "feat: MultiArbOpportunity 모델 및 마이그레이션 추가"
```

---

## Task 3: 공용 타입 + WalletStatusProvider (5개 거래소, 5분 캐시)

**Files:**
- Create: `src/services/multi-arb-types.ts`
- Create: `src/services/multi-arb-wallet-status.service.ts`
- Test: `__tests__/services/multi-arb-wallet-status.test.ts`

### Step 3.1: 공용 타입 먼저 작성 (테스트가 import하므로 선행)

`src/services/multi-arb-types.ts` 생성:

```typescript
// 멀티 거래소 차익거래 알림 — 공용 타입/상수 (spec 2026-09-14 §4~§6)

export type MultiArbExchange = 'upbit' | 'bithumb' | 'binance' | 'mexc' | 'gateio';
export type CurrencyZone = 'KRW' | 'USDT';

// 통화권별 소속 거래소 (spec §5: KRW권 = 업비트·빗썸 / USDT권 = 바이낸스·MEXC·Gate.io)
export const KRW_ZONE_EXCHANGES: MultiArbExchange[] = ['upbit', 'bithumb'];
export const USDT_ZONE_EXCHANGES: MultiArbExchange[] = ['binance', 'mexc', 'gateio'];

// 거래소 한글 표기 (카카오톡 메시지용)
export const EXCHANGE_LABELS: Record<MultiArbExchange, string> = {
  upbit: '업비트',
  bithumb: '빗썸',
  binance: '바이낸스',
  mexc: 'MEXC',
  gateio: 'Gate.io',
};

// 코인 1개의 특정 네트워크 입출금 상태 (정규화 후)
export interface NetworkStatus {
  network: string;          // 정규화된 네트워크명 (예: "ETH", "LSK", "TRX")
  depositEnabled: boolean;
  withdrawEnabled: boolean;
}

// 거래소 1곳의 "코인 심볼 → 지원 네트워크 목록" 맵
export type WalletStatusMap = Map<string, NetworkStatus[]>;

// 거래소 1곳의 "코인 심볼 → 현재가" 맵 (통화권 단위: KRW 또는 USDT)
export type PriceMap = Map<string, number>;

// 스프레드 후보 (SpreadCalculator 출력)
export interface SpreadCandidate {
  symbol: string;
  currencyZone: CurrencyZone;
  buyExchange: MultiArbExchange;
  buyPrice: number;
  sellExchange: MultiArbExchange;
  sellPrice: number;
  spreadPct: number;        // (sell - buy) / buy * 100, 항상 > 0
}

// 실현가능성 태그 (spec §6, DB feasibility 컬럼과 동일 문자열)
export type FeasibilityTag = 'feasible' | 'network_mismatch' | 'deposit_halt' | 'notice_warning' | 'unverified';

export interface FeasibilityResult {
  feasibility: FeasibilityTag;
  networkMatch: boolean | null;   // 판정 불가(unverified) 시 null
  matchedNetwork: string | null;  // 입출금까지 정상인 교집합 네트워크 (feasible일 때)
  note: string;                   // 사람이 읽을 요약/경고 (DB note 컬럼 + 카톡 메시지)
}
```

### Step 3.2: 실패 테스트 작성

`__tests__/services/multi-arb-wallet-status.test.ts` 생성 (spec §3의 실측 응답 형식 기반):

```typescript
// WalletStatusProvider 파싱 테스트 — 각 거래소 응답 형식 → 정규화 맵 변환 (spec §11)
import {
  parseBinanceWalletConfig,
  parseMexcWalletConfig,
  parseUpbitWalletStatus,
  parseBithumbWalletStatus,
  parseGateioCurrencies,
  normalizeNetwork,
} from '../../src/services/multi-arb-wallet-status.service';

describe('normalizeNetwork', () => {
  it('별칭을 정규화한다 (ERC20→ETH, TRC20→TRX, BEP20→BSC, LISK→LSK)', () => {
    expect(normalizeNetwork('ERC20')).toBe('ETH');
    expect(normalizeNetwork('erc20')).toBe('ETH');
    expect(normalizeNetwork('TRC20')).toBe('TRX');
    expect(normalizeNetwork('BEP20')).toBe('BSC');
    expect(normalizeNetwork('LISK')).toBe('LSK');
    expect(normalizeNetwork('ETH')).toBe('ETH');   // 이미 정규형이면 그대로
    expect(normalizeNetwork('SOL')).toBe('SOL');   // 미등록 네트워크는 대문자 그대로
  });
});

describe('parseBinanceWalletConfig', () => {
  it('networkList를 NetworkStatus[]로 변환한다 (spec §3: LSK=ETH망 실측)', () => {
    const rows = [
      {
        coin: 'LSK',
        networkList: [{ network: 'ETH', depositEnable: true, withdrawEnable: true, withdrawFee: '1.03' }],
      },
      {
        coin: 'BTC',
        networkList: [
          { network: 'BTC', depositEnable: true, withdrawEnable: false },
          { network: 'BSC', depositEnable: false, withdrawEnable: true },
        ],
      },
    ];
    const map = parseBinanceWalletConfig(rows);
    expect(map.get('LSK')).toEqual([{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }]);
    expect(map.get('BTC')).toEqual([
      { network: 'BTC', depositEnabled: true, withdrawEnabled: false },
      { network: 'BSC', depositEnabled: false, withdrawEnabled: true },
    ]);
  });
});

describe('parseMexcWalletConfig', () => {
  it('netWork(구 필드명)와 network 둘 다 처리한다', () => {
    const rows = [
      { coin: 'USDT', networkList: [{ netWork: 'TRC20', depositEnable: true, withdrawEnable: true }] },
      { coin: 'ETH', networkList: [{ network: 'ERC20', depositEnable: true, withdrawEnable: false }] },
    ];
    const map = parseMexcWalletConfig(rows);
    expect(map.get('USDT')).toEqual([{ network: 'TRX', depositEnabled: true, withdrawEnabled: true }]);
    expect(map.get('ETH')).toEqual([{ network: 'ETH', depositEnabled: true, withdrawEnabled: false }]);
  });
});

describe('parseUpbitWalletStatus / parseBithumbWalletStatus', () => {
  // spec §3: GET /v1/status/wallet → { currency, net_type, wallet_state, block_state }
  const rows = [
    { currency: 'LSK', net_type: 'LSK', wallet_state: 'working', block_state: 'normal' },
    { currency: 'BTC', net_type: 'BTC', wallet_state: 'withdraw_only', block_state: 'normal' },
    { currency: 'XRP', net_type: 'XRP', wallet_state: 'deposit_only', block_state: 'normal' },
    { currency: 'DOGE', net_type: 'DOGE', wallet_state: 'paused', block_state: 'inactive' },
  ];

  it('wallet_state를 입출금 가능 여부로 변환한다', () => {
    const map = parseUpbitWalletStatus(rows);
    expect(map.get('LSK')).toEqual([{ network: 'LSK', depositEnabled: true, withdrawEnabled: true }]);
    expect(map.get('BTC')).toEqual([{ network: 'BTC', depositEnabled: false, withdrawEnabled: true }]);
    expect(map.get('XRP')).toEqual([{ network: 'XRP', depositEnabled: true, withdrawEnabled: false }]);
    expect(map.get('DOGE')).toEqual([{ network: 'DOGE', depositEnabled: false, withdrawEnabled: false }]);
  });

  it('같은 코인의 멀티 net_type 행을 누적한다 (빗썸 LSK=ETH망 사례)', () => {
    const map = parseBithumbWalletStatus([
      { currency: 'USDT', net_type: 'TRX', wallet_state: 'working' },
      { currency: 'USDT', net_type: 'ETH', wallet_state: 'working' },
      { currency: 'LSK', net_type: 'ETH', wallet_state: 'working' },
    ]);
    expect(map.get('USDT')).toHaveLength(2);
    expect(map.get('LSK')).toEqual([{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }]);
  });
});

describe('parseGateioCurrencies', () => {
  it('chains 배열이 있으면 체인별 상태로 변환한다', () => {
    const rows = [
      {
        currency: 'USDT',
        chains: [
          { name: 'ETH', deposit_disabled: false, withdraw_disabled: false },
          { name: 'TRX', deposit_disabled: true, withdraw_disabled: false },
        ],
      },
    ];
    const map = parseGateioCurrencies(rows);
    expect(map.get('USDT')).toEqual([
      { network: 'ETH', depositEnabled: true, withdrawEnabled: true },
      { network: 'TRX', depositEnabled: false, withdrawEnabled: true },
    ]);
  });

  it('chains가 없으면 chain 단일 필드 + 코인 레벨 disabled 플래그로 변환한다', () => {
    const rows = [{ currency: 'LSK', chain: 'LSK', deposit_disabled: false, withdraw_disabled: true }];
    const map = parseGateioCurrencies(rows);
    expect(map.get('LSK')).toEqual([{ network: 'LSK', depositEnabled: true, withdrawEnabled: false }]);
  });
});
```

### Step 3.3: 실패 확인

```bash
npx jest __tests__/services/multi-arb-wallet-status.test.ts
```
기대 출력: `Cannot find module '../../src/services/multi-arb-wallet-status.service'` — FAIL.

### Step 3.4: 구현

`src/services/multi-arb-wallet-status.service.ts` 생성:

```typescript
// 거래소별 코인 입출금 상태 + 네트워크 맵 제공자 (spec §4 WalletStatusProvider, §6 필터 입력)
// capital/config·status/wallet은 전체를 한 번에 반환하므로 거래소당 1콜 → 5분 통째 캐시 (spec §9)
import axios from 'axios';
import { signedGet, generateUpbitJwt, BINANCE, MEXC } from './exchange/exchange-signer';
import { generateBithumbJwt } from './exchange/bithumb-client';
import { getAdminCreds } from './admin-credentials';
import { MultiArbExchange, NetworkStatus, WalletStatusMap } from './multi-arb-types';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5분 (spec §9: 5~10분 캐시)
const HTTP_TIMEOUT_MS = 10000;

// 네트워크명 별칭 → 정규형 (거래소마다 표기가 달라 교집합 판정 전 통일)
const NETWORK_ALIASES: Record<string, string> = {
  ERC20: 'ETH',
  ETHEREUM: 'ETH',
  TRC20: 'TRX',
  TRON: 'TRX',
  BEP20: 'BSC',
  'BEP20(BSC)': 'BSC',
  LISK: 'LSK',
};

export function normalizeNetwork(raw: string): string {
  const key = String(raw ?? '').trim().toUpperCase();
  return NETWORK_ALIASES[key] ?? key;
}

// ── 거래소별 응답 파싱 (순수함수 — 단위테스트 대상) ─────────────────────────

// Binance GET /sapi/v1/capital/config/getall (spec §3 실측: 744개 코인)
export function parseBinanceWalletConfig(rows: any[]): WalletStatusMap {
  const map: WalletStatusMap = new Map();
  for (const row of rows ?? []) {
    if (!row?.coin || !Array.isArray(row.networkList)) continue;
    map.set(String(row.coin).toUpperCase(), row.networkList.map((n: any): NetworkStatus => ({
      network: normalizeNetwork(n.network),
      depositEnabled: !!n.depositEnable,
      withdrawEnabled: !!n.withdrawEnable,
    })));
  }
  return map;
}

// MEXC GET /api/v3/capital/config/getall (spec §3 실측: 9,539개 코인)
// 구버전 응답은 network 대신 netWork 필드 사용 → 둘 다 처리
export function parseMexcWalletConfig(rows: any[]): WalletStatusMap {
  const map: WalletStatusMap = new Map();
  for (const row of rows ?? []) {
    if (!row?.coin || !Array.isArray(row.networkList)) continue;
    map.set(String(row.coin).toUpperCase(), row.networkList.map((n: any): NetworkStatus => ({
      network: normalizeNetwork(n.network ?? n.netWork),
      depositEnabled: !!n.depositEnable,
      withdrawEnabled: !!n.withdrawEnable,
    })));
  }
  return map;
}

// 업비트/빗썸 GET /v1/status/wallet → [{ currency, net_type, wallet_state, block_state }]
// wallet_state: working(입출금 정상) | withdraw_only | deposit_only | paused | unsupported
function parseKrwWalletStatus(rows: any[]): WalletStatusMap {
  const map: WalletStatusMap = new Map();
  for (const row of rows ?? []) {
    if (!row?.currency) continue;
    const symbol = String(row.currency).toUpperCase();
    const state = String(row.wallet_state ?? '');
    const entry: NetworkStatus = {
      network: normalizeNetwork(row.net_type ?? symbol),
      depositEnabled: state === 'working' || state === 'deposit_only',
      withdrawEnabled: state === 'working' || state === 'withdraw_only',
    };
    const existing = map.get(symbol);
    // 멀티 net_type 코인 (예: USDT TRX/ETH) 누적 — 불변 패턴
    map.set(symbol, existing ? [...existing, entry] : [entry]);
  }
  return map;
}

export function parseUpbitWalletStatus(rows: any[]): WalletStatusMap {
  return parseKrwWalletStatus(rows);
}

export function parseBithumbWalletStatus(rows: any[]): WalletStatusMap {
  return parseKrwWalletStatus(rows);
}

// Gate.io GET /api/v4/spot/currencies (public) → [{ currency, chains?: [...], chain?, deposit_disabled, withdraw_disabled }]
export function parseGateioCurrencies(rows: any[]): WalletStatusMap {
  const map: WalletStatusMap = new Map();
  for (const row of rows ?? []) {
    if (!row?.currency) continue;
    const symbol = String(row.currency).toUpperCase();
    let entries: NetworkStatus[];
    if (Array.isArray(row.chains) && row.chains.length > 0) {
      entries = row.chains.map((c: any): NetworkStatus => ({
        network: normalizeNetwork(c.name),
        depositEnabled: !c.deposit_disabled,
        withdrawEnabled: !c.withdraw_disabled,
      }));
    } else {
      entries = [{
        network: normalizeNetwork(row.chain ?? symbol),
        depositEnabled: !row.deposit_disabled,
        withdrawEnabled: !row.withdraw_disabled,
      }];
    }
    map.set(symbol, entries);
  }
  return map;
}

// ── 서비스 (조회 + 캐시) ─────────────────────────────────────────────────────

class MultiArbWalletStatusService {
  private cache: Map<MultiArbExchange, { at: number; map: WalletStatusMap }> = new Map();

  // 5개 거래소 지갑 상태를 병렬 조회 (실패 거래소는 결과에서 제외 → FeasibilityFilter가 unverified 처리)
  async getAll(): Promise<Partial<Record<MultiArbExchange, WalletStatusMap>>> {
    const exchanges: MultiArbExchange[] = ['upbit', 'bithumb', 'binance', 'mexc', 'gateio'];
    const results = await Promise.allSettled(exchanges.map(ex => this.getForExchange(ex)));

    const out: Partial<Record<MultiArbExchange, WalletStatusMap>> = {};
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value !== null) {
        out[exchanges[i]] = r.value;
      } else if (r.status === 'rejected') {
        console.error(`[MultiArbWalletStatus] ${exchanges[i]} 지갑 상태 조회 실패:`, r.reason?.message ?? r.reason);
      }
    });
    return out;
  }

  private async getForExchange(exchange: MultiArbExchange): Promise<WalletStatusMap | null> {
    const cached = this.cache.get(exchange);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.map;

    const map = await this.fetchForExchange(exchange);
    if (map === null) return null; // 자격증명 없음 — 캐시하지 않음
    this.cache.set(exchange, { at: Date.now(), map });
    return map;
  }

  private async fetchForExchange(exchange: MultiArbExchange): Promise<WalletStatusMap | null> {
    switch (exchange) {
      case 'binance': {
        const cred = await getAdminCreds('binance');
        if (!cred) return null;
        const data = await signedGet(BINANCE.baseUrl, BINANCE.apiKeyHeader, cred.apiKey, cred.secretKey, '/sapi/v1/capital/config/getall');
        return parseBinanceWalletConfig(data);
      }
      case 'mexc': {
        const cred = await getAdminCreds('mexc');
        if (!cred) return null;
        const data = await signedGet(MEXC.baseUrl, MEXC.apiKeyHeader, cred.apiKey, cred.secretKey, '/api/v3/capital/config/getall');
        return parseMexcWalletConfig(data);
      }
      case 'upbit': {
        const cred = await getAdminCreds('upbit');
        if (!cred) return null;
        const res = await axios.get('https://api.upbit.com/v1/status/wallet', {
          headers: { Authorization: `Bearer ${generateUpbitJwt(cred.apiKey, cred.secretKey)}` },
          timeout: HTTP_TIMEOUT_MS,
        });
        return parseUpbitWalletStatus(res.data);
      }
      case 'bithumb': {
        const cred = await getAdminCreds('bithumb');
        if (!cred) return null;
        const res = await axios.get('https://api.bithumb.com/v1/status/wallet', {
          headers: { Authorization: `Bearer ${generateBithumbJwt(cred.apiKey, cred.secretKey)}` },
          timeout: HTTP_TIMEOUT_MS,
        });
        return parseBithumbWalletStatus(res.data);
      }
      case 'gateio': {
        // /api/v4/spot/currencies는 public — 서명 불필요 (spec §3의 currency_chains 대신 전체 1콜 버전)
        const res = await axios.get('https://api.gateio.ws/api/v4/spot/currencies', { timeout: HTTP_TIMEOUT_MS });
        return parseGateioCurrencies(res.data);
      }
    }
  }
}

export const multiArbWalletStatusService = new MultiArbWalletStatusService();
```

### Step 3.5: 통과 확인 + 커밋

```bash
npx jest __tests__/services/multi-arb-wallet-status.test.ts
npx tsc --noEmit
```
기대 출력: `Tests: 7 passed`, 타입 에러 0.

```bash
git add src/services/multi-arb-types.ts src/services/multi-arb-wallet-status.service.ts __tests__/services/multi-arb-wallet-status.test.ts
git commit -m "feat: 멀티차익 지갑상태 제공자 및 공용 타입 추가"
```

---

## Task 4: ExchangePriceSource (배치 시세 어댑터)

**Files:**
- Create: `src/services/multi-arb-price-source.service.ts`
- Test: `__tests__/services/multi-arb-price-source.test.ts`

> 설계 노트: 기존 `upbit-listing-monitor.service.ts`의 `fetchBinancePrice(ticker)` / `fetchMexcPrice(ticker)` / `fetchGateioPrice(ticker)`(L661~746)는 **코인 1개씩** 조회하는 `private` 메서드이고 반환형이 `ExchangePriceResult`(L17~22, `{ exchange, price, volume24h }`)라 전 종목 스캔(수백 심볼/60초)에 부적합하다. 동일한 public 엔드포인트 계열의 **배치 버전**(전 종목 1콜)을 이 모듈에 구현한다. 기존 파일은 수정하지 않는다 (외과적 변경 원칙).

### Step 4.1: 실패 테스트 작성

`__tests__/services/multi-arb-price-source.test.ts` 생성:

```typescript
// 배치 시세 응답 파싱 테스트 (axios 모킹)
import axios from 'axios';
import { multiArbPriceSource } from '../../src/services/multi-arb-price-source.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('multiArbPriceSource', () => {
  beforeEach(() => jest.resetAllMocks());

  it('fetchUpbit: 청크 조회 후 base 심볼 → 가격 맵을 만든다', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: [
        { market: 'KRW-BTC', trade_price: 100000000 },
        { market: 'KRW-LSK', trade_price: 533 },
      ],
    });
    const map = await multiArbPriceSource.fetchUpbit(['BTC', 'LSK']);
    expect(map.get('BTC')).toBe(100000000);
    expect(map.get('LSK')).toBe(533);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v1/ticker?markets=KRW-BTC,KRW-LSK'),
      expect.anything(),
    );
  });

  it('fetchBithumb: ALL_KRW 응답에서 date 키를 제외하고 맵을 만든다', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        status: '0000',
        data: {
          BTC: { closing_price: '100000000' },
          LSK: { closing_price: '1322' },
          date: '1726300000000',
        },
      },
    });
    const map = await multiArbPriceSource.fetchBithumb();
    expect(map.get('BTC')).toBe(100000000);
    expect(map.get('LSK')).toBe(1322);
    expect(map.has('DATE')).toBe(false);
  });

  it('fetchBinance: USDT 페어만 base 심볼로 변환한다', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: [
        { symbol: 'BTCUSDT', price: '65000' },
        { symbol: 'ETHBTC', price: '0.05' },
        { symbol: 'LSKUSDT', price: '0.72' },
      ],
    });
    const map = await multiArbPriceSource.fetchBinance();
    expect(map.get('BTC')).toBe(65000);
    expect(map.get('LSK')).toBe(0.72);
    expect(map.has('ETH')).toBe(false); // ETHBTC는 USDT 페어 아님
  });

  it('fetchGateio: currency_pair에서 _USDT 페어만 파싱한다', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: [
        { currency_pair: 'BTC_USDT', last: '65010' },
        { currency_pair: 'BTC_ETH', last: '20' },
      ],
    });
    const map = await multiArbPriceSource.fetchGateio();
    expect(map.get('BTC')).toBe(65010);
    expect(map.size).toBe(1);
  });

  it('fetchAllPrices: 한 거래소 실패해도 나머지는 반환한다 (spec §9)', async () => {
    mockedAxios.get.mockImplementation(((url: string) => {
      if (url.includes('api.upbit.com/v1/ticker')) return Promise.reject(new Error('upbit down'));
      if (url.includes('api.bithumb.com')) {
        return Promise.resolve({ data: { status: '0000', data: { BTC: { closing_price: '100000000' }, date: '1' } } });
      }
      if (url.includes('api.binance.com')) return Promise.resolve({ data: [{ symbol: 'BTCUSDT', price: '65000' }] });
      if (url.includes('api.mexc.com')) return Promise.resolve({ data: [{ symbol: 'BTCUSDT', price: '64990' }] });
      if (url.includes('api.gateio.ws')) return Promise.resolve({ data: [{ currency_pair: 'BTC_USDT', last: '65010' }] });
      return Promise.reject(new Error('unexpected url: ' + url));
    }) as any);
    const prices = await multiArbPriceSource.fetchAllPrices(['BTC']);
    expect(prices.upbit).toBeUndefined();
    expect(prices.bithumb!.get('BTC')).toBe(100000000);
    expect(prices.binance!.get('BTC')).toBe(65000);
    expect(prices.mexc!.get('BTC')).toBe(64990);
    expect(prices.gateio!.get('BTC')).toBe(65010);
  });

  it('getKrwPerUsdt: 업비트 KRW-USDT 시세를 반환하고 실패 시 null', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: [{ market: 'KRW-USDT', trade_price: 1385 }] });
    expect(await multiArbPriceSource.getKrwPerUsdt()).toBe(1385);
    mockedAxios.get.mockRejectedValueOnce(new Error('down'));
    expect(await multiArbPriceSource.getKrwPerUsdt()).toBeNull();
  });
});
```

### Step 4.2: 실패 확인

```bash
npx jest __tests__/services/multi-arb-price-source.test.ts
```
기대 출력: `Cannot find module '../../src/services/multi-arb-price-source.service'` — FAIL.

### Step 4.3: 구현

`src/services/multi-arb-price-source.service.ts` 생성:

```typescript
// 거래소별 배치 시세 조회 어댑터 (spec §4 ExchangePriceSource)
// 전 종목 스캔이므로 코인별 개별 호출 금지 — 거래소당 1~수 콜의 배치 엔드포인트만 사용 (모두 public, 인증 불필요)
import axios from 'axios';
import { MultiArbExchange, PriceMap } from './multi-arb-types';

const HTTP_TIMEOUT_MS = 10000;
const UPBIT_TICKER_CHUNK = 100; // 업비트 /v1/ticker markets 파라미터 안전 상한

class MultiArbPriceSourceService {
  // 업비트: GET /v1/ticker?markets=KRW-A,KRW-B,... (100개 청크)
  async fetchUpbit(symbols: string[]): Promise<PriceMap> {
    const map: PriceMap = new Map();
    for (let i = 0; i < symbols.length; i += UPBIT_TICKER_CHUNK) {
      const chunk = symbols.slice(i, i + UPBIT_TICKER_CHUNK);
      const markets = chunk.map(s => `KRW-${s}`).join(',');
      const res = await axios.get(`https://api.upbit.com/v1/ticker?markets=${markets}`, { timeout: HTTP_TIMEOUT_MS });
      for (const item of res.data ?? []) {
        const price = Number(item.trade_price);
        if (typeof item.market === 'string' && item.market.startsWith('KRW-') && price > 0) {
          map.set(item.market.slice(4), price);
        }
      }
    }
    return map;
  }

  // 빗썸: GET /public/ticker/ALL_KRW (1콜)
  async fetchBithumb(): Promise<PriceMap> {
    const res = await axios.get('https://api.bithumb.com/public/ticker/ALL_KRW', { timeout: HTTP_TIMEOUT_MS });
    if (res.data?.status !== '0000') throw new Error(`Bithumb ALL_KRW 응답 오류: status=${res.data?.status}`);
    const map: PriceMap = new Map();
    for (const [key, value] of Object.entries<any>(res.data.data ?? {})) {
      if (key === 'date') continue; // 응답에 섞여 있는 타임스탬프 키
      const price = parseFloat(value?.closing_price);
      if (price > 0) map.set(key.toUpperCase(), price);
    }
    return map;
  }

  // 바이낸스: GET /api/v3/ticker/price (전 종목 1콜) → *USDT만
  async fetchBinance(): Promise<PriceMap> {
    const res = await axios.get('https://api.binance.com/api/v3/ticker/price', { timeout: HTTP_TIMEOUT_MS });
    return this.parseUsdtSymbolArray(res.data);
  }

  // MEXC: GET /api/v3/ticker/price (바이낸스 호환 포맷)
  async fetchMexc(): Promise<PriceMap> {
    const res = await axios.get('https://api.mexc.com/api/v3/ticker/price', { timeout: HTTP_TIMEOUT_MS });
    return this.parseUsdtSymbolArray(res.data);
  }

  // Gate.io: GET /api/v4/spot/tickers (전 종목 1콜) → *_USDT만
  async fetchGateio(): Promise<PriceMap> {
    const res = await axios.get('https://api.gateio.ws/api/v4/spot/tickers', { timeout: HTTP_TIMEOUT_MS });
    const map: PriceMap = new Map();
    for (const item of res.data ?? []) {
      const pair = String(item.currency_pair ?? '');
      if (!pair.endsWith('_USDT')) continue;
      const price = parseFloat(item.last);
      if (price > 0) map.set(pair.slice(0, -5).toUpperCase(), price);
    }
    return map;
  }

  // 5개 거래소 병렬 조회 — 실패 거래소는 키 자체를 제외 (spec §9: 하나 실패해도 나머지 진행)
  async fetchAllPrices(upbitSymbols: string[]): Promise<Partial<Record<MultiArbExchange, PriceMap>>> {
    const exchanges: MultiArbExchange[] = ['upbit', 'bithumb', 'binance', 'mexc', 'gateio'];
    const results = await Promise.allSettled([
      this.fetchUpbit(upbitSymbols),
      this.fetchBithumb(),
      this.fetchBinance(),
      this.fetchMexc(),
      this.fetchGateio(),
    ]);
    const out: Partial<Record<MultiArbExchange, PriceMap>> = {};
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        out[exchanges[i]] = r.value;
      } else {
        console.error(`[MultiArbPriceSource] ${exchanges[i]} 시세 조회 실패:`, r.reason?.message ?? r.reason);
      }
    });
    return out;
  }

  // 김프 환산용 KRW/USDT 환율 (업비트 KRW-USDT, spec §5 step 7) — 실패 시 null (김프 표시는 참고용)
  async getKrwPerUsdt(): Promise<number | null> {
    try {
      const res = await axios.get('https://api.upbit.com/v1/ticker?markets=KRW-USDT', { timeout: 5000 });
      const price = Number(res.data?.[0]?.trade_price);
      return price > 0 ? price : null;
    } catch {
      return null;
    }
  }

  // 바이낸스/MEXC 공통: [{ symbol: 'BTCUSDT', price: '65000' }] → base 맵
  private parseUsdtSymbolArray(rows: any[]): PriceMap {
    const map: PriceMap = new Map();
    for (const item of rows ?? []) {
      const symbol = String(item.symbol ?? '');
      if (!symbol.endsWith('USDT')) continue;
      const price = parseFloat(item.price);
      if (price > 0) map.set(symbol.slice(0, -4).toUpperCase(), price);
    }
    return map;
  }
}

export const multiArbPriceSource = new MultiArbPriceSourceService();
```

### Step 4.4: 통과 확인 + 커밋

```bash
npx jest __tests__/services/multi-arb-price-source.test.ts
npx tsc --noEmit
```
기대 출력: `Tests: 6 passed`, 타입 에러 0.

```bash
git add src/services/multi-arb-price-source.service.ts __tests__/services/multi-arb-price-source.test.ts
git commit -m "feat: 멀티차익 배치 시세 어댑터 추가"
```

---

## Task 5: SymbolUniverse (공통 상장 교집합, 1시간 캐시)

**Files:**
- Create: `src/services/multi-arb-symbol-universe.service.ts`
- Test: `__tests__/services/multi-arb-symbol-universe.test.ts`

### Step 5.1: 실패 테스트 작성

`__tests__/services/multi-arb-symbol-universe.test.ts` 생성:

```typescript
// 통화권별 공통 상장 교집합 계산 테스트 (순수함수)
import { computeUniverse, UniverseSets } from '../../src/services/multi-arb-symbol-universe.service';

function sets(partial: Partial<Record<keyof UniverseSets, string[]>>): UniverseSets {
  return {
    upbit: new Set(partial.upbit ?? []),
    bithumb: new Set(partial.bithumb ?? []),
    binance: new Set(partial.binance ?? []),
    mexc: new Set(partial.mexc ?? []),
    gateio: new Set(partial.gateio ?? []),
  };
}

describe('computeUniverse', () => {
  it('KRW권 = 업비트 ∩ 빗썸', () => {
    const u = computeUniverse(sets({
      upbit: ['BTC', 'LSK', 'WLD'],
      bithumb: ['BTC', 'LSK', 'DOGE'],
    }));
    expect(u.krw).toEqual(['BTC', 'LSK']);
  });

  it('USDT권 = 바이낸스/MEXC/Gate.io 중 2곳 이상 상장 (쌍이 성립해야 비교 가능)', () => {
    const u = computeUniverse(sets({
      binance: ['BTC', 'ETH'],
      mexc: ['BTC', 'PEPE'],
      gateio: ['ETH', 'PEPE', 'RARE'],
    }));
    // BTC: binance+mexc / ETH: binance+gateio / PEPE: mexc+gateio → 포함. RARE: gateio 단독 → 제외
    expect(u.usdt).toEqual(['BTC', 'ETH', 'PEPE']);
  });

  it('한쪽 통화권이 비어도 다른 통화권은 계산된다', () => {
    const u = computeUniverse(sets({ upbit: ['BTC'], bithumb: ['BTC'] }));
    expect(u.krw).toEqual(['BTC']);
    expect(u.usdt).toEqual([]);
  });
});
```

### Step 5.2: 실패 확인

```bash
npx jest __tests__/services/multi-arb-symbol-universe.test.ts
```
기대 출력: `Cannot find module` — FAIL.

### Step 5.3: 구현

`src/services/multi-arb-symbol-universe.service.ts` 생성:

```typescript
// 거래소별 상장 목록 → 통화권별 공통 심볼 교집합 (spec §4 SymbolUniverse, §5 step 1)
// 상장 목록은 자주 변하지 않으므로 1시간 캐시 (spec §9)
import axios from 'axios';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1시간
const HTTP_TIMEOUT_MS = 10000;

export interface UniverseSets {
  upbit: Set<string>;
  bithumb: Set<string>;
  binance: Set<string>;
  mexc: Set<string>;
  gateio: Set<string>;
}

export interface SymbolUniverseResult {
  krw: string[];   // 업비트 ∩ 빗썸 (KRW 마켓)
  usdt: string[];  // 바이낸스/MEXC/Gate.io 중 2곳 이상 상장 (USDT 마켓)
}

// 순수함수 — 단위테스트 대상
export function computeUniverse(sets: UniverseSets): SymbolUniverseResult {
  const krw = [...sets.upbit].filter(s => sets.bithumb.has(s)).sort();

  // USDT권: 최저매수↔최고매도 "쌍"이 성립하려면 통화권 내 2곳 이상 상장 필요
  const counts = new Map<string, number>();
  for (const ex of ['binance', 'mexc', 'gateio'] as const) {
    for (const s of sets[ex]) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const usdt = [...counts.entries()].filter(([, c]) => c >= 2).map(([s]) => s).sort();

  return { krw, usdt };
}

class MultiArbSymbolUniverseService {
  private cache: { at: number; universe: SymbolUniverseResult } | null = null;

  async getUniverse(): Promise<SymbolUniverseResult> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.universe;

    const [upbit, bithumb, binance, mexc, gateio] = await Promise.all([
      this.fetchUpbitKrwSymbols(),
      this.fetchBithumbKrwSymbols(),
      this.fetchBinanceUsdtSymbols(),
      this.fetchMexcUsdtSymbols(),
      this.fetchGateioUsdtSymbols(),
    ]);

    const universe = computeUniverse({ upbit, bithumb, binance, mexc, gateio });
    this.cache = { at: Date.now(), universe };
    console.log(`[MultiArbSymbolUniverse] 갱신: KRW권 ${universe.krw.length}개, USDT권 ${universe.usdt.length}개`);
    return universe;
  }

  private async fetchUpbitKrwSymbols(): Promise<Set<string>> {
    const res = await axios.get('https://api.upbit.com/v1/market/all?is_details=false', { timeout: HTTP_TIMEOUT_MS });
    return new Set(
      (res.data ?? [])
        .map((m: any) => String(m.market ?? ''))
        .filter((m: string) => m.startsWith('KRW-'))
        .map((m: string) => m.slice(4).toUpperCase()),
    );
  }

  private async fetchBithumbKrwSymbols(): Promise<Set<string>> {
    const res = await axios.get('https://api.bithumb.com/public/ticker/ALL_KRW', { timeout: HTTP_TIMEOUT_MS });
    if (res.data?.status !== '0000') throw new Error(`Bithumb ALL_KRW 응답 오류: status=${res.data?.status}`);
    return new Set(Object.keys(res.data.data ?? {}).filter(k => k !== 'date').map(k => k.toUpperCase()));
  }

  private async fetchBinanceUsdtSymbols(): Promise<Set<string>> {
    const res = await axios.get('https://api.binance.com/api/v3/ticker/price', { timeout: HTTP_TIMEOUT_MS });
    return this.usdtBases(res.data, 'symbol', 'USDT');
  }

  private async fetchMexcUsdtSymbols(): Promise<Set<string>> {
    const res = await axios.get('https://api.mexc.com/api/v3/ticker/price', { timeout: HTTP_TIMEOUT_MS });
    return this.usdtBases(res.data, 'symbol', 'USDT');
  }

  private async fetchGateioUsdtSymbols(): Promise<Set<string>> {
    const res = await axios.get('https://api.gateio.ws/api/v4/spot/tickers', { timeout: HTTP_TIMEOUT_MS });
    return this.usdtBases(res.data, 'currency_pair', '_USDT');
  }

  private usdtBases(rows: any[], field: string, suffix: string): Set<string> {
    return new Set(
      (rows ?? [])
        .map((r: any) => String(r[field] ?? ''))
        .filter((s: string) => s.endsWith(suffix))
        .map((s: string) => s.slice(0, -suffix.length).toUpperCase()),
    );
  }
}

export const multiArbSymbolUniverseService = new MultiArbSymbolUniverseService();
```

### Step 5.4: 통과 확인 + 커밋

```bash
npx jest __tests__/services/multi-arb-symbol-universe.test.ts
npx tsc --noEmit
```
기대 출력: `Tests: 3 passed`, 타입 에러 0.

```bash
git add src/services/multi-arb-symbol-universe.service.ts __tests__/services/multi-arb-symbol-universe.test.ts
git commit -m "feat: 멀티차익 공통상장 심볼 교집합 서비스 추가"
```

---

## Task 6: SpreadCalculator (순수 계산)

**Files:**
- Create: `src/services/multi-arb-spread-calculator.ts`
- Test: `__tests__/services/multi-arb-spread-calculator.test.ts`

### Step 6.1: 실패 테스트 작성

`__tests__/services/multi-arb-spread-calculator.test.ts` 생성 (spec §11: 모킹 시세로 최저매수/최고매도 쌍 선택 검증):

```typescript
import { calculateSpreads } from '../../src/services/multi-arb-spread-calculator';
import { PriceMap, MultiArbExchange, KRW_ZONE_EXCHANGES, USDT_ZONE_EXCHANGES } from '../../src/services/multi-arb-types';

function priceMap(entries: Record<string, number>): PriceMap {
  return new Map(Object.entries(entries));
}

describe('calculateSpreads', () => {
  it('KRW권: 최저 매수 거래소 ↔ 최고 매도 거래소 쌍과 스프레드%를 계산한다', () => {
    const prices: Partial<Record<MultiArbExchange, PriceMap>> = {
      upbit: priceMap({ WLD: 4340 }),
      bithumb: priceMap({ WLD: 4200 }),
    };
    const [c] = calculateSpreads('KRW', ['WLD'], prices, KRW_ZONE_EXCHANGES);
    expect(c.symbol).toBe('WLD');
    expect(c.currencyZone).toBe('KRW');
    expect(c.buyExchange).toBe('bithumb');
    expect(c.buyPrice).toBe(4200);
    expect(c.sellExchange).toBe('upbit');
    expect(c.sellPrice).toBe(4340);
    expect(c.spreadPct).toBeCloseTo(((4340 - 4200) / 4200) * 100, 6); // ≈ 3.33%
  });

  it('USDT권 3거래소: 3곳 중 최저/최고를 고른다', () => {
    const prices: Partial<Record<MultiArbExchange, PriceMap>> = {
      binance: priceMap({ PEPE: 0.00001 }),
      mexc: priceMap({ PEPE: 0.0000098 }),
      gateio: priceMap({ PEPE: 0.0000105 }),
    };
    const [c] = calculateSpreads('USDT', ['PEPE'], prices, USDT_ZONE_EXCHANGES);
    expect(c.buyExchange).toBe('mexc');
    expect(c.sellExchange).toBe('gateio');
    expect(c.spreadPct).toBeCloseTo(((0.0000105 - 0.0000098) / 0.0000098) * 100, 6);
  });

  it('가격이 1곳뿐인 심볼은 제외한다', () => {
    const prices: Partial<Record<MultiArbExchange, PriceMap>> = {
      upbit: priceMap({ RARE: 100 }),
      bithumb: priceMap({}),
    };
    expect(calculateSpreads('KRW', ['RARE'], prices, KRW_ZONE_EXCHANGES)).toEqual([]);
  });

  it('전 거래소 동일 가격(스프레드 0)은 제외한다', () => {
    const prices: Partial<Record<MultiArbExchange, PriceMap>> = {
      upbit: priceMap({ BTC: 100 }),
      bithumb: priceMap({ BTC: 100 }),
    };
    expect(calculateSpreads('KRW', ['BTC'], prices, KRW_ZONE_EXCHANGES)).toEqual([]);
  });

  it('시세 조회가 실패한 거래소(키 없음)는 건너뛴다', () => {
    const prices: Partial<Record<MultiArbExchange, PriceMap>> = {
      bithumb: priceMap({ BTC: 100 }),
      // upbit 조회 실패 → 키 없음
    };
    expect(calculateSpreads('KRW', ['BTC'], prices, KRW_ZONE_EXCHANGES)).toEqual([]);
  });
});
```

### Step 6.2: 실패 확인

```bash
npx jest __tests__/services/multi-arb-spread-calculator.test.ts
```
기대 출력: `Cannot find module` — FAIL.

### Step 6.3: 구현

`src/services/multi-arb-spread-calculator.ts` 생성:

```typescript
// 같은 통화권 내 코인별 최저매수 ↔ 최고매도 쌍 스프레드 계산 (spec §4 SpreadCalculator, §5 step 3)
// 순수함수 — 외부 I/O 없음
import { CurrencyZone, MultiArbExchange, PriceMap, SpreadCandidate } from './multi-arb-types';

export function calculateSpreads(
  currencyZone: CurrencyZone,
  symbols: string[],
  prices: Partial<Record<MultiArbExchange, PriceMap>>,
  zoneExchanges: MultiArbExchange[],
): SpreadCandidate[] {
  const candidates: SpreadCandidate[] = [];

  for (const symbol of symbols) {
    // 이번 사이클에 시세가 있는 거래소만 수집 (조회 실패 거래소는 prices에 키 없음 — spec §9)
    const quotes: Array<{ exchange: MultiArbExchange; price: number }> = [];
    for (const exchange of zoneExchanges) {
      const price = prices[exchange]?.get(symbol);
      if (typeof price === 'number' && price > 0) quotes.push({ exchange, price });
    }
    if (quotes.length < 2) continue; // 비교 쌍이 성립하지 않음

    let buy = quotes[0];
    let sell = quotes[0];
    for (const q of quotes) {
      if (q.price < buy.price) buy = q;
      if (q.price > sell.price) sell = q;
    }
    if (buy.exchange === sell.exchange || sell.price <= buy.price) continue; // 스프레드 없음

    candidates.push({
      symbol,
      currencyZone,
      buyExchange: buy.exchange,
      buyPrice: buy.price,
      sellExchange: sell.exchange,
      sellPrice: sell.price,
      spreadPct: ((sell.price - buy.price) / buy.price) * 100,
    });
  }

  return candidates;
}
```

### Step 6.4: 통과 확인 + 커밋

```bash
npx jest __tests__/services/multi-arb-spread-calculator.test.ts
npx tsc --noEmit
```
기대 출력: `Tests: 5 passed`, 타입 에러 0.

```bash
git add src/services/multi-arb-spread-calculator.ts __tests__/services/multi-arb-spread-calculator.test.ts
git commit -m "feat: 멀티차익 스프레드 계산기 추가"
```

---

## Task 7: FeasibilityFilter (3단 검증 + LSK 회귀 테스트)

**Files:**
- Create: `src/services/multi-arb-feasibility-filter.ts`
- Test: `__tests__/services/multi-arb-feasibility-filter.test.ts`

### Step 7.1: 실패 테스트 작성 (LSK 회귀 테스트 필수 — spec §1, §11)

`__tests__/services/multi-arb-feasibility-filter.test.ts` 생성:

```typescript
// 실현가능성 3단 필터 테스트 (spec §6)
// ★ LSK 회귀 테스트: 2026-09-13 실사례 — 업비트 LISK 자체망 ↔ 빗썸 ETH망, 괴리 142%인데 전송 불가
import { evaluateFeasibility } from '../../src/services/multi-arb-feasibility-filter';
import { MultiArbExchange, SpreadCandidate, WalletStatusMap } from '../../src/services/multi-arb-types';

function candidate(partial: Partial<SpreadCandidate> = {}): SpreadCandidate {
  return {
    symbol: 'LSK',
    currencyZone: 'KRW',
    buyExchange: 'upbit',
    buyPrice: 533,
    sellExchange: 'bithumb',
    sellPrice: 1322,
    spreadPct: 148.03,
    ...partial,
  };
}

function wallets(partial: Partial<Record<MultiArbExchange, Record<string, Array<{ network: string; depositEnabled: boolean; withdrawEnabled: boolean }>>>>): Partial<Record<MultiArbExchange, WalletStatusMap>> {
  const out: Partial<Record<MultiArbExchange, WalletStatusMap>> = {};
  for (const [ex, coins] of Object.entries(partial)) {
    out[ex as MultiArbExchange] = new Map(Object.entries(coins!));
  }
  return out;
}

describe('evaluateFeasibility', () => {
  it('★ LSK 회귀: 업비트 LISK(LSK)망 ↔ 빗썸 ETH망 → network_mismatch (spec §1 실사례)', () => {
    const result = evaluateFeasibility(candidate(), wallets({
      upbit: { LSK: [{ network: 'LSK', depositEnabled: true, withdrawEnabled: true }] },
      bithumb: { LSK: [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }] },
    }));
    expect(result.feasibility).toBe('network_mismatch');
    expect(result.networkMatch).toBe(false);
    expect(result.matchedNetwork).toBeNull();
    expect(result.note).toContain('네트워크 불일치');
    expect(result.note).toContain('LSK');
    expect(result.note).toContain('ETH');
  });

  it('1단 통과 + 2단 통과: 양쪽 ETH망 + 매수측 출금가능 + 매도측 입금가능 → feasible', () => {
    const result = evaluateFeasibility(candidate({ symbol: 'WLD' }), wallets({
      upbit: { WLD: [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }] },
      bithumb: { WLD: [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }] },
    }));
    expect(result.feasibility).toBe('feasible');
    expect(result.networkMatch).toBe(true);
    expect(result.matchedNetwork).toBe('ETH');
  });

  it('멀티체인: 교집합 중 하나라도 (매수 출금 ∧ 매도 입금) 가능하면 feasible', () => {
    const result = evaluateFeasibility(candidate({ symbol: 'USDT' }), wallets({
      upbit: {
        USDT: [
          { network: 'TRX', depositEnabled: true, withdrawEnabled: false }, // TRX 출금 불가
          { network: 'ETH', depositEnabled: true, withdrawEnabled: true },
        ],
      },
      bithumb: {
        USDT: [
          { network: 'TRX', depositEnabled: true, withdrawEnabled: true },
          { network: 'ETH', depositEnabled: true, withdrawEnabled: true },
        ],
      },
    }));
    expect(result.feasibility).toBe('feasible');
    expect(result.matchedNetwork).toBe('ETH');
  });

  it('2단 실패: 네트워크는 일치하지만 매수측 출금 중단 → deposit_halt', () => {
    const result = evaluateFeasibility(candidate({ symbol: 'DOGE' }), wallets({
      upbit: { DOGE: [{ network: 'DOGE', depositEnabled: true, withdrawEnabled: false }] },
      bithumb: { DOGE: [{ network: 'DOGE', depositEnabled: true, withdrawEnabled: true }] },
    }));
    expect(result.feasibility).toBe('deposit_halt');
    expect(result.networkMatch).toBe(true);
    expect(result.note).toContain('입출금');
  });

  it('2단 실패: 매도측 입금 중단 → deposit_halt', () => {
    const result = evaluateFeasibility(candidate({ symbol: 'DOGE' }), wallets({
      upbit: { DOGE: [{ network: 'DOGE', depositEnabled: true, withdrawEnabled: true }] },
      bithumb: { DOGE: [{ network: 'DOGE', depositEnabled: false, withdrawEnabled: true }] },
    }));
    expect(result.feasibility).toBe('deposit_halt');
  });

  it('지갑 정보 없는 거래소가 있으면 unverified (조회 실패 사이클 — spec §9)', () => {
    const result = evaluateFeasibility(candidate(), wallets({
      upbit: { LSK: [{ network: 'LSK', depositEnabled: true, withdrawEnabled: true }] },
      // bithumb 지갑 조회 실패 → 키 없음
    }));
    expect(result.feasibility).toBe('unverified');
    expect(result.networkMatch).toBeNull();
  });

  it('거래소 맵은 있지만 해당 코인 항목이 없으면 unverified', () => {
    const result = evaluateFeasibility(candidate(), wallets({
      upbit: { LSK: [{ network: 'LSK', depositEnabled: true, withdrawEnabled: true }] },
      bithumb: {}, // LSK 항목 없음
    }));
    expect(result.feasibility).toBe('unverified');
  });
});
```

### Step 7.2: 실패 확인

```bash
npx jest __tests__/services/multi-arb-feasibility-filter.test.ts
```
기대 출력: `Cannot find module` — FAIL.

### Step 7.3: 구현

`src/services/multi-arb-feasibility-filter.ts` 생성:

```typescript
// 실현가능성 3단 필터 (spec §6)
// 1단: 매수·매도 거래소의 지원 네트워크 교집합 존재 여부 → 없으면 network_mismatch (⛔ 전송불가)
// 2단: 교집합 네트워크 중 "매수측 출금 가능 ∧ 매도측 입금 가능"이 하나라도 있는가 → 없으면 deposit_halt
// 3단: 상폐/거래중지 공지 경고(notice_warning)는 후속 과제 (spec §10 — 초기 구현에서는 2단 입출금 상태로 대체)
// 순수함수 — 외부 I/O 없음
import { FeasibilityResult, MultiArbExchange, NetworkStatus, SpreadCandidate, WalletStatusMap, EXCHANGE_LABELS } from './multi-arb-types';

export function evaluateFeasibility(
  candidate: SpreadCandidate,
  wallets: Partial<Record<MultiArbExchange, WalletStatusMap>>,
): FeasibilityResult {
  const buyNets = wallets[candidate.buyExchange]?.get(candidate.symbol);
  const sellNets = wallets[candidate.sellExchange]?.get(candidate.symbol);

  // 지갑 정보가 없으면 판정 불가 (지갑 조회 실패 or 상장만 되고 지갑 미지원)
  if (!buyNets || buyNets.length === 0 || !sellNets || sellNets.length === 0) {
    return {
      feasibility: 'unverified',
      networkMatch: null,
      matchedNetwork: null,
      note: '지갑/네트워크 정보 없음 — 실현가능성 미검증',
    };
  }

  // 1단: 네트워크 교집합
  const sellByNetwork = new Map<string, NetworkStatus>(sellNets.map(n => [n.network, n]));
  const commonNetworks = buyNets.filter(n => sellByNetwork.has(n.network));

  if (commonNetworks.length === 0) {
    const buyLabel = `${EXCHANGE_LABELS[candidate.buyExchange]} ${buyNets.map(n => n.network).join('/')}망`;
    const sellLabel = `${EXCHANGE_LABELS[candidate.sellExchange]} ${sellNets.map(n => n.network).join('/')}망`;
    return {
      feasibility: 'network_mismatch',
      networkMatch: false,
      matchedNetwork: null,
      note: `전송불가: 네트워크 불일치(${buyLabel} ↔ ${sellLabel})`,
    };
  }

  // 2단: 교집합 네트워크 중 매수측 출금 가능 ∧ 매도측 입금 가능
  const transferable = commonNetworks.find(
    buyNet => buyNet.withdrawEnabled && sellByNetwork.get(buyNet.network)!.depositEnabled,
  );

  if (!transferable) {
    return {
      feasibility: 'deposit_halt',
      networkMatch: true,
      matchedNetwork: commonNetworks[0].network,
      note: `입출금 중단: ${commonNetworks.map(n => n.network).join('/')}망에서 매수측 출금 또는 매도측 입금 불가`,
    };
  }

  // 3단(공지 경고)은 후속 과제 (spec §10) — 여기 도달하면 feasible
  return {
    feasibility: 'feasible',
    networkMatch: true,
    matchedNetwork: transferable.network,
    note: `네트워크 일치(${transferable.network}) · 양쪽 입출금 정상`,
  };
}
```

### Step 7.4: 통과 확인 + 커밋

```bash
npx jest __tests__/services/multi-arb-feasibility-filter.test.ts
npx tsc --noEmit
```
기대 출력: `Tests: 7 passed` (LSK 회귀 포함), 타입 에러 0.

```bash
git add src/services/multi-arb-feasibility-filter.ts __tests__/services/multi-arb-feasibility-filter.test.ts
git commit -m "feat: 실현가능성 3단 필터 추가 (LSK 회귀 테스트 포함)"
```

---

## Task 8: ArbAlertNotifier (쿨다운 30분 + 카카오톡 + DB 기록)

**Files:**
- Create: `src/services/multi-arb-notifier.service.ts`
- Test: `__tests__/services/multi-arb-notifier.test.ts`

### Step 8.1: 실패 테스트 작성

`__tests__/services/multi-arb-notifier.test.ts` 생성:

```typescript
// 쿨다운(30분) + 발송 성공 시에만 notifiedAt 갱신 검증 (spec §5 step 6, §8, §9, §11)
import prisma from '../../__mocks__/database';
import { multiArbNotifierService, buildAlertMessage } from '../../src/services/multi-arb-notifier.service';
import { kakaoNotifyService } from '../../src/services/kakao-notify.service';
import { SpreadCandidate, FeasibilityResult } from '../../src/services/multi-arb-types';

jest.mock('../../src/services/kakao-notify.service', () => ({
  kakaoNotifyService: { sendToMe: jest.fn() },
}));
const mockedSend = kakaoNotifyService.sendToMe as jest.Mock;
const db = prisma as any;

const cand: SpreadCandidate = {
  symbol: 'WLD',
  currencyZone: 'KRW',
  buyExchange: 'bithumb',
  buyPrice: 4200,
  sellExchange: 'upbit',
  sellPrice: 4340,
  spreadPct: 3.33,
};

const feasible: FeasibilityResult = {
  feasibility: 'feasible',
  networkMatch: true,
  matchedNetwork: 'ETH',
  note: '네트워크 일치(ETH) · 양쪽 입출금 정상',
};

describe('multiArbNotifierService.notify', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.multiArbOpportunity.findFirst.mockResolvedValue(null);
    db.multiArbOpportunity.create.mockResolvedValue({ id: 1 });
    db.multiArbOpportunity.update.mockResolvedValue({ id: 1 });
    mockedSend.mockResolvedValue(undefined);
  });

  it('쿨다운 없음 → DB 기록 + 카톡 발송 + notifiedAt 갱신', async () => {
    const sent = await multiArbNotifierService.notify(cand, feasible, 0.8);
    expect(sent).toBe(true);
    expect(db.multiArbOpportunity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        symbol: 'WLD',
        currencyZone: 'KRW',
        buyExchange: 'bithumb',
        buyPrice: 4200,
        sellExchange: 'upbit',
        sellPrice: 4340,
        spreadPct: 3.33,
        feasibility: 'feasible',
        networkMatch: true,
        matchedNetwork: 'ETH',
        kimchiPct: 0.8,
        notifiedAt: null,
      }),
    });
    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(db.multiArbOpportunity.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { notifiedAt: expect.any(Date) },
    });
  });

  it('30분 이내 동일 (symbol, currencyZone) 발송 이력 → 스킵 (기록/발송 안 함)', async () => {
    db.multiArbOpportunity.findFirst.mockResolvedValue({ id: 99, notifiedAt: new Date() });
    const sent = await multiArbNotifierService.notify(cand, feasible, null);
    expect(sent).toBe(false);
    expect(db.multiArbOpportunity.create).not.toHaveBeenCalled();
    expect(mockedSend).not.toHaveBeenCalled();
    // 쿨다운 조회 조건 검증: notifiedAt 30분 윈도우
    expect(db.multiArbOpportunity.findFirst).toHaveBeenCalledWith({
      where: {
        symbol: 'WLD',
        currencyZone: 'KRW',
        notifiedAt: { gte: expect.any(Date) },
      },
    });
  });

  it('카톡 발송 실패 → notifiedAt 미갱신 (다음 사이클 재시도, spec §9)', async () => {
    mockedSend.mockRejectedValue(new Error('kakao down'));
    const sent = await multiArbNotifierService.notify(cand, feasible, null);
    expect(sent).toBe(false);
    expect(db.multiArbOpportunity.create).toHaveBeenCalled();      // 기회 이력은 남김
    expect(db.multiArbOpportunity.update).not.toHaveBeenCalled();  // notifiedAt은 갱신 안 함
  });
});

describe('buildAlertMessage', () => {
  it('feasible: 정상 기회 포맷 (spec §7) — 매수/매도/스프레드/네트워크/김프/면책 문구', () => {
    const msg = buildAlertMessage(cand, feasible, 0.8);
    expect(msg).toContain('🔔 차익 후보 (KRW권) · WLD');
    expect(msg).toContain('📉 빗썸 매수 4,200');
    expect(msg).toContain('📈 업비트 매도 4,340');
    expect(msg).toContain('+3.3%');
    expect(msg).toContain('✅ 네트워크 일치(ETH) · 양쪽 입출금 정상');
    expect(msg).toContain('참고 김프: 해외 대비 +0.8%');
    expect(msg).toContain('⚠️ 표시가 기준 · 실제 유동성/체결 확인 필요');
  });

  it('network_mismatch: 함정 경고 포맷 (spec §7 LSK류)', () => {
    const lsk: SpreadCandidate = {
      symbol: 'LSK', currencyZone: 'KRW',
      buyExchange: 'upbit', buyPrice: 533,
      sellExchange: 'bithumb', sellPrice: 1322,
      spreadPct: 148.03,
    };
    const mismatch: FeasibilityResult = {
      feasibility: 'network_mismatch', networkMatch: false, matchedNetwork: null,
      note: '전송불가: 네트워크 불일치(업비트 LSK망 ↔ 빗썸 ETH망)',
    };
    const msg = buildAlertMessage(lsk, mismatch, null);
    expect(msg).toContain('⚠️ 차익 후보(주의) · LSK');
    expect(msg).toContain('빗썸 1,322 / 업비트 533 (+148%)');
    expect(msg).toContain('⛔ 전송불가: 네트워크 불일치');
    expect(msg).toContain('→ 실현 어려움. 정보용 참고');
    expect(msg).toContain('⚠️ 표시가 기준 · 실제 유동성/체결 확인 필요');
  });

  it('김프 null이면 김프 줄을 생략한다', () => {
    const msg = buildAlertMessage(cand, feasible, null);
    expect(msg).not.toContain('참고 김프');
  });
});
```

### Step 8.2: 실패 확인

```bash
npx jest __tests__/services/multi-arb-notifier.test.ts
```
기대 출력: `Cannot find module '../../src/services/multi-arb-notifier.service'` — FAIL.

### Step 8.3: 구현

`src/services/multi-arb-notifier.service.ts` 생성:

```typescript
// 쿨다운 + 카카오톡 발송 + MultiArbOpportunity 기록 (spec §4 ArbAlertNotifier, §5 step 6, §7~§9)
// 쿨다운: (symbol, currencyZone) 최근 notifiedAt 30분 이내면 스킵
// 발송 실패 시 notifiedAt 미갱신 → 다음 사이클에서 재시도 (spec §9)
import prisma from '../config/database';
import { kakaoNotifyService } from './kakao-notify.service';
import { EXCHANGE_LABELS, FeasibilityResult, SpreadCandidate } from './multi-arb-types';

const COOLDOWN_MS = 30 * 60 * 1000; // 30분 (spec §2)

// 가격 표기: KRW권은 천단위 콤마, USDT권 소수점 코인도 유효자리 유지
function formatPrice(price: number): string {
  return price.toLocaleString('ko-KR', { maximumFractionDigits: 8 });
}

// 카카오톡 메시지 포맷 (spec §7) — 순수함수, 단위테스트 대상
export function buildAlertMessage(
  candidate: SpreadCandidate,
  feasibility: FeasibilityResult,
  kimchiPct: number | null,
): string {
  const buyLabel = EXCHANGE_LABELS[candidate.buyExchange];
  const sellLabel = EXCHANGE_LABELS[candidate.sellExchange];
  const disclaimer = '⚠️ 표시가 기준 · 실제 유동성/체결 확인 필요';

  if (feasibility.feasibility === 'feasible') {
    const lines = [
      `🔔 차익 후보 (${candidate.currencyZone}권) · ${candidate.symbol}`,
      `📉 ${buyLabel} 매수 ${formatPrice(candidate.buyPrice)}`,
      `📈 ${sellLabel} 매도 ${formatPrice(candidate.sellPrice)}  → +${candidate.spreadPct.toFixed(1)}%`,
      `✅ ${feasibility.note}`,
    ];
    if (kimchiPct !== null) {
      const sign = kimchiPct >= 0 ? '+' : '';
      lines.push(`참고 김프: 해외 대비 ${sign}${kimchiPct.toFixed(1)}%`);
    }
    lines.push(disclaimer);
    return lines.join('\n');
  }

  // 함정 경고 (network_mismatch / deposit_halt / unverified) — 정보용(주의) 등급 (spec §6)
  const lines = [
    `⚠️ 차익 후보(주의) · ${candidate.symbol}  ${sellLabel} ${formatPrice(candidate.sellPrice)} / ${buyLabel} ${formatPrice(candidate.buyPrice)} (+${Math.round(candidate.spreadPct)}%)`,
    `⛔ ${feasibility.note}`,
    '→ 실현 어려움. 정보용 참고',
  ];
  if (kimchiPct !== null) {
    const sign = kimchiPct >= 0 ? '+' : '';
    lines.push(`참고 김프: 해외 대비 ${sign}${kimchiPct.toFixed(1)}%`);
  }
  lines.push(disclaimer);
  return lines.join('\n');
}

class MultiArbNotifierService {
  // 반환: 발송 성공 여부 (쿨다운 스킵/발송 실패 = false)
  async notify(
    candidate: SpreadCandidate,
    feasibility: FeasibilityResult,
    kimchiPct: number | null,
  ): Promise<boolean> {
    // 쿨다운 확인 (spec §8: (symbol, currencyZone)의 최근 notifiedAt 30분 이내면 스킵)
    const since = new Date(Date.now() - COOLDOWN_MS);
    const recent = await (prisma as any).multiArbOpportunity.findFirst({
      where: {
        symbol: candidate.symbol,
        currencyZone: candidate.currencyZone,
        notifiedAt: { gte: since },
      },
    });
    if (recent) return false;

    // 기회 이력 기록 (notifiedAt=null — 발송 성공 시에만 갱신)
    const row = await (prisma as any).multiArbOpportunity.create({
      data: {
        symbol: candidate.symbol,
        currencyZone: candidate.currencyZone,
        buyExchange: candidate.buyExchange,
        buyPrice: candidate.buyPrice,
        sellExchange: candidate.sellExchange,
        sellPrice: candidate.sellPrice,
        spreadPct: candidate.spreadPct,
        feasibility: feasibility.feasibility,
        networkMatch: feasibility.networkMatch,
        matchedNetwork: feasibility.matchedNetwork,
        note: feasibility.note,
        kimchiPct,
        notifiedAt: null,
      },
    });

    const message = buildAlertMessage(candidate, feasibility, kimchiPct);
    try {
      await kakaoNotifyService.sendToMe(message);
    } catch (err: any) {
      // 발송 실패: notifiedAt 미갱신 → 쿨다운 미발동 → 다음 사이클 재시도 (spec §9)
      console.error(`[MultiArbNotifier] 카카오 발송 실패 (${candidate.symbol}):`, err?.message ?? err);
      return false;
    }

    await (prisma as any).multiArbOpportunity.update({
      where: { id: row.id },
      data: { notifiedAt: new Date() },
    });
    return true;
  }
}

export const multiArbNotifierService = new MultiArbNotifierService();
```

### Step 8.4: 통과 확인 + 커밋

```bash
npx jest __tests__/services/multi-arb-notifier.test.ts
npx tsc --noEmit
```
기대 출력: `Tests: 6 passed`, 타입 에러 0.

```bash
git add src/services/multi-arb-notifier.service.ts __tests__/services/multi-arb-notifier.test.ts
git commit -m "feat: 멀티차익 알림 발송기 추가 (쿨다운 30분 + 카카오톡)"
```

---

## Task 9: MultiExchangeArbScanner (오케스트레이터 + 김프)

**Files:**
- Create: `src/services/multi-exchange-arb-scanner.service.ts`
- Test: `__tests__/services/multi-exchange-arb-scanner.test.ts`

### Step 9.1: 실패 테스트 작성

`__tests__/services/multi-exchange-arb-scanner.test.ts` 생성:

```typescript
// 오케스트레이터 흐름 테스트 — 하위 모듈 전부 모킹 (spec §5 데이터 흐름)
import { multiExchangeArbScannerService, computeKimchiPct } from '../../src/services/multi-exchange-arb-scanner.service';
import { multiArbSymbolUniverseService } from '../../src/services/multi-arb-symbol-universe.service';
import { multiArbPriceSource } from '../../src/services/multi-arb-price-source.service';
import { multiArbWalletStatusService } from '../../src/services/multi-arb-wallet-status.service';
import { multiArbNotifierService } from '../../src/services/multi-arb-notifier.service';
import { PriceMap, MultiArbExchange } from '../../src/services/multi-arb-types';

jest.mock('../../src/services/multi-arb-symbol-universe.service', () => ({
  multiArbSymbolUniverseService: { getUniverse: jest.fn() },
}));
jest.mock('../../src/services/multi-arb-price-source.service', () => ({
  multiArbPriceSource: { fetchAllPrices: jest.fn(), getKrwPerUsdt: jest.fn() },
}));
jest.mock('../../src/services/multi-arb-wallet-status.service', () => ({
  multiArbWalletStatusService: { getAll: jest.fn() },
}));
jest.mock('../../src/services/multi-arb-notifier.service', () => ({
  multiArbNotifierService: { notify: jest.fn() },
}));

const mockUniverse = multiArbSymbolUniverseService.getUniverse as jest.Mock;
const mockPrices = multiArbPriceSource.fetchAllPrices as jest.Mock;
const mockKrwPerUsdt = multiArbPriceSource.getKrwPerUsdt as jest.Mock;
const mockWallets = multiArbWalletStatusService.getAll as jest.Mock;
const mockNotify = multiArbNotifierService.notify as jest.Mock;

function priceMap(entries: Record<string, number>): PriceMap {
  return new Map(Object.entries(entries));
}

describe('multiExchangeArbScannerService.scanOnce', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockKrwPerUsdt.mockResolvedValue(1385);
    mockWallets.mockResolvedValue({
      upbit: new Map([['WLD', [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }]]]),
      bithumb: new Map([['WLD', [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }]]]),
    });
    mockNotify.mockResolvedValue(true);
  });

  it('임계값(2%) 초과 후보만 실현가능성 판정 후 알림에 넘긴다 (spec §5 step 4~6)', async () => {
    mockUniverse.mockResolvedValue({ krw: ['WLD', 'BTC'], usdt: [] });
    mockPrices.mockResolvedValue({
      upbit: priceMap({ WLD: 4340, BTC: 100000000 }),
      bithumb: priceMap({ WLD: 4200, BTC: 100050000 }), // BTC 스프레드 0.05% → 임계값 미달
    } as Partial<Record<MultiArbExchange, PriceMap>>);

    const summary = await multiExchangeArbScannerService.scanOnce();

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const [cand, feas, kimchi] = mockNotify.mock.calls[0];
    expect(cand.symbol).toBe('WLD');
    expect(cand.buyExchange).toBe('bithumb');
    expect(feas.feasibility).toBe('feasible');
    expect(typeof kimchi === 'number' || kimchi === null).toBe(true);
    expect(summary.hotCandidates).toBe(1);
    expect(summary.alerted).toBe(1);
  });

  it('임계값 미달이면 알림 없음', async () => {
    mockUniverse.mockResolvedValue({ krw: ['BTC'], usdt: [] });
    mockPrices.mockResolvedValue({
      upbit: priceMap({ BTC: 100000000 }),
      bithumb: priceMap({ BTC: 100050000 }),
    });
    const summary = await multiExchangeArbScannerService.scanOnce();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(summary.alerted).toBe(0);
  });

  it('한 후보의 notify 실패가 다른 후보를 막지 않는다', async () => {
    mockUniverse.mockResolvedValue({ krw: ['WLD'], usdt: ['PEPE'] });
    mockPrices.mockResolvedValue({
      upbit: priceMap({ WLD: 4340 }),
      bithumb: priceMap({ WLD: 4200 }),
      binance: priceMap({ PEPE: 0.00001 }),
      mexc: priceMap({ PEPE: 0.0000105 }),
    });
    mockNotify.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(true);
    const summary = await multiExchangeArbScannerService.scanOnce();
    expect(mockNotify).toHaveBeenCalledTimes(2);
    expect(summary.alerted).toBe(1);
  });
});

describe('computeKimchiPct (spec §5 step 7: 참고 수치, 알림 트리거 아님)', () => {
  it('국내(업비트 우선) vs 해외(바이낸스 우선) 김프% 계산', () => {
    const prices: Partial<Record<MultiArbExchange, PriceMap>> = {
      upbit: priceMap({ WLD: 4340 }),
      binance: priceMap({ WLD: 3.1 }),
    };
    // 4340 / (3.1 * 1385) - 1 = +1.08%
    expect(computeKimchiPct('WLD', prices, 1385)).toBeCloseTo((4340 / (3.1 * 1385) - 1) * 100, 6);
  });

  it('환율 또는 한쪽 가격이 없으면 null', () => {
    const prices: Partial<Record<MultiArbExchange, PriceMap>> = { upbit: priceMap({ WLD: 4340 }) };
    expect(computeKimchiPct('WLD', prices, 1385)).toBeNull();     // 해외가 없음
    expect(computeKimchiPct('WLD', prices, null)).toBeNull();     // 환율 없음
  });
});
```

### Step 9.2: 실패 확인

```bash
npx jest __tests__/services/multi-exchange-arb-scanner.test.ts
```
기대 출력: `Cannot find module` — FAIL.

### Step 9.3: 구현

`src/services/multi-exchange-arb-scanner.service.ts` 생성:

```typescript
// 멀티 거래소 차익 스캐너 오케스트레이터 (spec §4~§5)
// 60초 주기 (MultiExchangeArbAgent에서 호출): 교집합 → 시세 → 스프레드 → 임계값 → 실현가능성 → 쿨다운/알림
import { multiArbSymbolUniverseService } from './multi-arb-symbol-universe.service';
import { multiArbPriceSource } from './multi-arb-price-source.service';
import { multiArbWalletStatusService } from './multi-arb-wallet-status.service';
import { calculateSpreads } from './multi-arb-spread-calculator';
import { evaluateFeasibility } from './multi-arb-feasibility-filter';
import { multiArbNotifierService } from './multi-arb-notifier.service';
import {
  KRW_ZONE_EXCHANGES, USDT_ZONE_EXCHANGES, MultiArbExchange, PriceMap,
} from './multi-arb-types';

// 알림 임계값: 스프레드 2% 이상 (spec §2, 조정 가능 — env 우선)
const SPREAD_THRESHOLD_PCT = Number(process.env.MULTI_ARB_THRESHOLD_PCT ?? '2');

export interface ScanSummary {
  scannedKrw: number;
  scannedUsdt: number;
  hotCandidates: number;  // 임계값 초과 후보 수
  alerted: number;        // 실제 카톡 발송 수 (쿨다운 통과분)
  lastScanAt: string | null;
}

// 참고 김프 계산 (spec §5 step 7): 국내(업비트→빗썸 순) vs 해외(바이낸스→MEXC→Gate.io 순), 업비트 KRW-USDT 환율 환산
export function computeKimchiPct(
  symbol: string,
  prices: Partial<Record<MultiArbExchange, PriceMap>>,
  krwPerUsdt: number | null,
): number | null {
  if (krwPerUsdt === null || krwPerUsdt <= 0) return null;
  const domestic = prices.upbit?.get(symbol) ?? prices.bithumb?.get(symbol);
  const overseas = prices.binance?.get(symbol) ?? prices.mexc?.get(symbol) ?? prices.gateio?.get(symbol);
  if (!domestic || !overseas) return null;
  return (domestic / (overseas * krwPerUsdt) - 1) * 100;
}

class MultiExchangeArbScannerService {
  private lastSummary: ScanSummary = {
    scannedKrw: 0, scannedUsdt: 0, hotCandidates: 0, alerted: 0, lastScanAt: null,
  };

  getLastScanSummary(): ScanSummary {
    return { ...this.lastSummary };
  }

  async scanOnce(): Promise<ScanSummary> {
    // 1. 심볼 교집합 (1시간 캐시) — spec §5 step 1
    const universe = await multiArbSymbolUniverseService.getUniverse();

    // 2. 시세 + 지갑 상태 + 환율 병렬 조회 — spec §5 step 2 (Promise.allSettled는 각 모듈 내부에서 처리)
    const [prices, wallets, krwPerUsdt] = await Promise.all([
      multiArbPriceSource.fetchAllPrices(universe.krw),
      multiArbWalletStatusService.getAll(),
      multiArbPriceSource.getKrwPerUsdt(),
    ]);

    // 3. 같은 통화권 내 스프레드 계산 — spec §5 step 3 (국내↔해외 김프는 트리거 아님, §2)
    const candidates = [
      ...calculateSpreads('KRW', universe.krw, prices, KRW_ZONE_EXCHANGES),
      ...calculateSpreads('USDT', universe.usdt, prices, USDT_ZONE_EXCHANGES),
    ];

    // 4. 1차 필터: 임계값 초과만 — spec §5 step 4
    const hot = candidates.filter(c => c.spreadPct >= SPREAD_THRESHOLD_PCT);

    // 5~7. 실현가능성 판정 → 쿨다운/알림 (+김프 첨부) — spec §5 step 5~7
    let alerted = 0;
    for (const candidate of hot) {
      try {
        const feasibility = evaluateFeasibility(candidate, wallets);
        const kimchiPct = computeKimchiPct(candidate.symbol, prices, krwPerUsdt);
        const sent = await multiArbNotifierService.notify(candidate, feasibility, kimchiPct);
        if (sent) alerted++;
      } catch (err: any) {
        // 후보 1건 실패가 나머지 후보 처리를 막지 않도록 격리
        console.error(`[MultiExchangeArbScanner] 후보 처리 실패 (${candidate.symbol}):`, err?.message ?? err);
      }
    }

    this.lastSummary = {
      scannedKrw: universe.krw.length,
      scannedUsdt: universe.usdt.length,
      hotCandidates: hot.length,
      alerted,
      lastScanAt: new Date().toISOString(),
    };
    if (hot.length > 0) {
      console.log(`[MultiExchangeArbScanner] 후보 ${hot.length}건 (발송 ${alerted}건) — 임계값 ${SPREAD_THRESHOLD_PCT}%`);
    }
    return this.lastSummary;
  }
}

export const multiExchangeArbScannerService = new MultiExchangeArbScannerService();
```

### Step 9.4: 통과 확인 + 커밋

```bash
npx jest __tests__/services/multi-exchange-arb-scanner.test.ts
npx tsc --noEmit
```
기대 출력: `Tests: 5 passed`, 타입 에러 0.

```bash
git add src/services/multi-exchange-arb-scanner.service.ts __tests__/services/multi-exchange-arb-scanner.test.ts
git commit -m "feat: 멀티 거래소 차익 스캐너 오케스트레이터 추가"
```

---

## Task 10: MultiExchangeArbAgent + agent-manager 등록

**Files:**
- Create: `src/agents/multi-exchange-arb-agent.ts`
- Modify: `src/agents/index.ts` (파일 끝에 export 1줄 추가)
- Modify: `src/index.ts` (L14 import 목록, L99 register 뒤, L100 로그 문자열)

### Step 10.1: 에이전트 구현

`src/agents/multi-exchange-arb-agent.ts` 생성 (기존 `general-arb-scanner-agent.ts` 패턴, 단 폴링형이므로 `cycleIntervalMs: 60000` — BaseAgent가 순차 setTimeout 루프로 onCycle 호출, spec §9):

```typescript
import { BaseAgent } from './base-agent';
import { multiExchangeArbScannerService } from '../services/multi-exchange-arb-scanner.service';

/**
 * 멀티 거래소 차익거래 알림 에이전트 (spec 2026-09-14)
 * - 업비트·빗썸·바이낸스·MEXC·Gate.io 5개 거래소 공통 상장 코인 스캔
 * - 60초 폴링 (BaseAgent 순차 setTimeout 루프 — 사이클 겹침 없음)
 * - 알림 전용 (주문 실행 없음)
 */
export class MultiExchangeArbAgent extends BaseAgent {
  constructor() {
    super({
      id: 'multi-exchange-arb',
      name: 'MultiExchangeArbAgent',
      description: '멀티 거래소(업비트·빗썸·바이낸스·MEXC·Gate.io) 차익 기회 스캔 + 카카오톡 알림 (실행 없음)',
      cycleIntervalMs: 60000, // 60초 (spec §9)
    });
  }

  protected async onStart(): Promise<void> {
    console.log('[MultiExchangeArbAgent] 시작 — 60초 주기 스캔');
  }

  protected async onStop(): Promise<void> {
    console.log('[MultiExchangeArbAgent] 정지');
  }

  protected async onCycle(): Promise<void> {
    // 에러는 BaseAgent 사이클 루프가 잡아 metrics.errors에 집계 (spec §9)
    await multiExchangeArbScannerService.scanOnce();
  }

  protected override getExtraInfo(): Record<string, any> {
    return { ...multiExchangeArbScannerService.getLastScanSummary() };
  }
}

export const multiExchangeArbAgent = new MultiExchangeArbAgent();
```

### Step 10.2: 등록

1. `src/agents/index.ts` 파일 끝에 추가:
   ```typescript
   export { MultiExchangeArbAgent, multiExchangeArbAgent } from './multi-exchange-arb-agent';
   ```
2. `src/index.ts` L14 import 목록에 `MultiExchangeArbAgent` 추가:
   ```typescript
   import { agentManager, GridAgent, InfiniteBuyAgent, VRAgent, MakerTakerSimulatorAgent, PairScannerAgent, GeneralArbScannerAgent, UpbitListingMonitorAgent, BithumbListingMonitorAgent, BtcRsiAgent, RebalancerAgent, VolatilityBreakoutAgent, MultiExchangeArbAgent } from './agents';
   ```
3. `src/index.ts` L99 (`agentManager.register(new VolatilityBreakoutAgent());`) 다음 줄에 추가:
   ```typescript
   agentManager.register(new MultiExchangeArbAgent());
   ```
4. L100 로그 문자열 끝에 `, MultiExchangeArbAgent` 추가 (닫는 괄호 앞).

> 참고: 기존 구조상 `agentManager.startAll()`은 `config.nodeEnv === 'production'`에서만 실행되므로(L103~105) 로컬 dev에서는 등록만 되고 자동 시작되지 않는다 — 기존 에이전트들과 동일한 운영 방식이며 admin 에이전트 관리 UI로 개별 시작 가능.

### Step 10.3: 확인 + 커밋

```bash
npx tsc --noEmit
npx jest
```
기대 출력: 타입 에러 0, 전체 스위트 PASS (신규 multi-arb 테스트 8개 파일 포함).

```bash
git add src/agents/multi-exchange-arb-agent.ts src/agents/index.ts src/index.ts
git commit -m "feat: MultiExchangeArbAgent 등록 (60초 주기 스캔)"
```

---

## Task 11: 통합 검증 + 스케줄 동작 확인

**Files:** 신규 파일 없음 (검증 전용)

### Step 11.1: 전체 검증 (증거 기반 완료)

```bash
npx tsc --noEmit
npx jest --coverage
npm run build
```
기대 출력:
- 타입 에러 0
- 전체 테스트 PASS (기존 + 신규 multi-arb 8개 테스트 파일, 총 ~39 신규 케이스)
- `npm run build` 성공 (prisma generate + tsc, 0 errors)

### Step 11.2: 로컬 스모크 테스트 (dev DB + 실 API 1사이클)

dev 서버를 띄우지 않고 스캐너 1사이클만 직접 실행해 확인 (public API만 사용하는 시세/교집합 경로 검증; 지갑 상태는 dev DB에 관리자 자격증명이 없으면 unverified로 동작하는 것까지가 정상):

```bash
npx ts-node -e "
import { multiExchangeArbScannerService } from './src/services/multi-exchange-arb-scanner.service';
multiExchangeArbScannerService.scanOnce().then(s => { console.log('스캔 결과:', s); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });
"
```
기대 출력: `[MultiArbSymbolUniverse] 갱신: KRW권 N개, USDT권 M개` (N, M > 0) + `스캔 결과: { scannedKrw: N, ... }`. 임계값 초과 후보가 있으면 카카오 발송 로그(또는 토큰 없음 에러 — dev에서는 정상).

⚠️ dev DB에 카카오 토큰이 있으면 실제 카톡이 발송될 수 있다. 원치 않으면 실행 전 `MULTI_ARB_THRESHOLD_PCT=999`로 임계값을 올려 발송 경로를 차단하고 스캔 파이프라인만 검증:

```bash
MULTI_ARB_THRESHOLD_PCT=999 npx ts-node -e "..."   # 위와 동일 스크립트
```

### Step 11.3: 최종 커밋 + PR

```bash
git push -u origin feat/multi-exchange-arb-alert
gh pr create --title "feat: 멀티 거래소 차익거래 알림 (5개 거래소, 실현가능성 필터)" --body "..."
```
PR 본문에 포함할 것: spec 링크, 테스트 증거(jest 결과 수치), 마이그레이션 1건(`add_multi_arb_opportunity`) 명시, production 배포 시 `prisma migrate deploy` 자동 적용됨을 명시. 머지/배포는 프로젝트 자동 진행 정책(RDS 스냅샷 → 머지 → `gh run watch` → 헬스체크) 준수.

배포 후 확인:
- `GET /api/metrics` 또는 admin 에이전트 UI에서 `multi-exchange-arb` 에이전트 `running`, `errors=0`, `extra.lastScanAt` 갱신 확인
- `multi_arb_opportunities` 테이블에 행 적재 확인 (컨테이너 내부 Prisma 조회 — 운영 검증 규칙 준수)

---

## Spec 커버리지 자체 점검 (§4~§11)

| Spec 항목 | 커버 Task | 비고 |
|---|---|---|
| §4 MultiExchangeArbAgent (60초) | Task 10 | BaseAgent 상속, cycleIntervalMs=60000 |
| §4 MultiExchangeArbScanner | Task 9 | 오케스트레이터 |
| §4 ExchangePriceSource | Task 4 | 기존 fetch*Price는 단건·private이라 배치 버전 신규 구현 (설계 노트로 사유 명시) |
| §4 SymbolUniverse (1시간 캐시) | Task 5 | computeUniverse 순수함수 + 캐시 |
| §4 WalletStatusProvider (5~10분 캐시) | Task 3 | 5개 거래소 전부, 5분 캐시 |
| §4 SpreadCalculator | Task 6 | 순수함수 |
| §4 FeasibilityFilter | Task 7 | 3단 (3단 공지는 §10에 따라 후속) |
| §4 ArbAlertNotifier | Task 8 | 쿨다운 + kakao-notify 재사용 |
| §4 DB MultiArbOpportunity | Task 2 | spec §8 모델 그대로 |
| §5 step 1~7 데이터 흐름 | Task 9 | scanOnce가 순서대로 수행, 김프 step 7 포함 |
| §5 Promise.allSettled | Task 3/4 | 지갑·시세 각각 allSettled, 실패 거래소 제외 |
| §6 3단 필터 + 태그 | Task 7 | network_mismatch/deposit_halt/unverified + 교집합 판정 |
| §6 함정을 "주의" 등급으로 표시 | Task 8 | buildAlertMessage 비정상 분기 |
| §7 알림 포맷 (정상/함정/면책 문구) | Task 8 | 테스트로 문구 고정 |
| §8 데이터 모델 + 쿨다운 정의 | Task 2, 8 | (symbol, currencyZone)+notifiedAt 30분 |
| §9 스케줄링/에러 처리 | Task 9, 10 | 거래소 실패 격리, 캐시, 발송 실패 시 쿨다운 미갱신 |
| §10 범위 밖 (YAGNI) | 전체 | 주문 실행 없음, 공지 파싱 3단 미구현, UI 없음 |
| §11 테스트 전략 | Task 3~9 | SpreadCalculator/FeasibilityFilter(LSK 회귀)/쿨다운/지갑 파싱 전부 jest |

**서명 인프라 추출 (spec §3 마지막 항목)**: Task 1 — `signedGet`/`signedPost`/`mexcPost`/`gateioRequest`/상수를 `exchange-signer.ts`로, 자격증명 getter를 `admin-credentials.ts`로 추출, `listing-auto-trader.service.ts`는 import로 대체 (기능 동일, 기존 source-routing 테스트로 회귀 확인).
