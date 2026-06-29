# 한국주식 그리드 매매 (토스증권 OpenAPI) — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 토스증권 OpenAPI와 연동하여 한국주식 그리드 매매를 `/korean-stocks` 페이지에서 일반 사용자가 운영할 수 있게 구축. 장시간/거래세/호가단위/상하한가 자동 처리 + 종목 자동완성 + 4 step 마법사.

**Architecture:** Bot 모델 재사용 + `Market` enum (CRYPTO/KOREAN_STOCK) 분기. 한국주식 전용 봇 엔진(`korean-stock-bot-engine.service.ts`) 별도, 코인 `bot-engine.service.ts`(621줄)는 건드리지 않음. 토스 OAuth 2.0 Client Credentials + REST polling. KoreanStockSymbol/KoreanMarketCalendar 신규 테이블.

**Tech Stack:** Express 5 + TypeScript + Prisma(MySQL) + Next.js 16 + React 19 + shadcn/ui + axios + jest

**Related Spec:** `docs/superpowers/specs/2026-06-29-korean-stock-grid-design.md`

---

## 작업 순서 (Phase별)

- **Phase 1 (Task 1)**: DB 스키마 + 마이그레이션
- **Phase 2 (Task 2~4)**: 토스 API 클라이언트 (OAuth + 시세 + 주문 + 계좌)
- **Phase 3 (Task 5~7)**: 유틸 서비스 (장시간/호가단위/거래세)
- **Phase 4 (Task 8~10)**: 봇 엔진 + 에이전트
- **Phase 5 (Task 11~12)**: 종목/휴장일 sync
- **Phase 6 (Task 13~14)**: 백엔드 컨트롤러 + 라우트
- **Phase 7 (Task 15)**: 프론트엔드 API 함수
- **Phase 8 (Task 16~18)**: 프론트엔드 컴포넌트 + 페이지
- **Phase 9 (Task 19~20)**: 출시 + Canary

---

## Task 1: Prisma 스키마 + 마이그레이션

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_korean_stock_grid/migration.sql`

신규 enum + 컬럼 + 테이블 2개. 빗썸 작업에서 발견된 shadow DB 부채(`20250201_trade_preserve_on_bot_delete` P3018)로 `migrate dev --create-only`가 실패할 수 있음 — fallback으로 `prisma migrate diff` + `prisma db execute` + `prisma migrate resolve --applied` 패턴 사용.

- [ ] **Step 1: 스키마 수정**

`prisma/schema.prisma`에 다음 추가/수정:

```prisma
// 신규 enum (다른 enum 옆에)
enum Market {
  CRYPTO
  KOREAN_STOCK
}

// Exchange enum에 toss 추가 (기존 enum 끝에)
enum Exchange {
  // ... 기존 값 ...
  toss
}

// Bot 모델 수정 (line 50~ 영역)
model Bot {
  // ... 기존 필드 그대로 ...
  market   Market  @default(CRYPTO)
  feeRate  Float?  // 봇별 토스 수수료율 (한국주식만 사용, default 0.00015)
  taxRate  Float?  // 매도 거래세 (한국주식만 사용, default 0.0018)
  // ... 기존 relations 그대로 ...

  @@index([market])
  @@index([userId, market])
  // ... 기존 인덱스 ...
}

// Credential 모델 수정 — accountSeq 추가 (실제 위치는 grep으로 확인)
model Credential {
  // ... 기존 필드 ...
  accountSeq String?  // 토스 계좌 시퀀스 (평문, 시크릿 아님)
}

// 신규 모델 2개
model KoreanStockSymbol {
  code      String   @id @db.VarChar(10)
  name      String
  market    String
  sector    String?
  updatedAt DateTime @updatedAt
  @@index([name])
  @@map("korean_stock_symbols")
}

model KoreanMarketCalendar {
  date       DateTime @id @db.Date
  isOpen     Boolean
  reason     String?
  @@map("korean_market_calendar")
}
```

- [ ] **Step 2: 마이그레이션 SQL 생성**

Run: `npx prisma migrate dev --create-only --name add_korean_stock_grid`
Expected: `prisma/migrations/<timestamp>_add_korean_stock_grid/migration.sql` 생성

**P3018 에러 발생 시 우회**:
```bash
# 1) 현재 스키마와 DB 차이 SQL 추출
npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script > migration.sql
# 2) 수동으로 마이그레이션 폴더 생성
mkdir -p prisma/migrations/$(date +%Y%m%d%H%M%S)_add_korean_stock_grid
mv migration.sql prisma/migrations/<timestamp>_add_korean_stock_grid/
# 3) db execute로 직접 적용
npx prisma db execute --file prisma/migrations/<timestamp>_add_korean_stock_grid/migration.sql --schema prisma/schema.prisma
# 4) 적용 기록
npx prisma migrate resolve --applied <timestamp>_add_korean_stock_grid
```

- [ ] **Step 3: 마이그레이션 SQL 검사 (garbage 확인)**

생성된 `migration.sql`을 Read tool로 열어 박스 문자(`│ ─ ━` 등) 혼입 확인. 발견 시 Edit으로 제거. (CLAUDE.md Prisma migrate CLI garbage 패턴)

기대 SQL 일부:
```sql
ALTER TABLE `bots` ADD COLUMN `market` ENUM('CRYPTO', 'KOREAN_STOCK') NOT NULL DEFAULT 'CRYPTO';
ALTER TABLE `bots` ADD COLUMN `feeRate` DOUBLE NULL;
ALTER TABLE `bots` ADD COLUMN `taxRate` DOUBLE NULL;
ALTER TABLE `bots` ADD INDEX `bots_market_idx` (`market`);
ALTER TABLE `bots` ADD INDEX `bots_userId_market_idx` (`userId`, `market`);
ALTER TABLE `credentials` ADD COLUMN `accountSeq` VARCHAR(191) NULL;
ALTER TABLE `<exchange enum 변경>`;  -- Prisma가 자동 처리
CREATE TABLE `korean_stock_symbols` (...);
CREATE TABLE `korean_market_calendar` (...);
```

- [ ] **Step 4: dev DB에 적용 + Prisma client 재생성**

Run: `npx prisma migrate dev && npx prisma generate`
Expected: `Applying migration ...` + `Generated Prisma Client`

- [ ] **Step 5: 기존 Bot row 백필 확인**

Run: `node -e "const p=require('@prisma/client').PrismaClient; new p().bot.findMany({take:3,select:{id:true,market:true}}).then(r=>console.log(r))"`
Expected: 모든 row가 `market: 'CRYPTO'`로 자동 백필

- [ ] **Step 6: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 에러 0개 (기존 코드는 default `market='CRYPTO'` 덕분에 안 깨짐)

- [ ] **Step 7: 커밋**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: 한국주식 그리드 — Market enum + Bot 컬럼 + 신규 테이블 2개"
```

---

## Task 2: TossService 골격 + OAuth 테스트 (TDD RED)

**Files:**
- Create: `__tests__/services/toss.service.test.ts`
- Create: `src/services/toss.service.ts` (빈 골격만)

토스 OAuth 2.0 Client Credentials Grant 토큰 발급. 토큰 캐싱 (만료 5분 전 갱신). 사용자별로 토큰 분리.

- [ ] **Step 1: 테스트 파일 작성**

Path 컨벤션 주의: jest.config.ts `roots: ['<rootDir>/__tests__']` → `__tests__/services/` 사용 (빗썸 작업에서 검증된 패턴).

```typescript
// __tests__/services/toss.service.test.ts
import { TossService } from '../../src/services/toss.service';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('TossService.getAccessToken', () => {
  let service: TossService;
  beforeEach(() => {
    jest.clearAllMocks();
    service = new TossService();
  });

  it('OAuth Client Credentials Grant로 토큰 발급', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { access_token: 'tok_abc', token_type: 'Bearer', expires_in: 3600 },
    });
    const token = await service.getAccessToken('client_id_x', 'client_secret_y');
    expect(token).toBe('tok_abc');
    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.stringContaining('/oauth2/token'),
      expect.objectContaining({ grant_type: 'client_credentials' }),
      expect.objectContaining({ headers: expect.objectContaining({ 'Content-Type': 'application/x-www-form-urlencoded' }) }),
    );
  });

  it('같은 client_id 두 번 호출 시 캐시된 토큰 반환 (API 1회만)', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { access_token: 'tok_cached', expires_in: 3600 },
    });
    const t1 = await service.getAccessToken('client_id_x', 'client_secret_y');
    const t2 = await service.getAccessToken('client_id_x', 'client_secret_y');
    expect(t1).toBe(t2);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('토큰 만료 5분 전 자동 재발급', async () => {
    jest.useFakeTimers();
    mockedAxios.post
      .mockResolvedValueOnce({ data: { access_token: 'tok_old', expires_in: 3600 } })
      .mockResolvedValueOnce({ data: { access_token: 'tok_new', expires_in: 3600 } });
    const t1 = await service.getAccessToken('client_id_x', 'client_secret_y');
    expect(t1).toBe('tok_old');
    // 55분 후
    jest.advanceTimersByTime(55 * 60 * 1000);
    const t2 = await service.getAccessToken('client_id_x', 'client_secret_y');
    expect(t2).toBe('tok_new');
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('OAuth 응답 에러 시 throw', async () => {
    mockedAxios.post.mockRejectedValueOnce({ response: { status: 401, data: { error: 'invalid_client' } } });
    await expect(service.getAccessToken('bad_id', 'bad_secret')).rejects.toThrow(/OAuth/);
  });
});
```

- [ ] **Step 2: 빈 골격 작성 (테스트 실패용)**

```typescript
// src/services/toss.service.ts
export class TossService {
  async getAccessToken(_clientId: string, _clientSecret: string): Promise<string> {
    throw new Error('Not implemented');
  }
}
```

- [ ] **Step 3: 테스트 실행 (실패 확인)**

Run: `npx jest __tests__/services/toss.service.test.ts`
Expected: 4건 FAIL (`Not implemented` 또는 mock 검증 실패)

- [ ] **Step 4: 커밋**

```bash
git add __tests__/services/toss.service.test.ts src/services/toss.service.ts
git commit -m "test: TossService OAuth 토큰 발급 테스트 작성 (RED)"
```

---

## Task 3: TossService OAuth 구현 (TDD GREEN)

**Files:**
- Modify: `src/services/toss.service.ts`

- [ ] **Step 1: getAccessToken 구현**

```typescript
// src/services/toss.service.ts
import axios from 'axios';

const TOSS_BASE_URL = process.env.TOSS_API_URL || 'https://wts-openapi.tossinvest.com';
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 만료 5분 전 갱신

interface TokenCacheEntry {
  token: string;
  expiresAt: number; // epoch ms
}

export class TossService {
  // 사용자별 토큰 캐시 (key: clientId)
  private tokenCache: Map<string, TokenCacheEntry> = new Map();

  async getAccessToken(clientId: string, clientSecret: string): Promise<string> {
    const cached = this.tokenCache.get(clientId);
    if (cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS) {
      return cached.token;
    }

    try {
      const res = await axios.post(
        `${TOSS_BASE_URL}/oauth2/token`,
        new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10_000 },
      );
      const { access_token, expires_in } = res.data;
      this.tokenCache.set(clientId, {
        token: access_token,
        expiresAt: Date.now() + (expires_in * 1000),
      });
      return access_token;
    } catch (e: any) {
      const status = e?.response?.status;
      const err = e?.response?.data?.error || e.message;
      throw new Error(`OAuth 토큰 발급 실패 (HTTP ${status}): ${err}`);
    }
  }

  // 테스트 전용 — production 호출 금지
  _resetCacheForTests(): void {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('_resetCacheForTests is test-only');
    }
    this.tokenCache.clear();
  }
}

export const tossService = new TossService();
```

- [ ] **Step 2: 테스트 PASS 확인**

Run: `npx jest __tests__/services/toss.service.test.ts`
Expected: 4/4 PASS

- [ ] **Step 3: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 에러 0개

- [ ] **Step 4: 커밋**

```bash
git add src/services/toss.service.ts
git commit -m "feat: TossService OAuth 토큰 발급 + 캐싱 구현"
```

---

## Task 4: TossService 시세/주문/계좌 메서드 추가

**Files:**
- Modify: `src/services/toss.service.ts`
- Modify: `__tests__/services/toss.service.test.ts`

토스 OpenAPI 핵심 endpoint (`Market Data`, `Account/Asset`, `Order`). 정확한 endpoint path/payload는 토스 공식 문서(https://developers.tossinvest.com/docs)에서 확인 후 구현. 본 plan은 시그니처/책임만 명시.

- [ ] **Step 1: 신규 메서드 시그니처 + mock 테스트 추가**

```typescript
// __tests__/services/toss.service.test.ts 끝에 추가
describe('TossService.getQuote', () => {
  it('시세 조회 (Authorization Bearer 헤더)', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { access_token: 'tok', expires_in: 3600 } });
    mockedAxios.get.mockResolvedValueOnce({ data: { code: '005930', price: 75000, timestamp: '2026-06-29T09:00:00+09:00' } });
    const quote = await service.getQuote('client_id', 'client_secret', '005930');
    expect(quote.price).toBe(75000);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v1/market/quote/005930'),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok' }) }),
    );
  });
});

describe('TossService.getAccountBalance', () => {
  it('계좌 잔액 조회 (X-Tossinvest-Account 헤더)', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { access_token: 'tok', expires_in: 3600 } });
    mockedAxios.get.mockResolvedValueOnce({ data: { krwBalance: 1000000, holdings: [] } });
    const balance = await service.getAccountBalance('client_id', 'client_secret', 'acc_seq_x');
    expect(balance.krwBalance).toBe(1000000);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Tossinvest-Account': 'acc_seq_x' }) }),
    );
  });
});

describe('TossService.placeOrder', () => {
  it('매수 주문 (BUY, 지정가)', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { access_token: 'tok', expires_in: 3600 } });
    mockedAxios.post.mockResolvedValueOnce({ data: { orderId: 'ord_001', status: 'pending' } });
    const result = await service.placeOrder('client_id', 'client_secret', 'acc_seq', {
      code: '005930', side: 'BUY', quantity: 1, price: 75000, orderType: 'LIMIT',
    });
    expect(result.orderId).toBe('ord_001');
  });
});

describe('TossService.cancelOrder', () => {
  it('주문 취소', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { access_token: 'tok', expires_in: 3600 } });
    mockedAxios.delete.mockResolvedValueOnce({ data: { orderId: 'ord_001', status: 'cancelled' } });
    const result = await service.cancelOrder('client_id', 'client_secret', 'acc_seq', 'ord_001');
    expect(result.status).toBe('cancelled');
  });
});

describe('TossService.getSymbolMaster', () => {
  it('전체 종목 마스터 (KOSPI + KOSDAQ)', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { access_token: 'tok', expires_in: 3600 } });
    mockedAxios.get.mockResolvedValueOnce({
      data: { symbols: [{ code: '005930', name: '삼성전자', market: 'KOSPI' }] },
    });
    const symbols = await service.getSymbolMaster('client_id', 'client_secret');
    expect(symbols.length).toBeGreaterThan(0);
    expect(symbols[0].code).toBe('005930');
  });
});

describe('TossService.getMarketCalendar', () => {
  it('휴장일 캘린더 조회 (연도 단위)', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { access_token: 'tok', expires_in: 3600 } });
    mockedAxios.get.mockResolvedValueOnce({
      data: { holidays: [{ date: '2026-01-01', reason: '신정' }] },
    });
    const calendar = await service.getMarketCalendar('client_id', 'client_secret', 2026);
    expect(calendar.holidays.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 메서드 구현 (toss.service.ts 끝에 추가)**

```typescript
// src/services/toss.service.ts (TossService 클래스 안)

  private async authHeaders(clientId: string, clientSecret: string, accountSeq?: string): Promise<Record<string, string>> {
    const token = await this.getAccessToken(clientId, clientSecret);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (accountSeq) headers['X-Tossinvest-Account'] = accountSeq;
    return headers;
  }

  async getQuote(clientId: string, clientSecret: string, code: string): Promise<{ code: string; price: number; timestamp: string }> {
    const headers = await this.authHeaders(clientId, clientSecret);
    const res = await axios.get(`${TOSS_BASE_URL}/v1/market/quote/${code}`, { headers, timeout: 10_000 });
    return res.data;
  }

  async getAccountBalance(clientId: string, clientSecret: string, accountSeq: string): Promise<{ krwBalance: number; holdings: Array<{ code: string; quantity: number; avgPrice: number }> }> {
    const headers = await this.authHeaders(clientId, clientSecret, accountSeq);
    const res = await axios.get(`${TOSS_BASE_URL}/v1/account/balance`, { headers, timeout: 10_000 });
    return res.data;
  }

  async placeOrder(
    clientId: string,
    clientSecret: string,
    accountSeq: string,
    order: { code: string; side: 'BUY' | 'SELL'; quantity: number; price: number; orderType: 'LIMIT' | 'MARKET' },
  ): Promise<{ orderId: string; status: string }> {
    const headers = await this.authHeaders(clientId, clientSecret, accountSeq);
    const res = await axios.post(`${TOSS_BASE_URL}/v1/order`, order, { headers, timeout: 10_000 });
    return res.data;
  }

  async cancelOrder(clientId: string, clientSecret: string, accountSeq: string, orderId: string): Promise<{ orderId: string; status: string }> {
    const headers = await this.authHeaders(clientId, clientSecret, accountSeq);
    const res = await axios.delete(`${TOSS_BASE_URL}/v1/order/${orderId}`, { headers, timeout: 10_000 });
    return res.data;
  }

  async getSymbolMaster(clientId: string, clientSecret: string): Promise<Array<{ code: string; name: string; market: string }>> {
    const headers = await this.authHeaders(clientId, clientSecret);
    const res = await axios.get(`${TOSS_BASE_URL}/v1/market/symbols`, { headers, timeout: 30_000 });
    return res.data.symbols;
  }

  async getMarketCalendar(clientId: string, clientSecret: string, year: number): Promise<{ holidays: Array<{ date: string; reason: string }> }> {
    const headers = await this.authHeaders(clientId, clientSecret);
    const res = await axios.get(`${TOSS_BASE_URL}/v1/market/calendar?year=${year}`, { headers, timeout: 10_000 });
    return res.data;
  }
```

- [ ] **Step 3: 테스트 PASS + tsc + 커밋**

Run: `npx jest __tests__/services/toss.service.test.ts && npx tsc --noEmit`
Expected: 모든 테스트 PASS, tsc 0 errors

```bash
git add src/services/toss.service.ts __tests__/services/toss.service.test.ts
git commit -m "feat: TossService 시세/주문/계좌/종목마스터/휴장일 메서드 추가"
```

**중요**: 위 endpoint path는 가정값. 토스 공식 문서로 확인 후 구현 시 보정. 응답 schema도 동일.

---

## Task 5: 시장 시간 + 휴장일 서비스 (TDD)

**Files:**
- Create: `__tests__/services/korean-stock-market-hours.test.ts`
- Create: `src/services/korean-stock-market-hours.service.ts`

- [ ] **Step 1: 테스트 작성**

```typescript
// __tests__/services/korean-stock-market-hours.test.ts
import { isMarketOpen, getNextMarketOpenTime } from '../../src/services/korean-stock-market-hours.service';

jest.mock('../../__mocks__/database', () => ({
  default: {
    koreanMarketCalendar: {
      findUnique: jest.fn().mockResolvedValue(null), // default: 휴장일 아님
    },
  },
}));

// 모듈 mapper 함정 (빗썸 작업 학습) — direct require
jest.mock('../../src/config/database', () => require('../../__mocks__/database'));

describe('isMarketOpen', () => {
  it('평일 09:30 KST → true', async () => {
    const result = await isMarketOpen(new Date('2026-06-29T00:30:00Z')); // KST 09:30 월요일
    expect(result).toBe(true);
  });

  it('평일 15:30 KST → false (장 마감 시점 포함 X)', async () => {
    const result = await isMarketOpen(new Date('2026-06-29T06:30:00Z')); // KST 15:30
    expect(result).toBe(false);
  });

  it('평일 08:59 KST → false (장 시작 1분 전)', async () => {
    const result = await isMarketOpen(new Date('2026-06-29T-1:59:00Z'.replace('-1', '23')));
    expect(result).toBe(false); // 정확한 시간 계산은 구현에서
  });

  it('주말 (토요일) → false', async () => {
    const result = await isMarketOpen(new Date('2026-06-27T00:30:00Z')); // 토요일 KST 09:30
    expect(result).toBe(false);
  });

  it('휴장일 (DB row isOpen=false) → false', async () => {
    const { default: prisma } = require('../../__mocks__/database');
    prisma.koreanMarketCalendar.findUnique.mockResolvedValueOnce({ date: '2026-01-01', isOpen: false, reason: '신정' });
    const result = await isMarketOpen(new Date('2025-12-31T00:30:00Z')); // 2026-01-01 KST 09:30
    expect(result).toBe(false);
  });
});

describe('getNextMarketOpenTime', () => {
  it('금요일 16:00 KST → 다음 월요일 09:00 KST', async () => {
    const next = await getNextMarketOpenTime(new Date('2026-06-26T07:00:00Z')); // 금 KST 16:00
    expect(next.toISOString()).toContain('2026-06-29'); // 월요일
  });
});
```

- [ ] **Step 2: 서비스 구현**

```typescript
// src/services/korean-stock-market-hours.service.ts
import prisma from '../config/database';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MARKET_OPEN_MINUTES = 9 * 60;        // 09:00
const MARKET_CLOSE_MINUTES = 15 * 60 + 30; // 15:30

function toKST(now: Date): { date: Date; minutes: number; weekday: number; dateOnly: string } {
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  return {
    date: kst,
    minutes: kst.getUTCHours() * 60 + kst.getUTCMinutes(),
    weekday: kst.getUTCDay(), // 0=일, 6=토
    dateOnly: kst.toISOString().slice(0, 10),
  };
}

export async function isMarketOpen(now: Date = new Date()): Promise<boolean> {
  const kst = toKST(now);
  if (kst.weekday === 0 || kst.weekday === 6) return false;
  const cal = await prisma.koreanMarketCalendar.findUnique({ where: { date: new Date(kst.dateOnly) } });
  if (cal && !cal.isOpen) return false;
  return kst.minutes >= MARKET_OPEN_MINUTES && kst.minutes < MARKET_CLOSE_MINUTES;
}

export async function getNextMarketOpenTime(from: Date = new Date()): Promise<Date> {
  // 다음 영업일 09:00 KST 계산 (최대 7일 lookahead)
  for (let i = 0; i < 7; i++) {
    const candidate = new Date(from.getTime() + i * 24 * 60 * 60 * 1000);
    const kst = toKST(candidate);
    if (kst.weekday === 0 || kst.weekday === 6) continue;
    const cal = await prisma.koreanMarketCalendar.findUnique({ where: { date: new Date(kst.dateOnly) } });
    if (cal && !cal.isOpen) continue;
    // 같은 날인데 이미 09:00 지났으면 skip
    if (i === 0 && kst.minutes >= MARKET_OPEN_MINUTES) continue;
    // KST 09:00의 UTC 시각 계산
    const target = new Date(`${kst.dateOnly}T00:00:00.000Z`);
    return target;
  }
  throw new Error('다음 7일 내 영업일 없음 (휴장 연속)');
}

export async function shouldCancelPendingOrders(now: Date = new Date()): Promise<boolean> {
  // 15:30 도달 직후 1 cycle 동안만 true
  const kst = toKST(now);
  if (kst.weekday === 0 || kst.weekday === 6) return false;
  return kst.minutes >= MARKET_CLOSE_MINUTES && kst.minutes < MARKET_CLOSE_MINUTES + 1;
}
```

- [ ] **Step 3: 테스트 PASS + tsc + 커밋**

```bash
npx jest __tests__/services/korean-stock-market-hours.test.ts
npx tsc --noEmit
git add src/services/korean-stock-market-hours.service.ts __tests__/services/korean-stock-market-hours.test.ts
git commit -m "feat: 한국주식 시장 시간 + 휴장일 판단 서비스"
```

---

## Task 6: 호가 단위 유틸 (TDD)

**Files:**
- Create: `__tests__/utils/korean-stock-tick-size.test.ts`
- Create: `src/utils/korean-stock-tick-size.ts`

- [ ] **Step 1: 테스트 작성**

```typescript
// __tests__/utils/korean-stock-tick-size.test.ts
import { getTickSize, snapToTickSize } from '../../src/utils/korean-stock-tick-size';

describe('getTickSize (KOSPI 기준 2026)', () => {
  it.each([
    [1500, 1],       // ~2000원: 1원
    [3000, 5],       // 2000~5000: 5원
    [10000, 10],     // 5000~20000: 10원
    [30000, 50],     // 20000~50000: 50원
    [75000, 100],    // 50000~200000: 100원
    [300000, 500],   // 200000~500000: 500원
    [700000, 1000],  // 500000~: 1000원
  ])('가격 %d원 → 호가 단위 %d원', (price, expected) => {
    expect(getTickSize(price)).toBe(expected);
  });
});

describe('snapToTickSize', () => {
  it.each([
    [75123, 75100],  // 75100원으로 내림
    [75150, 75200],  // 75200원으로 반올림
    [3007, 3005],    // 3005원으로 내림
    [199999, 200000], // 50000~200000 → 100원 단위, 200000은 500원 단위 경계
  ])('가격 %d → 보정 %d', (input, expected) => {
    expect(snapToTickSize(input)).toBe(expected);
  });
});
```

- [ ] **Step 2: 구현**

```typescript
// src/utils/korean-stock-tick-size.ts
// KOSPI/KOSDAQ 호가 단위 (2026년 기준, 한국거래소 공식)
const TICK_TABLE: Array<{ max: number; tick: number }> = [
  { max: 2000, tick: 1 },
  { max: 5000, tick: 5 },
  { max: 20000, tick: 10 },
  { max: 50000, tick: 50 },
  { max: 200000, tick: 100 },
  { max: 500000, tick: 500 },
  { max: Infinity, tick: 1000 },
];

export function getTickSize(price: number): number {
  for (const row of TICK_TABLE) {
    if (price < row.max) return row.tick;
  }
  return 1000;
}

export function snapToTickSize(price: number): number {
  const tick = getTickSize(price);
  return Math.round(price / tick) * tick;
}
```

- [ ] **Step 3: 테스트 + tsc + 커밋**

```bash
npx jest __tests__/utils/korean-stock-tick-size.test.ts
git add src/utils/korean-stock-tick-size.ts __tests__/utils/korean-stock-tick-size.test.ts
git commit -m "feat: 한국주식 호가 단위 계산 + 보정 유틸"
```

---

## Task 7: 거래세/수수료 시뮬레이터 (TDD)

**Files:**
- Create: `__tests__/utils/korean-stock-fee-calculator.test.ts`
- Create: `src/utils/korean-stock-fee-calculator.ts`

- [ ] **Step 1: 테스트 작성**

```typescript
// __tests__/utils/korean-stock-fee-calculator.test.ts
import { simulateGridProfit, DEFAULT_FEE_RATE, DEFAULT_TAX_RATE } from '../../src/utils/korean-stock-fee-calculator';

describe('simulateGridProfit', () => {
  it('흑자 케이스 (그리드 간격 1.43%, 1만원 거래)', () => {
    const result = simulateGridProfit({
      buyPrice: 70000,
      sellPrice: 71000,
      orderAmount: 100000,
      feeRate: DEFAULT_FEE_RATE, // 0.00015
      taxRate: DEFAULT_TAX_RATE, // 0.0018
    });
    // 매수 100000원 (수수료 15원)
    // 매도 101428.57원 (수수료 ~15원 + 거래세 ~183원)
    expect(result.grossProfit).toBeCloseTo(1428.57, 0);
    expect(result.totalFees).toBeCloseTo(30, 0);
    expect(result.totalTax).toBeCloseTo(183, 0);
    expect(result.netProfit).toBeCloseTo(1215, 0);
    expect(result.netProfitPct).toBeCloseTo(1.22, 1);
    expect(result.warningLevel).toBe('ok');
  });

  it('손실 케이스 (그리드 간격 0.1% — 세금보다 작음)', () => {
    const result = simulateGridProfit({
      buyPrice: 70000,
      sellPrice: 70070,
      orderAmount: 100000,
      feeRate: DEFAULT_FEE_RATE,
      taxRate: DEFAULT_TAX_RATE,
    });
    expect(result.netProfit).toBeLessThan(0);
    expect(result.warningLevel).toBe('loss');
  });

  it('얇은 수익 케이스 (그리드 간격 0.3%)', () => {
    const result = simulateGridProfit({
      buyPrice: 70000,
      sellPrice: 70210,
      orderAmount: 100000,
      feeRate: DEFAULT_FEE_RATE,
      taxRate: DEFAULT_TAX_RATE,
    });
    expect(result.netProfit).toBeGreaterThan(0);
    expect(result.warningLevel).toBe('thin'); // 0.22% < 수익률 < 0.5%
  });
});
```

- [ ] **Step 2: 구현**

```typescript
// src/utils/korean-stock-fee-calculator.ts
export const DEFAULT_FEE_RATE = 0.00015; // 토스증권 0.015%
export const DEFAULT_TAX_RATE = 0.0018;  // 매도 거래세 0.18% (코스피/코스닥 동일, 2026)

export interface SimulateInput {
  buyPrice: number;
  sellPrice: number;
  orderAmount: number; // 1회 매수 금액
  feeRate?: number;
  taxRate?: number;
}

export interface SimulateResult {
  grossProfit: number;      // 수수료/세금 제외 차익
  totalFees: number;        // 양쪽 수수료 합
  totalTax: number;         // 매도 거래세
  netProfit: number;        // 실수익 (수수료/세금 차감 후)
  netProfitPct: number;     // 실수익률 (%)
  warningLevel: 'ok' | 'thin' | 'loss';
}

export function simulateGridProfit(input: SimulateInput): SimulateResult {
  const feeRate = input.feeRate ?? DEFAULT_FEE_RATE;
  const taxRate = input.taxRate ?? DEFAULT_TAX_RATE;

  const quantity = input.orderAmount / input.buyPrice;
  const buyTotal = quantity * input.buyPrice;
  const sellTotal = quantity * input.sellPrice;

  const buyFee = buyTotal * feeRate;
  const sellFee = sellTotal * feeRate;
  const sellTax = sellTotal * taxRate;

  const grossProfit = sellTotal - buyTotal;
  const totalFees = buyFee + sellFee;
  const totalTax = sellTax;
  const netProfit = grossProfit - totalFees - totalTax;
  const netProfitPct = (netProfit / buyTotal) * 100;

  let warningLevel: 'ok' | 'thin' | 'loss';
  if (netProfit < 0) warningLevel = 'loss';
  else if (netProfitPct < 0.5) warningLevel = 'thin';
  else warningLevel = 'ok';

  return { grossProfit, totalFees, totalTax, netProfit, netProfitPct, warningLevel };
}
```

- [ ] **Step 3: 테스트 + 커밋**

```bash
npx jest __tests__/utils/korean-stock-fee-calculator.test.ts
git add src/utils/korean-stock-fee-calculator.ts __tests__/utils/korean-stock-fee-calculator.test.ts
git commit -m "feat: 한국주식 거래세/수수료 시뮬레이터"
```

---

## Task 8: 그리드 가격 생성 + 호가 단위 보정 서비스

**Files:**
- Create: `__tests__/services/korean-stock-grid.test.ts`
- Create: `src/services/korean-stock-grid.service.ts`

`grid.service.ts`(코인)의 가격 분할 로직을 참조하되, 한국주식 호가 단위 보정 추가.

- [ ] **Step 1: 테스트 작성**

```typescript
// __tests__/services/korean-stock-grid.test.ts
import { calculateGridPrices, validateGridRange } from '../../src/services/korean-stock-grid.service';

describe('calculateGridPrices', () => {
  it('등분할 + 호가 단위 자동 보정', () => {
    const prices = calculateGridPrices({ lowerPrice: 70000, upperPrice: 80000, gridCount: 10 });
    expect(prices.length).toBe(11); // gridCount + 1 (양 끝 포함)
    expect(prices[0]).toBe(70000);
    expect(prices[10]).toBe(80000);
    // 모든 가격이 호가 단위 100원으로 보정
    for (const p of prices) {
      expect(p % 100).toBe(0);
    }
  });

  it('호가 단위 경계 가격 (49,950 → 50,000)', () => {
    const prices = calculateGridPrices({ lowerPrice: 49000, upperPrice: 51000, gridCount: 4 });
    // 49000(10원단위) ~ 51000(100원단위) 사이라 경계 처리
    expect(prices[0]).toBe(49000);
    expect(prices[4]).toBe(51000);
  });

  it('gridCount=2 최소 케이스', () => {
    const prices = calculateGridPrices({ lowerPrice: 10000, upperPrice: 12000, gridCount: 2 });
    expect(prices).toEqual([10000, 11000, 12000]);
  });
});

describe('validateGridRange', () => {
  it('상하한가(±30%) 안이면 OK', () => {
    const result = validateGridRange({ lowerPrice: 70000, upperPrice: 80000, prevClose: 75000 });
    expect(result.ok).toBe(true);
  });

  it('하한가 미만이면 에러', () => {
    const result = validateGridRange({ lowerPrice: 50000, upperPrice: 80000, prevClose: 75000 });
    // 하한가 = 75000 * 0.7 = 52500. lowerPrice 50000은 미만
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('하한가');
  });

  it('상한가 초과면 에러', () => {
    const result = validateGridRange({ lowerPrice: 70000, upperPrice: 100000, prevClose: 75000 });
    // 상한가 = 75000 * 1.3 = 97500
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('상한가');
  });

  it('lowerPrice >= upperPrice이면 에러', () => {
    const result = validateGridRange({ lowerPrice: 80000, upperPrice: 70000, prevClose: 75000 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('lower');
  });
});
```

- [ ] **Step 2: 구현**

```typescript
// src/services/korean-stock-grid.service.ts
import { snapToTickSize } from '../utils/korean-stock-tick-size';

export function calculateGridPrices(input: { lowerPrice: number; upperPrice: number; gridCount: number }): number[] {
  const { lowerPrice, upperPrice, gridCount } = input;
  if (gridCount < 2) throw new Error('gridCount must be >= 2');
  if (lowerPrice >= upperPrice) throw new Error('lowerPrice must be < upperPrice');

  const step = (upperPrice - lowerPrice) / gridCount;
  const prices: number[] = [];
  for (let i = 0; i <= gridCount; i++) {
    const raw = lowerPrice + step * i;
    prices.push(snapToTickSize(raw));
  }
  // 양 끝은 사용자 입력값 우선 (호가 보정 결과가 입력과 같지 않으면 입력값 사용)
  prices[0] = snapToTickSize(lowerPrice);
  prices[gridCount] = snapToTickSize(upperPrice);
  return prices;
}

export function validateGridRange(input: { lowerPrice: number; upperPrice: number; prevClose: number }): { ok: boolean; reason?: string } {
  const { lowerPrice, upperPrice, prevClose } = input;
  if (lowerPrice >= upperPrice) return { ok: false, reason: 'lowerPrice가 upperPrice보다 작아야 함' };
  const limitLow = prevClose * 0.7;
  const limitHigh = prevClose * 1.3;
  if (lowerPrice < limitLow) return { ok: false, reason: `하한가 ${Math.ceil(limitLow)}원 미만` };
  if (upperPrice > limitHigh) return { ok: false, reason: `상한가 ${Math.floor(limitHigh)}원 초과` };
  return { ok: true };
}
```

- [ ] **Step 3: 테스트 + tsc + 커밋**

```bash
npx jest __tests__/services/korean-stock-grid.test.ts
npx tsc --noEmit
git add src/services/korean-stock-grid.service.ts __tests__/services/korean-stock-grid.test.ts
git commit -m "feat: 한국주식 그리드 가격 생성 + 상하한가 검증"
```

---

## Task 9: 한국주식 봇 엔진

**Files:**
- Create: `src/services/korean-stock-bot-engine.service.ts`
- Create: `__tests__/services/korean-stock-bot-engine.test.ts`

코인 `bot-engine.service.ts`(621줄)는 건드리지 않음. 한국주식 전용 엔진 별도. cycle 시작 시 장 시간 가드 → 봇 조회 → 각 봇 처리 → 매수/매도 주문.

- [ ] **Step 1: 봇 엔진 구현**

```typescript
// src/services/korean-stock-bot-engine.service.ts
import prisma from '../config/database';
import { tossService } from './toss.service';
import { isMarketOpen, shouldCancelPendingOrders } from './korean-stock-market-hours.service';
import { calculateGridPrices } from './korean-stock-grid.service';
import { snapToTickSize } from '../utils/korean-stock-tick-size';
import { decrypt } from '../utils/encryption';

export class KoreanStockBotEngine {
  async runCycle(): Promise<void> {
    if (!await isMarketOpen()) {
      if (await shouldCancelPendingOrders()) {
        await this.cancelAllPendingOrders();
      }
      return;
    }

    const bots = await prisma.bot.findMany({
      where: { market: 'KOREAN_STOCK', status: 'running' },
      include: { gridLevels: true },
    });

    for (const bot of bots) {
      try {
        await this.processBot(bot);
      } catch (e: any) {
        console.error(`[KoreanStockBotEngine] bot ${bot.id} 오류:`, e?.message ?? e);
        await prisma.bot.update({
          where: { id: bot.id },
          data: { errorMessage: e?.message ?? String(e) },
        });
      }
    }
  }

  private async processBot(bot: any): Promise<void> {
    const cred = await prisma.credential.findFirst({
      where: { userId: bot.userId, exchange: 'toss', purpose: 'default' },
    });
    if (!cred || !cred.accountSeq) return;

    const clientId = decrypt(cred.apiKey);
    const clientSecret = decrypt(cred.secretKey);
    const accountSeq = cred.accountSeq;

    const quote = await tossService.getQuote(clientId, clientSecret, bot.ticker);
    const currentPrice = quote.price;

    for (const level of bot.gridLevels) {
      if (level.status !== 'available') continue;

      if (level.type === 'BUY' && currentPrice <= level.price) {
        const qty = Math.floor(bot.orderAmount / level.price);
        if (qty < 1) continue;
        const order = await tossService.placeOrder(clientId, clientSecret, accountSeq, {
          code: bot.ticker, side: 'BUY', quantity: qty, price: snapToTickSize(level.price), orderType: 'LIMIT',
        });
        await prisma.gridLevel.update({
          where: { id: level.id },
          data: { status: 'pending', orderId: order.orderId },
        });
      } else if (level.type === 'SELL' && currentPrice >= level.price) {
        const qty = Math.floor(bot.orderAmount / (level.buyPrice ?? level.price));
        const order = await tossService.placeOrder(clientId, clientSecret, accountSeq, {
          code: bot.ticker, side: 'SELL', quantity: qty, price: snapToTickSize(level.price), orderType: 'LIMIT',
        });
        await prisma.gridLevel.update({
          where: { id: level.id },
          data: { status: 'pending', orderId: order.orderId },
        });
      }
    }
  }

  private async cancelAllPendingOrders(): Promise<void> {
    const pendingLevels = await prisma.gridLevel.findMany({
      where: {
        bot: { market: 'KOREAN_STOCK', status: 'running' },
        status: 'pending',
        orderId: { not: null },
      },
      include: { bot: { include: { user: true } } },
    });
    for (const level of pendingLevels) {
      try {
        const cred = await prisma.credential.findFirst({
          where: { userId: level.bot.userId, exchange: 'toss', purpose: 'default' },
        });
        if (!cred || !cred.accountSeq) continue;
        await tossService.cancelOrder(decrypt(cred.apiKey), decrypt(cred.secretKey), cred.accountSeq, level.orderId!);
        await prisma.gridLevel.update({ where: { id: level.id }, data: { status: 'available', orderId: null } });
      } catch (e: any) {
        console.error(`[KoreanStockBotEngine] 취소 실패 (level ${level.id}):`, e?.message ?? e);
      }
    }
  }
}

export const koreanStockBotEngine = new KoreanStockBotEngine();
```

- [ ] **Step 2: 통합 테스트 (mock)**

```typescript
// __tests__/services/korean-stock-bot-engine.test.ts
import { koreanStockBotEngine } from '../../src/services/korean-stock-bot-engine.service';
import * as marketHours from '../../src/services/korean-stock-market-hours.service';
import { tossService } from '../../src/services/toss.service';

jest.mock('../../src/services/korean-stock-market-hours.service');
jest.mock('../../src/services/toss.service');
jest.mock('../../src/utils/encryption', () => ({ decrypt: (s: string) => `decrypted_${s}` }));
jest.mock('../../src/config/database', () => require('../../__mocks__/database'));

const mockIsMarketOpen = marketHours.isMarketOpen as jest.MockedFunction<typeof marketHours.isMarketOpen>;
const mockShouldCancel = marketHours.shouldCancelPendingOrders as jest.MockedFunction<typeof marketHours.shouldCancelPendingOrders>;

describe('KoreanStockBotEngine.runCycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const { default: prisma } = require('../../__mocks__/database');
    prisma.bot.findMany.mockResolvedValue([]);
  });

  it('장 마감 시간이면 즉시 return + 미체결 취소 호출 안 함 (15:35같은 일반 시간)', async () => {
    mockIsMarketOpen.mockResolvedValue(false);
    mockShouldCancel.mockResolvedValue(false);
    await koreanStockBotEngine.runCycle();
    expect(tossService.getQuote).not.toHaveBeenCalled();
  });

  it('장 마감 직후 (15:30:00 ~ 15:30:59) → cancelAllPendingOrders 호출', async () => {
    mockIsMarketOpen.mockResolvedValue(false);
    mockShouldCancel.mockResolvedValue(true);
    const { default: prisma } = require('../../__mocks__/database');
    prisma.gridLevel.findMany.mockResolvedValue([]);
    await koreanStockBotEngine.runCycle();
    expect(prisma.gridLevel.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'pending' }),
    }));
  });

  it('장 시간 + running 봇 1개 + BUY level이 현재가에 도달 → placeOrder 호출', async () => {
    mockIsMarketOpen.mockResolvedValue(true);
    const { default: prisma } = require('../../__mocks__/database');
    prisma.bot.findMany.mockResolvedValueOnce([{
      id: 1, userId: 2, ticker: '005930', orderAmount: 100000,
      gridLevels: [
        { id: 11, type: 'BUY', price: 75000, status: 'available' },
      ],
    }]);
    prisma.credential.findFirst.mockResolvedValueOnce({ apiKey: 'enc_id', secretKey: 'enc_sec', accountSeq: 'acc_1' });
    (tossService.getQuote as jest.Mock).mockResolvedValueOnce({ code: '005930', price: 74500, timestamp: '...' });
    (tossService.placeOrder as jest.Mock).mockResolvedValueOnce({ orderId: 'ord_42', status: 'pending' });

    await koreanStockBotEngine.runCycle();

    expect(tossService.placeOrder).toHaveBeenCalledWith('decrypted_enc_id', 'decrypted_enc_sec', 'acc_1', expect.objectContaining({
      code: '005930', side: 'BUY', price: 75000,
    }));
    expect(prisma.gridLevel.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: { status: 'pending', orderId: 'ord_42' },
    });
  });
});
```

- [ ] **Step 3: __mocks__/database.ts에 bot/gridLevel/credential 추가**

```typescript
// __mocks__/database.ts에 다음 추가 (없으면)
default: {
  // ... 기존 ...
  bot: { findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  gridLevel: { findMany: jest.fn(), update: jest.fn(), create: jest.fn() },
  credential: { findFirst: jest.fn() },
  koreanStockSymbol: { findMany: jest.fn(), upsert: jest.fn() },
  koreanMarketCalendar: { findUnique: jest.fn(), upsert: jest.fn() },
}
```

- [ ] **Step 4: 테스트 + tsc + 커밋**

```bash
npx jest __tests__/services/korean-stock-bot-engine.test.ts
npx tsc --noEmit
git add src/services/korean-stock-bot-engine.service.ts __tests__/services/korean-stock-bot-engine.test.ts __mocks__/database.ts
git commit -m "feat: 한국주식 그리드 봇 엔진 (cycle/주문/장마감 취소)"
```

---

## Task 10: KoreanStockGridAgent + 등록

**Files:**
- Create: `src/agents/korean-stock-grid-agent.ts`
- Modify: `src/agents/index.ts`
- Modify: `src/index.ts` (agent-manager.register 호출)

- [ ] **Step 1: 에이전트 작성**

```typescript
// src/agents/korean-stock-grid-agent.ts
import { BaseAgent } from './base-agent';
import { koreanStockBotEngine } from '../services/korean-stock-bot-engine.service';

export class KoreanStockGridAgent extends BaseAgent {
  constructor() {
    super({
      id: 'korean-stock-grid',
      name: 'KoreanStockGridAgent',
      description: '한국주식 그리드 매매 봇 (5초 cycle, 장 시간만)',
      cycleIntervalMs: 5_000,
    });
  }

  protected async onStart(): Promise<void> {
    console.log('[KoreanStockGridAgent] 시작 — 5초 cycle');
  }

  protected async onCycle(): Promise<void> {
    await koreanStockBotEngine.runCycle();
  }

  protected async onStop(): Promise<void> {
    console.log('[KoreanStockGridAgent] 종료');
  }
}

export const koreanStockGridAgent = new KoreanStockGridAgent();
```

- [ ] **Step 2: index.ts에 export 추가**

`src/agents/index.ts`:
```typescript
export { KoreanStockGridAgent, koreanStockGridAgent } from './korean-stock-grid-agent';
```

- [ ] **Step 3: agent-manager 등록**

`src/index.ts`에서 `BithumbListingMonitorAgent` 등록 옆에:
```typescript
agentManager.register(new KoreanStockGridAgent());
```

- [ ] **Step 4: tsc + 커밋**

```bash
npx tsc --noEmit
git add src/agents/korean-stock-grid-agent.ts src/agents/index.ts src/index.ts
git commit -m "feat: KoreanStockGridAgent + agent-manager 등록"
```

---

## Task 11: 종목 마스터 sync 서비스 + 에이전트

**Files:**
- Create: `src/services/korean-stock-symbol-sync.service.ts`
- Create: `src/agents/korean-stock-symbol-sync-agent.ts`
- Modify: `src/agents/index.ts`, `src/index.ts`

일 1회 (KST 16:00 = UTC 07:00) 종목 마스터 sync. 토스 API 사용을 위해 관리자 토스 키 필요 — `src/config/env.ts`의 `TOSS_ADMIN_CLIENT_ID`/`TOSS_ADMIN_CLIENT_SECRET` 사용 (또는 첫 번째 사용자 credential 사용).

- [ ] **Step 1: sync 서비스 작성**

```typescript
// src/services/korean-stock-symbol-sync.service.ts
import prisma from '../config/database';
import { tossService } from './toss.service';

export class KoreanStockSymbolSyncService {
  // 환경변수로 관리자용 토스 키 주입 (개발 초기는 첫 번째 사용자 키 fallback)
  async syncAll(): Promise<{ inserted: number; updated: number }> {
    const clientId = process.env.TOSS_ADMIN_CLIENT_ID;
    const clientSecret = process.env.TOSS_ADMIN_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      console.warn('[KoreanStockSymbolSync] TOSS_ADMIN_CLIENT_ID 미설정 — sync skip');
      return { inserted: 0, updated: 0 };
    }

    const symbols = await tossService.getSymbolMaster(clientId, clientSecret);
    let inserted = 0, updated = 0;
    for (const sym of symbols) {
      const existing = await prisma.koreanStockSymbol.findUnique({ where: { code: sym.code } });
      await prisma.koreanStockSymbol.upsert({
        where: { code: sym.code },
        create: { code: sym.code, name: sym.name, market: sym.market, sector: (sym as any).sector ?? null },
        update: { name: sym.name, market: sym.market, sector: (sym as any).sector ?? null },
      });
      if (existing) updated++; else inserted++;
    }
    console.log(`[KoreanStockSymbolSync] 완료: 신규 ${inserted}, 갱신 ${updated}`);
    return { inserted, updated };
  }
}

export const koreanStockSymbolSyncService = new KoreanStockSymbolSyncService();
```

- [ ] **Step 2: 에이전트 (일일 cron)**

```typescript
// src/agents/korean-stock-symbol-sync-agent.ts
import { BaseAgent } from './base-agent';
import { koreanStockSymbolSyncService } from '../services/korean-stock-symbol-sync.service';

const ONE_HOUR_MS = 60 * 60 * 1000;
const SYNC_HOUR_KST = 16;

export class KoreanStockSymbolSyncAgent extends BaseAgent {
  private lastSyncDate: string | null = null;

  constructor() {
    super({
      id: 'korean-stock-symbol-sync',
      name: 'KoreanStockSymbolSyncAgent',
      description: '한국주식 종목 마스터 일일 sync (KST 16:00)',
      cycleIntervalMs: ONE_HOUR_MS,
    });
  }

  protected async onStart(): Promise<void> {
    console.log('[KoreanStockSymbolSyncAgent] 시작');
  }

  protected async onCycle(): Promise<void> {
    const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const kstHour = kst.getUTCHours();
    const dateOnly = kst.toISOString().slice(0, 10);

    if (kstHour !== SYNC_HOUR_KST) return;
    if (this.lastSyncDate === dateOnly) return;

    try {
      const result = await koreanStockSymbolSyncService.syncAll();
      this.lastSyncDate = dateOnly;
      console.log(`[KoreanStockSymbolSyncAgent] sync 완료: ${JSON.stringify(result)}`);
    } catch (e: any) {
      console.error('[KoreanStockSymbolSyncAgent] sync 실패:', e?.message ?? e);
    }
  }

  protected async onStop(): Promise<void> {}
}

export const koreanStockSymbolSyncAgent = new KoreanStockSymbolSyncAgent();
```

- [ ] **Step 3: index.ts export + agent-manager 등록**

`src/agents/index.ts`:
```typescript
export { KoreanStockSymbolSyncAgent, koreanStockSymbolSyncAgent } from './korean-stock-symbol-sync-agent';
```

`src/index.ts`:
```typescript
agentManager.register(new KoreanStockSymbolSyncAgent());
```

- [ ] **Step 4: tsc + 커밋**

```bash
npx tsc --noEmit
git add src/services/korean-stock-symbol-sync.service.ts src/agents/korean-stock-symbol-sync-agent.ts src/agents/index.ts src/index.ts
git commit -m "feat: 한국주식 종목 마스터 일일 sync 에이전트 (KST 16:00)"
```

---

## Task 12: 휴장일 초기 데이터 + 환경변수 문서화

**Files:**
- Create: `scripts/seed-korean-market-calendar.ts`
- Modify: `src/config/env.ts` (TOSS_ADMIN_* 추가)
- Modify: `.env.example` (있다면)

토스 휴장일 API 호출 가능해질 때까지 fallback으로 2026년 KRX 공식 휴장일 수동 입력. 사용자가 sync agent 동작 시 토스 API로 자동 갱신.

- [ ] **Step 1: 시드 스크립트**

```typescript
// scripts/seed-korean-market-calendar.ts
import prisma from '../src/config/database';

// 2026년 KRX 공식 휴장일 (한국거래소 공시 기준)
const HOLIDAYS_2026: Array<{ date: string; reason: string }> = [
  { date: '2026-01-01', reason: '신정' },
  { date: '2026-02-16', reason: '설날 연휴' },
  { date: '2026-02-17', reason: '설날' },
  { date: '2026-02-18', reason: '설날 연휴' },
  { date: '2026-03-01', reason: '삼일절' },
  { date: '2026-05-05', reason: '어린이날' },
  { date: '2026-05-25', reason: '석가탄신일' },
  { date: '2026-06-06', reason: '현충일' },
  { date: '2026-08-15', reason: '광복절' },
  { date: '2026-09-25', reason: '추석 연휴' },
  { date: '2026-09-26', reason: '추석' },
  { date: '2026-09-27', reason: '추석 연휴' },
  { date: '2026-10-03', reason: '개천절' },
  { date: '2026-10-09', reason: '한글날' },
  { date: '2026-12-25', reason: '성탄절' },
  { date: '2026-12-31', reason: '연말 마지막 거래일 (조기 폐장)' }, // 부분 휴장
];

async function main() {
  let inserted = 0;
  for (const h of HOLIDAYS_2026) {
    await prisma.koreanMarketCalendar.upsert({
      where: { date: new Date(h.date) },
      create: { date: new Date(h.date), isOpen: false, reason: h.reason },
      update: { isOpen: false, reason: h.reason },
    });
    inserted++;
  }
  console.log(`Seeded ${inserted} holidays for 2026`);
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: env 추가**

`src/config/env.ts`에:
```typescript
export const env = {
  // ... 기존 ...
  TOSS_API_URL: process.env.TOSS_API_URL || 'https://wts-openapi.tossinvest.com',
  TOSS_ADMIN_CLIENT_ID: process.env.TOSS_ADMIN_CLIENT_ID, // 종목 마스터 sync용 (관리자 키)
  TOSS_ADMIN_CLIENT_SECRET: process.env.TOSS_ADMIN_CLIENT_SECRET,
};
```

`.env.example` (있다면):
```
TOSS_API_URL=https://wts-openapi.tossinvest.com
TOSS_ADMIN_CLIENT_ID=
TOSS_ADMIN_CLIENT_SECRET=
```

- [ ] **Step 3: 시드 실행**

Run: `npx ts-node scripts/seed-korean-market-calendar.ts`
Expected: `Seeded 16 holidays for 2026`

- [ ] **Step 4: 커밋**

```bash
git add scripts/seed-korean-market-calendar.ts src/config/env.ts .env.example
git commit -m "feat: 한국주식 2026년 휴장일 시드 + TOSS_ADMIN env"
```

---

## Task 13: 한국주식 컨트롤러 (봇 CRUD + 종목 검색 + 시뮬레이션)

**Files:**
- Create: `src/controllers/korean-stock.controller.ts`
- Create: `src/routes/korean-stock.ts`
- Modify: `src/routes/index.ts`

- [ ] **Step 1: 컨트롤러 작성**

```typescript
// src/controllers/korean-stock.controller.ts
import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middlewares/auth';
import prisma from '../config/database';
import { tossService } from '../services/toss.service';
import { simulateGridProfit, DEFAULT_FEE_RATE, DEFAULT_TAX_RATE } from '../utils/korean-stock-fee-calculator';
import { calculateGridPrices, validateGridRange } from '../services/korean-stock-grid.service';
import { decrypt } from '../utils/encryption';
import { successResponse, errorResponse } from '../utils/response';

// GET /api/korean-stocks/symbols/search?q=삼성&limit=20
export const searchSymbols = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    if (q.length < 1) return successResponse(res, []);
    const symbols = await prisma.koreanStockSymbol.findMany({
      where: {
        OR: [
          { code: { startsWith: q } },
          { name: { startsWith: q } },
          { name: { contains: q } },
        ],
      },
      take: limit,
      orderBy: { name: 'asc' },
    });
    return successResponse(res, symbols);
  } catch (e) { next(e); }
};

// POST /api/korean-stocks/simulate
// body: { buyPrice, sellPrice, orderAmount, feeRate?, taxRate? }
export const simulate = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { buyPrice, sellPrice, orderAmount, feeRate, taxRate } = req.body;
    if (!buyPrice || !sellPrice || !orderAmount) {
      return errorResponse(res, 400, 'buyPrice, sellPrice, orderAmount 필수');
    }
    const result = simulateGridProfit({ buyPrice, sellPrice, orderAmount, feeRate, taxRate });
    return successResponse(res, result);
  } catch (e) { next(e); }
};

// GET /api/korean-stocks/balance
export const getBalance = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const cred = await prisma.credential.findFirst({
      where: { userId, exchange: 'toss', purpose: 'default' },
    });
    if (!cred || !cred.accountSeq) {
      return errorResponse(res, 400, '토스 API 키가 등록되지 않았습니다');
    }
    const balance = await tossService.getAccountBalance(decrypt(cred.apiKey), decrypt(cred.secretKey), cred.accountSeq);
    return successResponse(res, balance);
  } catch (e) { next(e); }
};

// GET /api/korean-stocks/bots
export const listBots = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const bots = await prisma.bot.findMany({
      where: { userId, market: 'KOREAN_STOCK', deletedAt: null },
      include: { gridLevels: true },
      orderBy: { createdAt: 'desc' },
    });
    return successResponse(res, bots);
  } catch (e) { next(e); }
};

// POST /api/korean-stocks/bots
// body: { ticker, lowerPrice, upperPrice, gridCount, orderAmount, feeRate?, taxRate?, prevClose }
export const createBot = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const { ticker, lowerPrice, upperPrice, gridCount, orderAmount, feeRate, taxRate, prevClose } = req.body;

    // 검증
    const validation = validateGridRange({ lowerPrice, upperPrice, prevClose });
    if (!validation.ok) return errorResponse(res, 400, validation.reason!);

    // 종목 존재 확인
    const symbol = await prisma.koreanStockSymbol.findUnique({ where: { code: ticker } });
    if (!symbol) return errorResponse(res, 400, `존재하지 않는 종목코드: ${ticker}`);

    // 그리드 가격 계산
    const prices = calculateGridPrices({ lowerPrice, upperPrice, gridCount });

    // Bot + GridLevel 생성
    const bot = await prisma.bot.create({
      data: {
        userId,
        market: 'KOREAN_STOCK',
        exchange: 'toss' as any,
        ticker,
        lowerPrice: prices[0],
        upperPrice: prices[prices.length - 1],
        priceChangePercent: ((prices[1] - prices[0]) / prices[0]) * 100,
        gridCount,
        orderAmount,
        feeRate: feeRate ?? DEFAULT_FEE_RATE,
        taxRate: taxRate ?? DEFAULT_TAX_RATE,
        investmentAmount: orderAmount * gridCount,
        status: 'stopped',
        gridLevels: {
          create: prices.map(price => ({
            price,
            type: price < (lowerPrice + upperPrice) / 2 ? 'BUY' : 'SELL',
            status: 'available',
          })),
        },
      },
      include: { gridLevels: true },
    });

    return successResponse(res, bot);
  } catch (e) { next(e); }
};

// PUT /api/korean-stocks/bots/:id (status 변경: start/stop)
export const updateBot = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const botId = Number(req.params.id);
    const { status } = req.body;
    if (!['running', 'stopped'].includes(status)) return errorResponse(res, 400, 'status는 running 또는 stopped');

    const bot = await prisma.bot.update({
      where: { id: botId, userId, market: 'KOREAN_STOCK' } as any,
      data: { status, errorMessage: null },
    });
    return successResponse(res, bot);
  } catch (e) { next(e); }
};

// DELETE /api/korean-stocks/bots/:id (soft delete)
export const deleteBot = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const botId = Number(req.params.id);
    await prisma.bot.update({
      where: { id: botId, userId } as any,
      data: { status: 'stopped', deletedAt: new Date() },
    });
    return successResponse(res, { ok: true });
  } catch (e) { next(e); }
};
```

- [ ] **Step 2: 라우트 파일**

```typescript
// src/routes/korean-stock.ts
import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth';
import * as ctrl from '../controllers/korean-stock.controller';

const router = Router();
router.use(authMiddleware);

router.get('/symbols/search', ctrl.searchSymbols);
router.post('/simulate', ctrl.simulate);
router.get('/balance', ctrl.getBalance);
router.get('/bots', ctrl.listBots);
router.post('/bots', ctrl.createBot);
router.put('/bots/:id', ctrl.updateBot);
router.delete('/bots/:id', ctrl.deleteBot);

export default router;
```

- [ ] **Step 3: index.ts 마운트**

`src/routes/index.ts`에:
```typescript
import koreanStockRoutes from './korean-stock';
router.use('/korean-stocks', koreanStockRoutes);
```

- [ ] **Step 4: tsc + 커밋**

```bash
npx tsc --noEmit
git add src/controllers/korean-stock.controller.ts src/routes/korean-stock.ts src/routes/index.ts
git commit -m "feat: 한국주식 API — 봇 CRUD + 종목 검색 + 시뮬레이션 + 잔액"
```

---

## Task 14: 토스 credential 컨트롤러

**Files:**
- Create: `src/controllers/toss-credential.controller.ts`
- Create: `src/routes/toss-credential.ts`
- Modify: `src/routes/index.ts`

기존 `credential.controller.ts` 패턴 참조 (upbit/coinone과 같은 패턴).

- [ ] **Step 1: 컨트롤러**

```typescript
// src/controllers/toss-credential.controller.ts
import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middlewares/auth';
import prisma from '../config/database';
import { encrypt, decrypt } from '../utils/encryption';
import { tossService } from '../services/toss.service';
import { successResponse, errorResponse } from '../utils/response';

// POST /api/toss-credentials
// body: { clientId, clientSecret, accountSeq }
export const saveCredential = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const { clientId, clientSecret, accountSeq } = req.body;
    if (!clientId || !clientSecret || !accountSeq) {
      return errorResponse(res, 400, 'clientId, clientSecret, accountSeq 필수');
    }

    // 검증: 실제로 토스 API에 토큰 발급 시도
    try {
      await tossService.getAccessToken(clientId, clientSecret);
    } catch (e: any) {
      return errorResponse(res, 400, `토스 API 키 검증 실패: ${e.message}`);
    }

    const cred = await prisma.credential.upsert({
      where: { userId_exchange_purpose: { userId, exchange: 'toss' as any, purpose: 'default' } },
      create: {
        userId, exchange: 'toss' as any, purpose: 'default',
        apiKey: encrypt(clientId),
        secretKey: encrypt(clientSecret),
        accountSeq,
      },
      update: {
        apiKey: encrypt(clientId),
        secretKey: encrypt(clientSecret),
        accountSeq,
      },
    });
    return successResponse(res, { id: cred.id, accountSeq: cred.accountSeq, hasKey: true });
  } catch (e) { next(e); }
};

// GET /api/toss-credentials/me (등록 여부만, 키 자체는 반환 X)
export const getCredentialStatus = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const cred = await prisma.credential.findFirst({
      where: { userId, exchange: 'toss' as any, purpose: 'default' },
    });
    if (!cred) return successResponse(res, { registered: false });
    return successResponse(res, { registered: true, accountSeq: cred.accountSeq });
  } catch (e) { next(e); }
};

// DELETE /api/toss-credentials/me
export const deleteCredential = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    await prisma.credential.deleteMany({
      where: { userId, exchange: 'toss' as any, purpose: 'default' },
    });
    return successResponse(res, { ok: true });
  } catch (e) { next(e); }
};
```

- [ ] **Step 2: 라우트**

```typescript
// src/routes/toss-credential.ts
import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth';
import * as ctrl from '../controllers/toss-credential.controller';

const router = Router();
router.use(authMiddleware);

router.post('/', ctrl.saveCredential);
router.get('/me', ctrl.getCredentialStatus);
router.delete('/me', ctrl.deleteCredential);

export default router;
```

- [ ] **Step 3: index.ts 마운트**

```typescript
import tossCredentialRoutes from './toss-credential';
router.use('/toss-credentials', tossCredentialRoutes);
```

- [ ] **Step 4: tsc + 커밋**

```bash
npx tsc --noEmit
git add src/controllers/toss-credential.controller.ts src/routes/toss-credential.ts src/routes/index.ts
git commit -m "feat: 토스 API 키 등록/조회/삭제 컨트롤러"
```

---

## Task 15: 프론트엔드 lib/api.ts 함수 추가

**Files (프론트엔드 디렉토리: `v0-grid-transaction-frontend/`)**
- Modify: `lib/api.ts`

- [ ] **Step 1: 타입 + 함수 추가**

`lib/api.ts` 끝에 추가:

```typescript
// ─── 한국주식 그리드 ──────────────────────────────────────────

export type KoreanStockSymbol = {
  code: string;
  name: string;
  market: string; // "KOSPI" / "KOSDAQ"
  sector?: string | null;
};

export type SimulateInput = {
  buyPrice: number;
  sellPrice: number;
  orderAmount: number;
  feeRate?: number;
  taxRate?: number;
};

export type SimulateResult = {
  grossProfit: number;
  totalFees: number;
  totalTax: number;
  netProfit: number;
  netProfitPct: number;
  warningLevel: 'ok' | 'thin' | 'loss';
};

export type TossBalance = {
  krwBalance: number;
  holdings: Array<{ code: string; quantity: number; avgPrice: number }>;
};

export type KoreanStockBot = {
  id: number;
  ticker: string;
  lowerPrice: number;
  upperPrice: number;
  gridCount: number;
  orderAmount: number;
  feeRate: number | null;
  taxRate: number | null;
  status: 'running' | 'stopped' | 'error';
  currentProfit: number;
  totalTrades: number;
  errorMessage: string | null;
  createdAt: string;
};

export type CreateKoreanStockBotInput = {
  ticker: string;
  lowerPrice: number;
  upperPrice: number;
  gridCount: number;
  orderAmount: number;
  feeRate?: number;
  taxRate?: number;
  prevClose: number;
};

export async function searchKoreanStockSymbols(q: string, limit = 20): Promise<KoreanStockSymbol[]> {
  const res = await fetch(`${API_URL}/api/korean-stocks/symbols/search?q=${encodeURIComponent(q)}&limit=${limit}`, { headers: authHeaders() });
  await handleResponse(res);
  const data = await res.json();
  return data.data;
}

export async function simulateKoreanStockProfit(input: SimulateInput): Promise<SimulateResult> {
  const res = await fetch(`${API_URL}/api/korean-stocks/simulate`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  await handleResponse(res);
  const data = await res.json();
  return data.data;
}

export async function fetchTossBalance(): Promise<TossBalance> {
  const res = await fetch(`${API_URL}/api/korean-stocks/balance`, { headers: authHeaders() });
  await handleResponse(res);
  const data = await res.json();
  return data.data;
}

export async function listKoreanStockBots(): Promise<KoreanStockBot[]> {
  const res = await fetch(`${API_URL}/api/korean-stocks/bots`, { headers: authHeaders() });
  await handleResponse(res);
  const data = await res.json();
  return data.data;
}

export async function createKoreanStockBot(input: CreateKoreanStockBotInput): Promise<KoreanStockBot> {
  const res = await fetch(`${API_URL}/api/korean-stocks/bots`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  await handleResponse(res);
  const data = await res.json();
  return data.data;
}

export async function updateKoreanStockBotStatus(id: number, status: 'running' | 'stopped'): Promise<KoreanStockBot> {
  const res = await fetch(`${API_URL}/api/korean-stocks/bots/${id}`, {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  await handleResponse(res);
  const data = await res.json();
  return data.data;
}

export async function deleteKoreanStockBot(id: number): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_URL}/api/korean-stocks/bots/${id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  await handleResponse(res);
  const data = await res.json();
  return data.data;
}

// ─── 토스 Credential ──────────────────────────────────────────

export type TossCredentialStatus = { registered: boolean; accountSeq?: string };

export async function saveTossCredential(input: { clientId: string; clientSecret: string; accountSeq: string }) {
  const res = await fetch(`${API_URL}/api/toss-credentials`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  await handleResponse(res);
  const data = await res.json();
  return data.data;
}

export async function getTossCredentialStatus(): Promise<TossCredentialStatus> {
  const res = await fetch(`${API_URL}/api/toss-credentials/me`, { headers: authHeaders() });
  await handleResponse(res);
  const data = await res.json();
  return data.data;
}

export async function deleteTossCredential(): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_URL}/api/toss-credentials/me`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  await handleResponse(res);
  const data = await res.json();
  return data.data;
}
```

- [ ] **Step 2: 빌드 확인**

Run: `npm run build`
Expected: 빌드 성공

- [ ] **Step 3: 커밋**

```bash
git add lib/api.ts
git commit -m "feat: lib/api.ts에 한국주식 그리드 + 토스 credential API 함수 추가"
```

---

## Task 16: 공통 컴포넌트 (SymbolSearch + FeeSimulator + MarketStatusCard)

**Files (프론트엔드)**
- Create: `app/korean-stocks/_components/SymbolSearch.tsx`
- Create: `app/korean-stocks/_components/FeeSimulator.tsx`
- Create: `app/korean-stocks/_components/MarketStatusCard.tsx`

- [ ] **Step 1: SymbolSearch (자동완성)**

```tsx
// app/korean-stocks/_components/SymbolSearch.tsx
"use client"
import { useState, useEffect, useCallback } from "react"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { searchKoreanStockSymbols, type KoreanStockSymbol } from "@/lib/api"

interface Props {
  onSelect: (symbol: KoreanStockSymbol) => void;
}

export function SymbolSearch({ onSelect }: Props) {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<KoreanStockSymbol[]>([])
  const [loading, setLoading] = useState(false)

  // debounce 300ms
  useEffect(() => {
    if (query.length < 1) { setResults([]); return }
    const t = setTimeout(async () => {
      setLoading(true)
      try {
        const data = await searchKoreanStockSymbols(query)
        setResults(data)
      } catch (e) { console.error(e) }
      finally { setLoading(false) }
    }, 300)
    return () => clearTimeout(t)
  }, [query])

  return (
    <div>
      <Input
        type="text"
        placeholder="종목명 또는 코드 입력 (예: 삼성, 005930)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {loading && <p className="text-sm text-muted-foreground mt-2">검색 중...</p>}
      {results.length > 0 && (
        <div className="mt-2 border rounded-lg max-h-80 overflow-y-auto">
          {results.map((s) => (
            <button
              key={s.code}
              className="w-full text-left p-3 hover:bg-muted flex items-center justify-between"
              onClick={() => { onSelect(s); setQuery(""); setResults([]); }}
            >
              <div>
                <div className="font-medium">{s.name}</div>
                <div className="text-sm text-muted-foreground">{s.code}</div>
              </div>
              <Badge variant="outline">{s.market}</Badge>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: FeeSimulator**

```tsx
// app/korean-stocks/_components/FeeSimulator.tsx
"use client"
import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { simulateKoreanStockProfit, type SimulateResult } from "@/lib/api"

interface Props {
  buyPrice: number;
  sellPrice: number;
  orderAmount: number;
}

export function FeeSimulator({ buyPrice, sellPrice, orderAmount }: Props) {
  const [result, setResult] = useState<SimulateResult | null>(null)

  useEffect(() => {
    if (buyPrice <= 0 || sellPrice <= 0 || orderAmount <= 0 || sellPrice <= buyPrice) {
      setResult(null); return
    }
    simulateKoreanStockProfit({ buyPrice, sellPrice, orderAmount }).then(setResult).catch(console.error)
  }, [buyPrice, sellPrice, orderAmount])

  if (!result) return null

  const badgeProps = result.warningLevel === 'ok'
    ? { variant: 'outline' as const, className: 'text-green-600 border-green-500', label: '✅ 흑자' }
    : result.warningLevel === 'thin'
    ? { variant: 'outline' as const, className: 'text-yellow-600 border-yellow-500', label: '⚠️ 얇은 수익' }
    : { variant: 'outline' as const, className: 'text-red-600 border-red-500', label: '❌ 손실' }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          1회 거래 시뮬레이션
          <Badge variant={badgeProps.variant} className={badgeProps.className}>{badgeProps.label}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        <div className="flex justify-between"><span>매수가</span><span>{buyPrice.toLocaleString()}원</span></div>
        <div className="flex justify-between"><span>매도가</span><span>{sellPrice.toLocaleString()}원</span></div>
        <div className="flex justify-between"><span>1회 주문 금액</span><span>{orderAmount.toLocaleString()}원</span></div>
        <hr className="my-2" />
        <div className="flex justify-between"><span>차익 (세금/수수료 제외)</span><span>{Math.round(result.grossProfit).toLocaleString()}원</span></div>
        <div className="flex justify-between text-muted-foreground"><span>- 매수/매도 수수료</span><span>{Math.round(result.totalFees).toLocaleString()}원</span></div>
        <div className="flex justify-between text-muted-foreground"><span>- 매도 거래세 (0.18%)</span><span>{Math.round(result.totalTax).toLocaleString()}원</span></div>
        <hr className="my-2" />
        <div className="flex justify-between font-medium"><span>실수익</span><span className={result.netProfit < 0 ? 'text-red-600' : 'text-green-600'}>{Math.round(result.netProfit).toLocaleString()}원 ({result.netProfitPct.toFixed(2)}%)</span></div>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 3: MarketStatusCard**

```tsx
// app/korean-stocks/_components/MarketStatusCard.tsx
"use client"
import { useState, useEffect } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

function getKSTNow() {
  const utc = Date.now() + new Date().getTimezoneOffset() * 60000
  return new Date(utc + 9 * 3600000)
}

function isMarketOpenSimple(now: Date): boolean {
  const day = now.getUTCDay()
  if (day === 0 || day === 6) return false
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()
  return minutes >= 9 * 60 && minutes < 15 * 60 + 30
}

export function MarketStatusCard() {
  const [now, setNow] = useState(getKSTNow())

  useEffect(() => {
    const t = setInterval(() => setNow(getKSTNow()), 30_000)
    return () => clearInterval(t)
  }, [])

  const open = isMarketOpenSimple(now)
  const timeStr = `${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}`

  return (
    <Card>
      <CardContent className="flex items-center justify-between p-4">
        <div>
          <div className="text-sm text-muted-foreground">한국 주식시장</div>
          <div className="text-lg font-medium">{timeStr} KST</div>
        </div>
        <Badge variant="outline" className={open ? 'text-green-600 border-green-500' : 'text-gray-500'}>
          {open ? '🟢 장 운영 중' : '⚪ 장 마감'}
        </Badge>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 4: 커밋**

```bash
git add app/korean-stocks/_components/
git commit -m "feat: 한국주식 페이지 공통 컴포넌트 — 종목 검색/시뮬레이터/장 상태"
```

---

## Task 17: 봇 등록 마법사 (4 step)

**Files:**
- Create: `app/korean-stocks/_components/BotWizard.tsx`

- [ ] **Step 1: 마법사 작성 (4 step, useState 기반)**

```tsx
// app/korean-stocks/_components/BotWizard.tsx
"use client"
import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SymbolSearch } from "./SymbolSearch"
import { FeeSimulator } from "./FeeSimulator"
import { createKoreanStockBot, fetchTossBalance, type KoreanStockSymbol } from "@/lib/api"

interface Props {
  onComplete: () => void;
  onCancel: () => void;
}

export function BotWizard({ onComplete, onCancel }: Props) {
  const [step, setStep] = useState(1)
  const [symbol, setSymbol] = useState<KoreanStockSymbol | null>(null)
  const [prevClose, setPrevClose] = useState(0)  // 전일 종가 (상하한가 검증용)
  const [lowerPrice, setLowerPrice] = useState(0)
  const [upperPrice, setUpperPrice] = useState(0)
  const [gridCount, setGridCount] = useState(10)
  const [orderAmount, setOrderAmount] = useState(100000)
  const [balance, setBalance] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { fetchTossBalance().then(b => setBalance(b.krwBalance)).catch(() => setBalance(null)) }, [])

  const totalInvestment = orderAmount * gridCount
  const stepPrice = upperPrice > lowerPrice && gridCount > 0 ? (upperPrice - lowerPrice) / gridCount : 0
  const insufficientBalance = balance !== null && totalInvestment > balance

  const handleSubmit = async () => {
    if (!symbol) return
    setSubmitting(true); setError(null)
    try {
      await createKoreanStockBot({
        ticker: symbol.code,
        lowerPrice, upperPrice, gridCount, orderAmount,
        prevClose,
      })
      onComplete()
    } catch (e: any) {
      setError(e.message || '봇 생성 실패')
    } finally { setSubmitting(false) }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>봇 등록 — Step {step} / 4</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {step === 1 && (
          <>
            <Label>1. 종목 선택</Label>
            <SymbolSearch onSelect={(s) => { setSymbol(s); setStep(2); }} />
            {symbol && <div className="mt-2 p-3 bg-muted rounded">{symbol.name} ({symbol.code})</div>}
          </>
        )}

        {step === 2 && symbol && (
          <>
            <Label>2. 가격 범위 (현재 종목: {symbol.name})</Label>
            <div className="space-y-2">
              <div>
                <Label className="text-sm">전일 종가 (상하한가 계산용)</Label>
                <Input type="number" value={prevClose || ''} onChange={(e) => setPrevClose(Number(e.target.value))} placeholder="예: 75000" />
              </div>
              <div>
                <Label className="text-sm">하한가 (lowerPrice)</Label>
                <Input type="number" value={lowerPrice || ''} onChange={(e) => setLowerPrice(Number(e.target.value))} />
              </div>
              <div>
                <Label className="text-sm">상한가 (upperPrice)</Label>
                <Input type="number" value={upperPrice || ''} onChange={(e) => setUpperPrice(Number(e.target.value))} />
              </div>
              {prevClose > 0 && (
                <div className="text-sm text-muted-foreground">
                  상하한가: {Math.ceil(prevClose * 0.7).toLocaleString()} ~ {Math.floor(prevClose * 1.3).toLocaleString()} (±30%)
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep(1)}>이전</Button>
              <Button onClick={() => setStep(3)} disabled={!prevClose || !lowerPrice || !upperPrice || lowerPrice >= upperPrice}>다음</Button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <Label>3. 그리드 + 주문 금액</Label>
            <div className="space-y-2">
              <div>
                <Label className="text-sm">그리드 수 (2~50)</Label>
                <Input type="number" min={2} max={50} value={gridCount} onChange={(e) => setGridCount(Number(e.target.value))} />
                <div className="text-sm text-muted-foreground mt-1">그리드 간격: {stepPrice.toLocaleString()}원</div>
              </div>
              <div>
                <Label className="text-sm">1회 주문 금액 (KRW)</Label>
                <Input type="number" value={orderAmount} onChange={(e) => setOrderAmount(Number(e.target.value))} />
                <div className="text-sm mt-1">총 투자 금액: {totalInvestment.toLocaleString()}원 {balance !== null && `(잔액: ${balance.toLocaleString()}원)`}</div>
                {insufficientBalance && <div className="text-sm text-red-600">⚠️ 잔액 부족</div>}
              </div>
            </div>

            {lowerPrice && upperPrice && (
              <FeeSimulator buyPrice={lowerPrice} sellPrice={lowerPrice + stepPrice} orderAmount={orderAmount} />
            )}

            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep(2)}>이전</Button>
              <Button onClick={() => setStep(4)} disabled={insufficientBalance}>다음</Button>
            </div>
          </>
        )}

        {step === 4 && symbol && (
          <>
            <Label>4. 최종 확인</Label>
            <div className="space-y-1 text-sm bg-muted p-4 rounded">
              <div>종목: <strong>{symbol.name} ({symbol.code})</strong></div>
              <div>가격 범위: {lowerPrice.toLocaleString()} ~ {upperPrice.toLocaleString()}원</div>
              <div>그리드 수: {gridCount} (간격 {stepPrice.toLocaleString()}원)</div>
              <div>1회 주문 금액: {orderAmount.toLocaleString()}원</div>
              <div>총 투자: {totalInvestment.toLocaleString()}원</div>
            </div>
            {error && <div className="text-red-600 text-sm">{error}</div>}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep(3)}>이전</Button>
              <Button variant="outline" onClick={onCancel}>취소</Button>
              <Button onClick={handleSubmit} disabled={submitting}>{submitting ? '등록 중...' : '봇 등록'}</Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 2: 빌드 확인 + 커밋**

```bash
npm run build
git add app/korean-stocks/_components/BotWizard.tsx
git commit -m "feat: 한국주식 봇 등록 4 step 마법사"
```

---

## Task 18: 페이지 (목록 + 마법사 진입 + Settings 페이지)

**Files:**
- Create: `app/korean-stocks/page.tsx`
- Create: `app/korean-stocks/settings/page.tsx`
- Modify: `app/admin/page.tsx` (관리자 메뉴 또는 일반 사용자 메뉴에 링크 추가 — 확인 후 위치 결정)

- [ ] **Step 1: 봇 목록 페이지**

```tsx
// app/korean-stocks/page.tsx
"use client"
import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { listKoreanStockBots, updateKoreanStockBotStatus, deleteKoreanStockBot, getTossCredentialStatus, type KoreanStockBot } from "@/lib/api"
import { BotWizard } from "./_components/BotWizard"
import { MarketStatusCard } from "./_components/MarketStatusCard"

export default function KoreanStocksPage() {
  const router = useRouter()
  const [bots, setBots] = useState<KoreanStockBot[]>([])
  const [loading, setLoading] = useState(true)
  const [showWizard, setShowWizard] = useState(false)
  const [credRegistered, setCredRegistered] = useState<boolean | null>(null)

  const reload = async () => {
    setLoading(true)
    try {
      const data = await listKoreanStockBots()
      setBots(data)
    } catch (e) { console.error(e) }
    finally { setLoading(false) }
  }

  useEffect(() => {
    getTossCredentialStatus().then(s => setCredRegistered(s.registered)).catch(() => setCredRegistered(false))
    reload()
  }, [])

  const toggleStatus = async (bot: KoreanStockBot) => {
    const next = bot.status === 'running' ? 'stopped' : 'running'
    try {
      await updateKoreanStockBotStatus(bot.id, next)
      reload()
    } catch (e: any) { alert(e.message) }
  }

  const handleDelete = async (id: number) => {
    if (!confirm('정말 삭제하시겠습니까?')) return
    try {
      await deleteKoreanStockBot(id)
      reload()
    } catch (e: any) { alert(e.message) }
  }

  if (credRegistered === false) {
    return (
      <div className="p-4 max-w-2xl mx-auto space-y-4">
        <Card>
          <CardHeader><CardTitle>토스 API 키 등록 필요</CardTitle></CardHeader>
          <CardContent>
            <p>한국주식 그리드 매매를 사용하려면 먼저 토스증권 API 키를 등록해주세요.</p>
            <Link href="/korean-stocks/settings"><Button className="mt-4">API 키 등록하기</Button></Link>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">한국주식 그리드 매매</h1>
        <Link href="/korean-stocks/settings"><Button variant="outline" size="sm">설정</Button></Link>
      </div>

      <MarketStatusCard />

      {showWizard ? (
        <BotWizard onComplete={() => { setShowWizard(false); reload(); }} onCancel={() => setShowWizard(false)} />
      ) : (
        <Button onClick={() => setShowWizard(true)}>+ 새 봇 등록</Button>
      )}

      {loading ? <p>로딩 중...</p> : bots.length === 0 ? (
        <Card><CardContent className="p-8 text-center text-muted-foreground">등록된 봇이 없습니다</CardContent></Card>
      ) : (
        <div className="grid gap-4">
          {bots.map(bot => (
            <Card key={bot.id}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  <span>{bot.ticker}</span>
                  <Badge variant="outline" className={bot.status === 'running' ? 'text-green-600 border-green-500' : 'text-gray-500'}>
                    {bot.status === 'running' ? '🟢 운영중' : bot.status === 'error' ? '🔴 오류' : '⚪ 정지'}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="text-sm space-y-1">
                  <div>가격 범위: {bot.lowerPrice.toLocaleString()} ~ {bot.upperPrice.toLocaleString()}원</div>
                  <div>그리드: {bot.gridCount}개 × {bot.orderAmount.toLocaleString()}원</div>
                  <div>총 거래: {bot.totalTrades}건 / 누적 손익: {bot.currentProfit.toLocaleString()}원</div>
                  {bot.errorMessage && <div className="text-red-600 text-xs">{bot.errorMessage}</div>}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant={bot.status === 'running' ? 'outline' : 'default'} onClick={() => toggleStatus(bot)}>
                    {bot.status === 'running' ? '정지' : '시작'}
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => handleDelete(bot.id)}>삭제</Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Settings 페이지**

```tsx
// app/korean-stocks/settings/page.tsx
"use client"
import { useState, useEffect } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { saveTossCredential, getTossCredentialStatus, deleteTossCredential } from "@/lib/api"

export default function TossSettingsPage() {
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [accountSeq, setAccountSeq] = useState("")
  const [status, setStatus] = useState<{ registered: boolean; accountSeq?: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = () => getTossCredentialStatus().then(setStatus).catch(() => setStatus({ registered: false }))
  useEffect(() => { reload() }, [])

  const handleSave = async () => {
    setSaving(true); setError(null)
    try {
      await saveTossCredential({ clientId, clientSecret, accountSeq })
      setClientId(""); setClientSecret(""); setAccountSeq("")
      reload()
    } catch (e: any) {
      setError(e.message || '저장 실패')
    } finally { setSaving(false) }
  }

  const handleDelete = async () => {
    if (!confirm('토스 API 키를 삭제하시겠습니까?')) return
    await deleteTossCredential()
    reload()
  }

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">토스 API 키 설정</h1>
        <Link href="/korean-stocks"><Button variant="outline" size="sm">목록으로</Button></Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>현재 상태</CardTitle>
        </CardHeader>
        <CardContent>
          {status === null ? <p>로딩 중...</p>
            : status.registered ? (
              <div className="space-y-2">
                <p>✅ 등록됨 (계좌: {status.accountSeq})</p>
                <Button variant="destructive" size="sm" onClick={handleDelete}>삭제</Button>
              </div>
            ) : <p>아직 등록되지 않음</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{status?.registered ? '키 교체' : '새 키 등록'}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-sm text-muted-foreground">
            토스증권 WTS → 설정 → Open API 메뉴에서 client_id와 client_secret을 발급받아 입력하세요.
          </div>
          <div>
            <Label>client_id</Label>
            <Input value={clientId} onChange={(e) => setClientId(e.target.value)} />
          </div>
          <div>
            <Label>client_secret</Label>
            <Input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
          </div>
          <div>
            <Label>accountSeq (계좌 시퀀스)</Label>
            <Input value={accountSeq} onChange={(e) => setAccountSeq(e.target.value)} />
          </div>
          {error && <div className="text-red-600 text-sm">{error}</div>}
          <Button onClick={handleSave} disabled={saving || !clientId || !clientSecret || !accountSeq}>
            {saving ? '저장 중...' : '저장'}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
```

- [ ] **Step 3: 메뉴 링크 추가**

기존 일반 사용자 메뉴 (사이드바 또는 헤더)에 "한국주식 그리드" 링크 추가. 정확한 위치는 `components/layout/app-header.tsx` 또는 `app/layout.tsx` grep으로 확인 후 추가. 코인 그리드 `/grid` 메뉴 옆에 배치 권장.

- [ ] **Step 4: 빌드 + 커밋**

```bash
npm run build
git add app/korean-stocks/ components/ app/layout.tsx
git commit -m "feat: /korean-stocks 페이지 + /korean-stocks/settings + 메뉴 링크"
```

---

## Task 19: 출시 전 manual test (체크리스트)

**Files:** 변경 없음 (검증만)

- [ ] dev 서버 시작: `cd <backend> && npm run dev`
- [ ] tsc 통과: `npx tsc --noEmit` 0 errors
- [ ] 전체 jest 통과 (한국주식 신규 + 기존 빗썸/listing/etc 회귀 0건)
- [ ] DB에 KoreanStockSymbol 시드 (`npx ts-node scripts/seed-symbols.ts` 또는 sync 에이전트 1회 수동 트리거)
- [ ] DB에 KoreanMarketCalendar 시드 (`npx ts-node scripts/seed-korean-market-calendar.ts`)
- [ ] 종목 검색 동작: `curl http://localhost:4000/api/korean-stocks/symbols/search?q=삼성 -H "Authorization: Bearer <jwt>"` → 결과 다수 반환
- [ ] 토스 credential 등록: settings 페이지에서 client_id/secret/accountSeq 입력 → 검증 통과
- [ ] 잔액 조회: `curl /api/korean-stocks/balance` → 200 + krwBalance
- [ ] 시뮬레이션 API: `curl /api/korean-stocks/simulate -d '{"buyPrice":70000,"sellPrice":71000,"orderAmount":100000}'` → netProfit 양수
- [ ] 봇 등록 마법사 4 step 정상 진행 (브라우저)
- [ ] 상하한가 벗어난 가격 → 등록 거부
- [ ] 호가 단위 자동 보정 (예: 75123 → 75100)
- [ ] 장 시간 외 (16:00) 봇 cycle skip 확인 (로그)
- [ ] 장 시간 (테스트용으로 isMarketOpen 강제 true) 봇 cycle 정상 (시세 조회 + grid level 평가)
- [ ] 미체결 주문 일괄 취소 시뮬레이션 (shouldCancelPendingOrders 강제 true)

---

## Task 20: Production 배포 + Canary

**Files:** 변경 없음 (운영)

### Step 1: 사전 RDS 스냅샷
```bash
NEW_SNAP="pre-korean-stock-grid-$(date -u +%Y%m%d-%H%M%S)"
aws lightsail create-relational-database-snapshot \
  --relational-database-name Grid-bot-DB-v2 \
  --relational-database-snapshot-name "$NEW_SNAP" \
  --region ap-northeast-2 --profile route53
```
available 확인 후 진행 (Grid_project 자동 머지 정책 — `feedback_grid_project_auto_merge_policy.md`).

### Step 2: 백엔드 + 프론트 PR 생성 + 머지
- 백엔드 `feat/korean-stock-grid` 브랜치 → PR
- 프론트 `feat/korean-stock-grid-ui` 브랜치 → PR
- 백엔드 먼저 머지 → GitHub Actions watch → 헬스체크 (`http://54.180.188.8:3010/api/health`)
- 마이그레이션 자동 적용 확인 (production 로그에서 `add_korean_stock_grid` 메시지)
- KoreanStockGridAgent + SymbolSyncAgent 시작 로그 확인
- 프론트 머지 → Vercel 배포 (60-90s 대기) → `/korean-stocks` 200 확인

### Step 3: 휴장일 시드 (production)
```bash
ssh -i <key> ubuntu@54.180.188.8 'docker exec grid-bot npx ts-node scripts/seed-korean-market-calendar.ts'
```

### Step 4: 종목 마스터 sync 수동 트리거 (첫 1회)
- 관리자 토스 키가 환경변수에 등록되어 있는지 확인
- admin endpoint 또는 SymbolSyncAgent의 다음 cycle (KST 16:00) 대기

### Step 5: Canary (1주일 베타 사용자 1명)
- 베타 사용자 1명에게 토스 API 키 등록 + 봇 1개 (10만원 이하) 운영 요청
- 매일 손익 + 오류 모니터링
- 1주일 후:
  - 정상 → 일반 사용자 전체 오픈 (메뉴 노출)
  - 문제 → spec § 14 위험 항목 참조 + fix 후 재배포

---

## Self-Review 결과

### Spec coverage
- [x] §3 데이터 흐름 → Task 8~10 (엔진 + 에이전트)
- [x] §4 토스 API 사양 → Task 2~4 (TossService)
- [x] §5 데이터 모델 → Task 1 (마이그레이션)
- [x] §6 데이터 흐름 → Task 9 (봇 엔진 cycle)
- [x] §7 시장 시간 → Task 5 (market-hours.service)
- [x] §8 거래세 → Task 7 (fee-calculator)
- [x] §9 호가단위 → Task 6 (tick-size util)
- [x] §10 종목 검색 → Task 11 (sync) + Task 13 (search API) + Task 16 (SymbolSearch)
- [x] §11 마법사 → Task 17 (BotWizard)
- [x] §12 그리드 알고리즘 → Task 8 (grid.service) + Task 9 (엔진)
- [x] §13 미체결 처리 → Task 9 (cancelAllPendingOrders)
- [x] §14 에러 처리 → Task 9 (try/catch), Task 14 (검증)
- [x] §15 안전장치 → Task 13 (validateGridRange), Task 17 (마법사 검증)
- [x] §16 관측성 → 기존 BaseAgent.getExtraInfo 패턴
- [x] §17 테스트 → Task 2,5,6,7,8,9 (unit + 통합)
- [x] §18 출시 체크리스트 → Task 19
- [x] §19 신규 파일 → Task 1~18에 모두 매핑

### Placeholder scan
- "TBD"/"TODO" 없음
- "Add appropriate error handling" 류 없음
- 모든 step에 코드 또는 명령어 포함
- Task 4의 endpoint path는 "토스 공식 문서로 확인" 명시적 caveat — implementation 시 보정 필요한 부분이라 의도적

### Type consistency
- `Market` enum (CRYPTO/KOREAN_STOCK): Task 1, 13, 9 일관
- `Exchange.toss`: Task 1, 9, 14 일관
- `KoreanStockSymbol` shape: Task 1, 11, 13, 15 동일
- `simulateGridProfit` 시그니처: Task 7, 13, 15 동일
- `calculateGridPrices` 시그니처: Task 8, 13 동일
- `tossService.placeOrder` 시그니처: Task 4, 9 동일

---

## 실행 옵션 안내

Plan 완료 + self-review 통과.

**실행 방식 선택**:

1. **Subagent-Driven (권장)** — 각 task마다 fresh subagent dispatch + spec/code reviewer 2단계 review. 빗썸 작업에서 검증된 패턴.
2. **Inline Execution** — 현재 세션에서 executing-plans로 batch 실행, checkpoint마다 review

어느 방식으로 진행할까요?
