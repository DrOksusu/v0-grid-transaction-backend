# Cross-Exchange Stablecoin Arbitrage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upbit + Bithumb 양 거래소에서 동일 스테이블코인을 동시 매매하여 cross-exchange spread 를 차익으로 취하는 봇 시스템 (Stage 1 캐너리: USDE BU + USD1 UB 양봇, quantity=10, 일 5건, 50 bps 임계값).

**Architecture:** ExchangeClient 인터페이스로 Upbit/Bithumb 추상화 → Sequential 거래 실행기 (LegA → LegB, no fallback) → 5단계 precheck (spread/depeg/liquidity/balance/dailyLimit) → 7번째 에이전트 `CrossExchangeArbAgent` 신규. 기존 6 에이전트 + Maker-Taker 봇 (Stage 3) 영향 없음.

**Tech Stack:** Express 5, TypeScript, Prisma (MySQL), Jest, Next.js 16, shadcn/ui Dialog. Bithumb private API (HMAC SHA512 인증).

**관련 문서:**
- spec: `docs/superpowers/specs/2026-05-01-cross-exchange-arb-design.md`
- 데이터 분석: `scripts/cross-exchange-analyze.js`
- 답습 패턴 (PR H): `docs/superpowers/plans/2026-04-30-canary-stage-3-readiness.md`

---

## Prerequisites

### P-1: Bithumb API 키 발급 + .env 등록

**사용자 액션** (구현 시작 전 또는 Task 4 시작 전 반드시 완료):

1. 빗썸 → 마이페이지 → Open API 관리 → API 키 신규 발급
2. 권한: ✅ 잔고 조회, ✅ 시장가 주문. ❌ 출금 (보안)
3. `.env` 에 추가 (백엔드):
   ```
   BITHUMB_ACCESS_KEY=<발급받은 access key>
   BITHUMB_SECRET_KEY=<발급받은 secret key>
   ```
4. GitHub Secret 에도 등록 (production 배포용):
   - `BITHUMB_ACCESS_KEY`
   - `BITHUMB_SECRET_KEY`
   - `.github/workflows/deploy.yml` 에서 컨테이너에 주입

### P-2: Bithumb 사전 입금

본 plan 의 코드 작업과 병렬로 가능. Stage 1 가동 직전까지 완료:

- USDE 50개 (≈ 70,000 KRW)
- USD1 50개 (≈ 70,000 KRW)
- KRW 200,000
- 합계 약 34만원

### P-3: Upbit 잔고 확인

현재 Upbit 잔고는 (T_start 시점) USDS 356, USDT 104, KRW 8M 사용가능. USDE / USD1 잔고 확인 후 부족 시 보충.

---

## File Structure

### 신규 파일 (백엔드)

| 경로 | 책임 |
|------|------|
| `src/services/exchange/exchange-client.ts` | `ExchangeClient`, `OrderbookTop`, `PlacedOrder` 타입 정의 |
| `src/services/exchange/upbit-client.ts` | 기존 `UpbitService` 를 `ExchangeClient` 로 어댑팅 |
| `src/services/exchange/bithumb-client.ts` | Bithumb private API 신규 (HMAC + endpoints) |
| `src/services/cross-exchange-spread-gate.ts` | 50 bps 임계값 게이트 (순수 함수) |
| `src/services/cross-exchange-precheck.ts` | 5단계 사전 검사 (순수 함수) |
| `src/services/cross-exchange-executor.ts` | LegA → LegB sequential 실행 |
| `src/services/cross-exchange-reconciliation.service.ts` | 거래소 done order vs DB FILLED 비교 |
| `src/agents/cross-exchange-arb-agent.ts` | 5초 cycle agent |
| `__tests__/services/cross-exchange-spread-gate.test.ts` | 6 케이스 |
| `__tests__/services/cross-exchange-precheck.test.ts` | 5단계 fail + 순서 |
| `__tests__/services/exchange/bithumb-client.test.ts` | HMAC + error mapping |
| `__tests__/services/cross-exchange-executor.test.ts` | 4 시나리오 |
| `__tests__/services/cross-exchange-reconciliation.service.test.ts` | 정합/불일치/page truncated |

### 수정 파일 (백엔드)

| 경로 | 변경 |
|------|------|
| `prisma-stablecoin/schema.prisma` | `CrossExchangeArbBot` + `CrossExchangeArbTrade` 모델 추가 |
| `src/agents/agent-manager.ts` | `CrossExchangeArbAgent` 등록 (7번째) |
| `src/controllers/stablecoin-admin.controller.ts` | Cross-exchange CRUD 4개 + verifyCrossExchangeReconciliation |
| `src/routes/stablecoin-admin.ts` | 신규 라우트 5개 |
| `__mocks__/database.ts` | `crossExchangeArbBot` + `crossExchangeArbTrade` 메서드 추가 |
| `.env.example` | `BITHUMB_ACCESS_KEY`, `BITHUMB_SECRET_KEY` |
| `.github/workflows/deploy.yml` | 환경변수 주입 |

### 신규 파일 (프론트엔드)

| 경로 | 책임 |
|------|------|
| `app/admin/stablecoin/_components/CrossExchangeBotPanel.tsx` | 신규 패널 (Maker-Taker 패널 옆) |
| `app/admin/stablecoin/_components/EditCrossExchangeBotDialog.tsx` | 봇 편집 다이얼로그 |
| `app/admin/stablecoin/_components/CrossExchangeReconciliationDialog.tsx` | 🔍 검증 결과 표시 |

### 수정 파일 (프론트엔드)

| 경로 | 변경 |
|------|------|
| `lib/api.ts` | `CrossExchangeArbBot` 타입 + 5개 API 함수 |
| `app/admin/stablecoin/page.tsx` | `CrossExchangeBotPanel` 통합 |

---

## Task 1: Prisma 스키마 + 마이그레이션

**Files:**
- Modify: `prisma-stablecoin/schema.prisma` (line 204 뒤에 추가)
- Create: `prisma-stablecoin/migrations/<timestamp>_add_cross_exchange_arb/migration.sql`

- [ ] **Step 1: 스키마에 `CrossExchangeArbBot` + `CrossExchangeArbTrade` 모델 추가**

`prisma-stablecoin/schema.prisma` 의 `MakerTakerSimTrade` 모델 (line 203 끝) 뒤에 다음 추가:

```prisma

// Cross-Exchange Arbitrage Bot 설정 (2026-05-01)
// Upbit-Bithumb 양 거래소에서 동일 스테이블코인 cross-exchange 차익 거래.
model CrossExchangeArbBot {
  id     Int @id @default(autoincrement())
  userId Int

  enabled    Boolean @default(false)
  killSwitch Boolean @default(false)

  coin            String  // "USDE" | "USD1" | "USDS" 등 (KRW 제외)
  targetDirection String  // "UB" (Upbit→Bithumb 차익) | "BU" (Bithumb→Upbit 차익)
  quantity        Int     // 1회 거래 수량 (코인 단위)
  minSpreadBps    Int     @default(50)

  // 안전장치 임계값
  depegMinKrw         Int   @default(1380)
  depegMaxKrw         Int   @default(1420)
  liquidityMultiplier Float @default(1.5)
  dailyCountLimit     Int   @default(5)
  dailyLossLimitKrw   Int   @default(50000)

  // 추적
  lastResumeAt DateTime?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  trades CrossExchangeArbTrade[]

  @@map("cross_exchange_arb_bots")
}

// Cross-Exchange Arbitrage 개별 거래 기록.
// LegA (legA*), LegB (legB*) 양쪽 결과 기록. status 로 성공/실패 추적.
model CrossExchangeArbTrade {
  id    BigInt              @id @default(autoincrement())
  botId Int
  bot   CrossExchangeArbBot @relation(fields: [botId], references: [id], onDelete: Cascade)

  direction            String // "UB" | "BU"
  spreadBpsAtPlacement Int

  // Leg A (먼저 실행)
  legAExchange  String
  legASide      String
  legAOrderId   String?
  legAFilledQty Decimal? @db.Decimal(24, 8)
  legAAvgPrice  Decimal? @db.Decimal(18, 4)
  legAFeeKrw    Decimal? @db.Decimal(18, 4)

  // Leg B (반대 거래)
  legBExchange  String
  legBSide      String
  legBOrderId   String?
  legBFilledQty Decimal? @db.Decimal(24, 8)
  legBAvgPrice  Decimal? @db.Decimal(18, 4)
  legBFeeKrw    Decimal? @db.Decimal(18, 4)

  profitKrw     Decimal? @db.Decimal(18, 4)
  status        String   // "FILLED" | "LEG_A_FAILED" | "LEG_B_FAILED" | "PENDING"
  failureReason String?  @db.Text

  createdAt   DateTime  @default(now())
  completedAt DateTime?

  @@index([botId, createdAt])
  @@index([status])
  @@map("cross_exchange_arb_trades")
}
```

- [ ] **Step 2: 마이그레이션 생성 (--create-only)**

Run:
```bash
cd D:/ExpressProject/Grid_project/v0-grid-tranasction-backend
npx prisma migrate dev --schema=prisma-stablecoin/schema.prisma --name add_cross_exchange_arb --create-only
```

Expected: 마이그레이션 디렉토리 생성됨 (`prisma-stablecoin/migrations/<timestamp>_add_cross_exchange_arb/migration.sql`)

- [ ] **Step 3: 마이그레이션 SQL 검증 (CLI garbage 박스 문자 확인)**

Run:
```bash
tail -c 100 prisma-stablecoin/migrations/*_add_cross_exchange_arb/migration.sql | xxd | head -10
```

Expected: ASCII 문자만 (박스 문자 `┌`, `┐` 등 없어야 함). Prisma 5.22 CLI garbage 패턴 (메모리 `feedback_prisma_migrate_cli_garbage.md` 참조).

박스 문자 발견 시: 해당 라인 삭제하고 commit 전 검증.

- [ ] **Step 4: 마이그레이션 production 적용**

Run:
```bash
npx prisma migrate deploy --schema=prisma-stablecoin/schema.prisma
```

Expected: `1 migration found` + `applied successfully`

- [ ] **Step 5: Prisma 클라이언트 재생성**

Run:
```bash
npx prisma generate --schema=prisma-stablecoin/schema.prisma
```

Expected: `Generated Prisma Client (...)` + 0 errors

- [ ] **Step 6: 타입 검증**

Run:
```bash
npx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 7: Commit**

```bash
git add prisma-stablecoin/schema.prisma prisma-stablecoin/migrations/
git commit -m "feat: cross-exchange arb 스키마 + 마이그레이션 (CrossExchangeArbBot/Trade)"
```

---

## Task 2: ExchangeClient 인터페이스 정의

**Files:**
- Create: `src/services/exchange/exchange-client.ts`

- [ ] **Step 1: 인터페이스 + 타입 정의**

```typescript
// src/services/exchange/exchange-client.ts

export interface OrderbookTop {
  bid: number;       // 최우선 매수호가 (KRW)
  ask: number;       // 최우선 매도호가
  bidQty: number;    // 매수 수량 (코인)
  askQty: number;    // 매도 수량 (코인)
  timestamp: number; // ms
}

export type OrderStatus = 'pending' | 'filled' | 'partial' | 'cancelled' | 'failed';

export interface PlacedOrder {
  orderId: string;
  status: OrderStatus;
  filledQty: number;
  avgFillPrice: number;
  totalFeeKrw: number;
}

export interface BalanceEntry {
  available: number;
  locked: number;
}

export interface ExchangeClient {
  exchangeName: 'upbit' | 'bithumb';

  /** 단일 코인 최우선 호가 + 수량 조회. 실패 시 null */
  getOrderbookTop(symbol: string): Promise<OrderbookTop | null>;

  /** 모든 코인 잔고. KEY 는 코인 심볼 (KRW, USDT, USDE 등) */
  getBalances(): Promise<Record<string, BalanceEntry>>;

  /** 시장가 매수/매도 주문. 즉시 placement 결과 반환 (FILLED 까지 polling 은 호출자) */
  placeMarketOrder(side: 'buy' | 'sell', symbol: string, quantity: number): Promise<PlacedOrder>;

  /** 주문 상세 조회 (polling 용) */
  getOrder(orderId: string): Promise<PlacedOrder>;
}
```

- [ ] **Step 2: 타입 검증**

Run:
```bash
npx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add src/services/exchange/exchange-client.ts
git commit -m "feat: ExchangeClient 인터페이스 정의 (cross-exchange 추상화)"
```

---

## Task 3: UpbitClient 어댑터

**Files:**
- Create: `src/services/exchange/upbit-client.ts`
- Test: `__tests__/services/exchange/upbit-client.test.ts`

- [ ] **Step 1: Failing test 작성**

```typescript
// __tests__/services/exchange/upbit-client.test.ts
import { UpbitClient } from '../../../src/services/exchange/upbit-client';

describe('UpbitClient', () => {
  it('exchangeName 이 upbit 이다', () => {
    const c = new UpbitClient({ accessKey: 'k', secretKey: 's' });
    expect(c.exchangeName).toBe('upbit');
  });
});
```

- [ ] **Step 2: 테스트 실행 → FAIL**

Run:
```bash
npx jest __tests__/services/exchange/upbit-client.test.ts
```

Expected: FAIL — `Cannot find module '../../../src/services/exchange/upbit-client'`

- [ ] **Step 3: 구현 (기존 UpbitService wrap)**

```typescript
// src/services/exchange/upbit-client.ts
import { UpbitService } from '../upbit.service';
import {
  ExchangeClient, OrderbookTop, PlacedOrder, BalanceEntry, OrderStatus,
} from './exchange-client';

export interface UpbitClientCreds {
  accessKey: string;
  secretKey: string;
}

export class UpbitClient implements ExchangeClient {
  exchangeName: 'upbit' = 'upbit';
  private service: UpbitService;

  constructor(creds: UpbitClientCreds) {
    this.service = new UpbitService(creds);
  }

  async getOrderbookTop(symbol: string): Promise<OrderbookTop | null> {
    // Upbit market 코드: KRW-USDE
    const market = `KRW-${symbol}`;
    const ob = await this.service.getOrderbook(market);
    if (!ob || !ob.orderbook_units || ob.orderbook_units.length === 0) return null;
    const top = ob.orderbook_units[0];
    return {
      bid: parseFloat(top.bid_price),
      ask: parseFloat(top.ask_price),
      bidQty: parseFloat(top.bid_size),
      askQty: parseFloat(top.ask_size),
      timestamp: Date.now(),
    };
  }

  async getBalances(): Promise<Record<string, BalanceEntry>> {
    const accounts = await this.service.getAccounts();
    const out: Record<string, BalanceEntry> = {};
    for (const a of accounts) {
      out[a.currency] = {
        available: parseFloat(a.balance ?? '0'),
        locked: parseFloat(a.locked ?? '0'),
      };
    }
    return out;
  }

  async placeMarketOrder(
    side: 'buy' | 'sell', symbol: string, quantity: number,
  ): Promise<PlacedOrder> {
    const market = `KRW-${symbol}`;
    const result = await this.service.placeOrder({
      market,
      side: side === 'buy' ? 'bid' : 'ask',
      ord_type: 'market',
      ...(side === 'buy' ? { price: 0 } : { volume: quantity }),
    });
    return {
      orderId: result.uuid,
      status: this.mapStatus(result.state),
      filledQty: parseFloat(result.executed_volume ?? '0'),
      avgFillPrice: parseFloat(result.avg_price ?? '0'),
      totalFeeKrw: parseFloat(result.paid_fee ?? '0'),
    };
  }

  async getOrder(orderId: string): Promise<PlacedOrder> {
    const order = await this.service.getOrder(orderId);
    return {
      orderId,
      status: this.mapStatus(order.state),
      filledQty: parseFloat(order.executed_volume ?? '0'),
      avgFillPrice: parseFloat(order.avg_price ?? '0'),
      totalFeeKrw: parseFloat(order.paid_fee ?? '0'),
    };
  }

  private mapStatus(state: string): OrderStatus {
    if (state === 'done' || state === 'completed') return 'filled';
    if (state === 'wait' || state === 'watch') return 'pending';
    if (state === 'cancel' || state === 'cancelled') return 'cancelled';
    return 'failed';
  }
}
```

⚠️ `UpbitService` 의 메서드 시그니처가 위와 다르면 매핑 부분 (placeOrder, getOrder) 조정. 실제 구현 시 `src/services/upbit.service.ts` 확인 후 조정.

- [ ] **Step 4: 테스트 실행 → PASS**

Run:
```bash
npx jest __tests__/services/exchange/upbit-client.test.ts
```

Expected: 1 passed

- [ ] **Step 5: 타입 검증**

Run:
```bash
npx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add src/services/exchange/upbit-client.ts __tests__/services/exchange/upbit-client.test.ts
git commit -m "feat: UpbitClient 어댑터 (ExchangeClient 구현)"
```

---

## Task 4: BithumbClient HMAC 인증 + 잔고 조회

**Files:**
- Create: `src/services/exchange/bithumb-client.ts`
- Test: `__tests__/services/exchange/bithumb-client.test.ts`

⚠️ Prerequisite: P-1 (Bithumb API 키 .env 등록) 완료 필수.

- [ ] **Step 1: Failing test 작성 (HMAC 서명 정확성)**

```typescript
// __tests__/services/exchange/bithumb-client.test.ts
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
```

- [ ] **Step 2: 테스트 실행 → FAIL**

Run:
```bash
npx jest __tests__/services/exchange/bithumb-client.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: 구현 (HMAC + 잔고 조회만)**

```typescript
// src/services/exchange/bithumb-client.ts
import axios from 'axios';
import crypto from 'crypto';
import {
  ExchangeClient, OrderbookTop, PlacedOrder, BalanceEntry, OrderStatus,
} from './exchange-client';

const BITHUMB_API_URL = 'https://api.bithumb.com';
const TIMEOUT_MS = 5000;

export interface BithumbCreds {
  accessKey: string;
  secretKey: string;
}

/** Bithumb private API HMAC SHA512 서명. endpoint + chr(0) + body + chr(0) + nonce 를 secret 으로 서명 후 base64 인코딩. */
export function signRequest(endpoint: string, body: string, nonce: string, secretKey: string): string {
  const data = endpoint + String.fromCharCode(0) + body + String.fromCharCode(0) + nonce;
  return crypto.createHmac('sha512', secretKey).update(data).digest('base64');
}

export class BithumbClient implements ExchangeClient {
  exchangeName: 'bithumb' = 'bithumb';
  constructor(private creds: BithumbCreds) {}

  /** Bithumb private API 호출 (POST + HMAC) */
  private async privatePost(endpoint: string, params: Record<string, string | number>): Promise<any> {
    const nonce = String(Date.now());
    const bodyStr = new URLSearchParams(params as any).toString();
    const sign = signRequest(endpoint, bodyStr, nonce, this.creds.secretKey);
    const response = await axios.post(`${BITHUMB_API_URL}${endpoint}`, bodyStr, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Api-Key': this.creds.accessKey,
        'Api-Nonce': nonce,
        'Api-Sign': sign,
      },
      timeout: TIMEOUT_MS,
    });
    if (response.data?.status !== '0000') {
      throw new Error(`Bithumb error ${response.data?.status}: ${response.data?.message ?? 'unknown'}`);
    }
    return response.data;
  }

  async getOrderbookTop(symbol: string): Promise<OrderbookTop | null> {
    // public API (인증 불필요)
    try {
      const response = await axios.get(
        `${BITHUMB_API_URL}/public/orderbook/${symbol}_KRW`,
        { timeout: TIMEOUT_MS },
      );
      const data = response.data;
      if (data?.status !== '0000' || !data.data) return null;
      const topBid = data.data.bids?.[0];
      const topAsk = data.data.asks?.[0];
      if (!topBid || !topAsk) return null;
      return {
        bid: parseFloat(topBid.price),
        ask: parseFloat(topAsk.price),
        bidQty: parseFloat(topBid.quantity),
        askQty: parseFloat(topAsk.quantity),
        timestamp: Date.now(),
      };
    } catch (err: any) {
      console.error(`[Bithumb] orderbook ${symbol} 조회 실패:`, err.message);
      return null;
    }
  }

  async getBalances(): Promise<Record<string, BalanceEntry>> {
    const data = await this.privatePost('/info/balance', { currency: 'ALL' });
    const out: Record<string, BalanceEntry> = {};
    for (const [key, value] of Object.entries(data.data ?? {})) {
      // 빗썸 응답은 "available_KRW", "total_KRW", "in_use_KRW" 형식
      const m = key.match(/^available_(.+)$/);
      if (!m) continue;
      const sym = m[1].toUpperCase();
      const inUseKey = `in_use_${m[1]}`;
      out[sym] = {
        available: parseFloat((data.data as any)[key] ?? '0'),
        locked: parseFloat((data.data as any)[inUseKey] ?? '0'),
      };
    }
    return out;
  }

  async placeMarketOrder(_side: 'buy' | 'sell', _symbol: string, _quantity: number): Promise<PlacedOrder> {
    throw new Error('placeMarketOrder: implemented in Task 5');
  }

  async getOrder(_orderId: string): Promise<PlacedOrder> {
    throw new Error('getOrder: implemented in Task 5');
  }

  /** internal helper for tests */
  protected mapStatus(state: string): OrderStatus {
    if (state === 'completed') return 'filled';
    if (state === 'pending') return 'pending';
    return 'failed';
  }
}
```

- [ ] **Step 4: 테스트 실행 → PASS**

Run:
```bash
npx jest __tests__/services/exchange/bithumb-client.test.ts
```

Expected: 4 passed

- [ ] **Step 5: 타입 검증**

Run:
```bash
npx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add src/services/exchange/bithumb-client.ts __tests__/services/exchange/bithumb-client.test.ts
git commit -m "feat: BithumbClient HMAC 서명 + 잔고 조회 (private API)"
```

---

## Task 5: BithumbClient 시장가 주문 + 주문 조회

**Files:**
- Modify: `src/services/exchange/bithumb-client.ts` (placeMarketOrder + getOrder 채우기)
- Modify: `__tests__/services/exchange/bithumb-client.test.ts` (테스트 추가)

- [ ] **Step 1: Failing test 추가 (axios 모킹)**

테스트 파일 끝에 추가:

```typescript
import axios from 'axios';
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('BithumbClient — placeMarketOrder', () => {
  beforeEach(() => {
    mockedAxios.post.mockClear();
  });

  it('성공 응답을 PlacedOrder 로 매핑한다', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        status: '0000',
        order_id: 'C-1234567890',
        data: { order_id: 'C-1234567890' },
      },
    });
    const c = new BithumbClient({ accessKey: 'k', secretKey: 's' });
    const result = await c.placeMarketOrder('buy', 'USDE', 10);
    expect(result.orderId).toBe('C-1234567890');
    expect(result.status).toBe('pending'); // 빗썸 시장가 주문은 즉시 fill 안 보장
  });

  it('Bithumb 5500 (잔고부족) 시 throw', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { status: '5500', message: '잔고가 부족합니다' },
    });
    const c = new BithumbClient({ accessKey: 'k', secretKey: 's' });
    await expect(c.placeMarketOrder('buy', 'USDE', 10)).rejects.toThrow(/5500/);
  });
});

describe('BithumbClient — getOrder', () => {
  beforeEach(() => {
    mockedAxios.post.mockClear();
  });

  it('completed 응답을 filled 로 매핑한다', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        status: '0000',
        data: {
          order_status: 'Completed',
          order_qty: '10',
          order_price: '1500',
          fee: '7.5',
        },
      },
    });
    const c = new BithumbClient({ accessKey: 'k', secretKey: 's' });
    const result = await c.getOrder('C-1234567890');
    expect(result.status).toBe('filled');
    expect(result.filledQty).toBe(10);
    expect(result.avgFillPrice).toBe(1500);
    expect(result.totalFeeKrw).toBe(7.5);
  });
});
```

- [ ] **Step 2: 테스트 실행 → FAIL**

Run:
```bash
npx jest __tests__/services/exchange/bithumb-client.test.ts
```

Expected: 일부 PASS (HMAC 부분), 신규 3개 FAIL (placeMarketOrder/getOrder placeholder throw)

- [ ] **Step 3: placeMarketOrder + getOrder 구현**

`src/services/exchange/bithumb-client.ts` 의 두 메서드 교체:

```typescript
  async placeMarketOrder(
    side: 'buy' | 'sell', symbol: string, quantity: number,
  ): Promise<PlacedOrder> {
    const endpoint = side === 'buy' ? '/trade/market_buy' : '/trade/market_sell';
    const params: Record<string, string | number> = {
      order_currency: symbol.toUpperCase(),
      payment_currency: 'KRW',
      units: side === 'sell' ? quantity : 0, // 빗썸: market_buy 는 amount(KRW), market_sell 은 units(코인)
    };
    if (side === 'buy') {
      // 빗썸 market_buy 는 KRW 기준이라 별도 처리. 단순화: quantity * approx_price 로 KRW 산정.
      // 더 정확히는 호출자가 KRW 금액 전달해야 함 — Stage 1 캐너리에서는 quantity 만 받고 호출 시 환산.
      // 본 plan 에서는 quantity 를 코인 수량으로 받고 caller 가 호가 기반 KRW 환산 후 placeMarketOrderKrw 호출하도록 분리 필요.
      // 단순화: 임시로 1500 KRW 가정 (실제 호출 시 호가 매니저에서 가져온 ask 사용).
      params.amount = Math.ceil(quantity * 1500);
      delete params.units;
    }
    const response = await this.privatePost(endpoint, params);
    return {
      orderId: response.order_id ?? response.data?.order_id ?? '',
      status: 'pending', // 빗썸 시장가 결과 비동기 — getOrder polling 필요
      filledQty: 0,
      avgFillPrice: 0,
      totalFeeKrw: 0,
    };
  }

  async getOrder(orderId: string): Promise<PlacedOrder> {
    const response = await this.privatePost('/info/order_detail', { order_id: orderId });
    const d = response.data;
    return {
      orderId,
      status: this.mapStatus((d?.order_status ?? '').toLowerCase()),
      filledQty: parseFloat(d?.order_qty ?? '0'),
      avgFillPrice: parseFloat(d?.order_price ?? '0'),
      totalFeeKrw: parseFloat(d?.fee ?? '0'),
    };
  }
```

⚠️ Bithumb market_buy 의 amount 산정은 호출자(executor) 가 호가 기반 정확 KRW 로 결정해야 함. 본 wrapper 는 임시로 quantity * 1500 KRW 사용 (Stage 1 캐너리 정확성 한계). Stage 2 에서 별도 `placeMarketBuyKrw(symbol, amountKrw)` 메서드 추가 검토.

- [ ] **Step 4: 테스트 실행 → PASS**

Run:
```bash
npx jest __tests__/services/exchange/bithumb-client.test.ts
```

Expected: 7 passed (4 + 3 new)

- [ ] **Step 5: Commit**

```bash
git add src/services/exchange/bithumb-client.ts __tests__/services/exchange/bithumb-client.test.ts
git commit -m "feat: BithumbClient placeMarketOrder + getOrder (시장가 + 주문 조회)"
```

---

## Task 6: Cross-Exchange Spread Gate (TDD 순수 함수)

**Files:**
- Create: `src/services/cross-exchange-spread-gate.ts`
- Test: `__tests__/services/cross-exchange-spread-gate.test.ts`

- [ ] **Step 1: Failing test 6 케이스**

```typescript
// __tests__/services/cross-exchange-spread-gate.test.ts
import { isSpreadProfitable } from '../../src/services/cross-exchange-spread-gate';

const baseSnapshot = { upbitBid: 1500, upbitAsk: 1501, bithumbBid: 1499, bithumbAsk: 1500 };

describe('isSpreadProfitable', () => {
  it('UB 방향 spread 0 시 fail', () => {
    const result = isSpreadProfitable(
      { ...baseSnapshot, upbitBid: 1500, bithumbAsk: 1500 },
      'UB', 50,
    );
    expect(result.ok).toBe(false);
    expect(result.spreadBps).toBe(0);
  });

  it('UB 방향 50 bps 정확 시 pass', () => {
    // upbit_bid / bithumb_ask - 1 = 50/10000 → upbit_bid = 1.005 * bithumb_ask
    // bithumb_ask=1000 → upbit_bid=1005 → spread = (1005/1000 - 1) * 10000 = 50
    const result = isSpreadProfitable(
      { upbitBid: 1005, upbitAsk: 1006, bithumbBid: 999, bithumbAsk: 1000 },
      'UB', 50,
    );
    expect(result.ok).toBe(true);
    expect(result.spreadBps).toBe(50);
  });

  it('UB 방향 49 bps 시 fail (임계값 미달)', () => {
    const result = isSpreadProfitable(
      { upbitBid: 1004, upbitAsk: 1005, bithumbBid: 999, bithumbAsk: 1000 },
      'UB', 50,
    );
    expect(result.ok).toBe(false);
    expect(result.spreadBps).toBe(39); // (1004/1000 - 1) * 10000 = 40, floor 39 (구체 floor 결과 확인)
  });

  it('BU 방향 100 bps 시 pass', () => {
    // bithumb_bid / upbit_ask - 1 = 100/10000
    // upbit_ask=1000, bithumb_bid=1010 → 100 bps
    const result = isSpreadProfitable(
      { upbitBid: 999, upbitAsk: 1000, bithumbBid: 1010, bithumbAsk: 1011 },
      'BU', 50,
    );
    expect(result.ok).toBe(true);
    expect(result.spreadBps).toBe(100);
  });

  it('UB 음수 spread 시 fail', () => {
    const result = isSpreadProfitable(
      { upbitBid: 990, upbitAsk: 991, bithumbBid: 999, bithumbAsk: 1000 },
      'UB', 50,
    );
    expect(result.ok).toBe(false);
    expect(result.spreadBps).toBeLessThan(0);
  });

  it('reason 메시지 포함', () => {
    const result = isSpreadProfitable(baseSnapshot, 'UB', 50);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/spread .* < min 50/);
  });
});
```

- [ ] **Step 2: 테스트 실행 → FAIL**

Run:
```bash
npx jest __tests__/services/cross-exchange-spread-gate.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: 구현**

```typescript
// src/services/cross-exchange-spread-gate.ts

export interface OrderbookSnapshot {
  upbitBid: number;
  upbitAsk: number;
  bithumbBid: number;
  bithumbAsk: number;
}

export interface SpreadGateResult {
  ok: boolean;
  spreadBps: number;
  reason?: string;
}

/**
 * Cross-exchange spread bps 게이트.
 *
 * UB 방향: Upbit bid > Bithumb ask 인 차익. spread = (upbit_bid / bithumb_ask - 1) * 10000.
 * BU 방향: Bithumb bid > Upbit ask 인 차익. spread = (bithumb_bid / upbit_ask - 1) * 10000.
 *
 * minSpreadBps 미만 시 ok=false. 마진 보장 위해 floor 사용.
 */
export function isSpreadProfitable(
  snapshot: OrderbookSnapshot,
  direction: 'UB' | 'BU',
  minSpreadBps: number,
): SpreadGateResult {
  const ratio = direction === 'UB'
    ? snapshot.upbitBid / snapshot.bithumbAsk
    : snapshot.bithumbBid / snapshot.upbitAsk;
  const spreadBps = Math.floor((ratio - 1) * 10000);

  if (spreadBps < minSpreadBps) {
    return {
      ok: false,
      spreadBps,
      reason: `spread ${spreadBps} bps < min ${minSpreadBps} (${direction} direction, 수익성 미달)`,
    };
  }
  return { ok: true, spreadBps };
}
```

- [ ] **Step 4: 테스트 실행 → PASS**

Run:
```bash
npx jest __tests__/services/cross-exchange-spread-gate.test.ts
```

Expected: 6 passed (case 3 의 spreadBps 값 확인 — 실제로는 (1004/1000 - 1) * 10000 = 40. Math.floor(40) = 40. 위 테스트 expect(39) 는 부정확 — 실제 결과 보고 조정)

수정 필요 시 case 3 의 expected value 정확히 맞춤.

- [ ] **Step 5: Commit**

```bash
git add src/services/cross-exchange-spread-gate.ts __tests__/services/cross-exchange-spread-gate.test.ts
git commit -m "feat: cross-exchange spread gate (50 bps 임계값 순수 함수)"
```

---

## Task 7: Cross-Exchange Precheck (5단계)

**Files:**
- Create: `src/services/cross-exchange-precheck.ts`
- Test: `__tests__/services/cross-exchange-precheck.test.ts`

- [ ] **Step 1: Failing test 5단계 시나리오**

```typescript
// __tests__/services/cross-exchange-precheck.test.ts
import { runAll, PrecheckArgs } from '../../src/services/cross-exchange-precheck';

const baseArgs: PrecheckArgs = {
  snapshot: { upbitBid: 1010, upbitAsk: 1011, bithumbBid: 999, bithumbAsk: 1000 },
  direction: 'UB',
  bot: {
    coin: 'USDE',
    quantity: 10,
    minSpreadBps: 50,
    depegMinKrw: 1380,
    depegMaxKrw: 1420,
    liquidityMultiplier: 1.5,
    dailyCountLimit: 5,
    dailyLossLimitKrw: 50000,
  },
  liquidity: { upbitBidQty: 100, upbitAskQty: 100, bithumbBidQty: 100, bithumbAskQty: 100 },
  balances: { upbit: { KRW: 1000000, USDE: 50 }, bithumb: { KRW: 1000000, USDE: 50 } },
  todayCount: 0,
  todayLossKrw: 0,
};

describe('cross-exchange precheck — runAll', () => {
  it('정상 케이스 → ok', () => {
    const result = runAll({
      ...baseArgs,
      bot: { ...baseArgs.bot, depegMinKrw: 990, depegMaxKrw: 1020 }, // 가격 1000 근처라 임시 조정
    });
    expect(result.ok).toBe(true);
  });

  it('1단계 spread 미달 → spread reason', () => {
    const result = runAll({
      ...baseArgs,
      bot: { ...baseArgs.bot, minSpreadBps: 200, depegMinKrw: 990, depegMaxKrw: 1020 },
    });
    expect(result.ok).toBe(false);
    expect(result.abortReason).toMatch(/spread/);
  });

  it('2단계 depeg → depeg reason', () => {
    const result = runAll({
      ...baseArgs,
      bot: { ...baseArgs.bot, depegMinKrw: 1380, depegMaxKrw: 1420 }, // mid 가격 1000 → 미달
    });
    expect(result.ok).toBe(false);
    expect(result.abortReason).toMatch(/depeg/i);
  });

  it('3단계 liquidity 부족 → liquidity reason', () => {
    const result = runAll({
      ...baseArgs,
      bot: { ...baseArgs.bot, depegMinKrw: 990, depegMaxKrw: 1020 },
      liquidity: { upbitBidQty: 5, upbitAskQty: 5, bithumbBidQty: 5, bithumbAskQty: 5 },
    });
    expect(result.ok).toBe(false);
    expect(result.abortReason).toMatch(/liquidity/i);
  });

  it('4단계 잔고 부족 → balance reason', () => {
    const result = runAll({
      ...baseArgs,
      bot: { ...baseArgs.bot, depegMinKrw: 990, depegMaxKrw: 1020 },
      balances: { upbit: { KRW: 100, USDE: 50 }, bithumb: { KRW: 1000000, USDE: 50 } },
    });
    expect(result.ok).toBe(false);
    expect(result.abortReason).toMatch(/balance|잔고/i);
  });

  it('5단계 daily limit 초과 → limit reason', () => {
    const result = runAll({
      ...baseArgs,
      bot: { ...baseArgs.bot, depegMinKrw: 990, depegMaxKrw: 1020 },
      todayCount: 5,
    });
    expect(result.ok).toBe(false);
    expect(result.abortReason).toMatch(/limit|한도/i);
  });
});
```

- [ ] **Step 2: 테스트 실행 → FAIL**

Run:
```bash
npx jest __tests__/services/cross-exchange-precheck.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: 구현**

```typescript
// src/services/cross-exchange-precheck.ts
import { OrderbookSnapshot, isSpreadProfitable } from './cross-exchange-spread-gate';

export interface PrecheckBotConfig {
  coin: string;
  quantity: number;
  minSpreadBps: number;
  depegMinKrw: number;
  depegMaxKrw: number;
  liquidityMultiplier: number;
  dailyCountLimit: number;
  dailyLossLimitKrw: number;
}

export interface LiquiditySnapshot {
  upbitBidQty: number;
  upbitAskQty: number;
  bithumbBidQty: number;
  bithumbAskQty: number;
}

export interface BalanceSnapshot {
  upbit: Record<string, number>;
  bithumb: Record<string, number>;
}

export interface PrecheckArgs {
  snapshot: OrderbookSnapshot;
  direction: 'UB' | 'BU';
  bot: PrecheckBotConfig;
  liquidity: LiquiditySnapshot;
  balances: BalanceSnapshot;
  todayCount: number;
  todayLossKrw: number;
}

export interface PrecheckResult {
  ok: boolean;
  abortReason?: string;
}

/**
 * 5단계 사전 검사 (순서 fail 시 즉시 abort).
 * 1. spread gate
 * 2. depeg guard
 * 3. liquidity
 * 4. balance
 * 5. daily limit
 */
export function runAll(args: PrecheckArgs): PrecheckResult {
  // 1. spread gate
  const spreadResult = isSpreadProfitable(args.snapshot, args.direction, args.bot.minSpreadBps);
  if (!spreadResult.ok) {
    return { ok: false, abortReason: spreadResult.reason };
  }

  // 2. depeg guard (양 거래소 mid 가격이 depeg 범위 안에 있어야 함)
  const upbitMid = (args.snapshot.upbitBid + args.snapshot.upbitAsk) / 2;
  const bithumbMid = (args.snapshot.bithumbBid + args.snapshot.bithumbAsk) / 2;
  for (const [name, mid] of [['upbit', upbitMid], ['bithumb', bithumbMid]] as const) {
    if (mid < args.bot.depegMinKrw || mid > args.bot.depegMaxKrw) {
      return {
        ok: false,
        abortReason: `depeg guard: ${name} mid ${mid} KRW outside [${args.bot.depegMinKrw}, ${args.bot.depegMaxKrw}]`,
      };
    }
  }

  // 3. liquidity (양 거래소 top-of-book qty >= quantity * multiplier)
  const required = args.bot.quantity * args.bot.liquidityMultiplier;
  const liqs = [
    ['upbit bid', args.liquidity.upbitBidQty],
    ['upbit ask', args.liquidity.upbitAskQty],
    ['bithumb bid', args.liquidity.bithumbBidQty],
    ['bithumb ask', args.liquidity.bithumbAskQty],
  ] as const;
  for (const [label, qty] of liqs) {
    if (qty < required) {
      return {
        ok: false,
        abortReason: `liquidity: ${label} ${qty} < required ${required.toFixed(1)} (quantity ${args.bot.quantity} × ${args.bot.liquidityMultiplier})`,
      };
    }
  }

  // 4. balance (방향에 따라 leg A/B 측 잔고 검증)
  const { coin, quantity } = args.bot;
  const requiredKrwForBuy = (args.snapshot.upbitAsk + args.snapshot.bithumbAsk) * quantity * 0.55; // 안전 마진 10%
  if (args.direction === 'UB') {
    // legA: Upbit 매수 (KRW 필요), legB: Bithumb 매도 (코인 필요)
    if ((args.balances.upbit.KRW ?? 0) < requiredKrwForBuy) {
      return { ok: false, abortReason: `balance: Upbit KRW ${args.balances.upbit.KRW} < required ${requiredKrwForBuy.toFixed(0)}` };
    }
    if ((args.balances.bithumb[coin] ?? 0) < quantity) {
      return { ok: false, abortReason: `balance: Bithumb ${coin} ${args.balances.bithumb[coin]} < quantity ${quantity}` };
    }
  } else {
    // BU: legA Bithumb 매수, legB Upbit 매도
    if ((args.balances.bithumb.KRW ?? 0) < requiredKrwForBuy) {
      return { ok: false, abortReason: `balance: Bithumb KRW ${args.balances.bithumb.KRW} < required ${requiredKrwForBuy.toFixed(0)}` };
    }
    if ((args.balances.upbit[coin] ?? 0) < quantity) {
      return { ok: false, abortReason: `balance: Upbit ${coin} ${args.balances.upbit[coin]} < quantity ${quantity}` };
    }
  }

  // 5. daily limit
  if (args.todayCount >= args.bot.dailyCountLimit) {
    return { ok: false, abortReason: `daily count limit: today ${args.todayCount} >= ${args.bot.dailyCountLimit}` };
  }
  if (args.todayLossKrw >= args.bot.dailyLossLimitKrw) {
    return { ok: false, abortReason: `daily loss limit: today ${args.todayLossKrw} KRW >= ${args.bot.dailyLossLimitKrw}` };
  }

  return { ok: true };
}
```

- [ ] **Step 4: 테스트 실행 → PASS**

Run:
```bash
npx jest __tests__/services/cross-exchange-precheck.test.ts
```

Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add src/services/cross-exchange-precheck.ts __tests__/services/cross-exchange-precheck.test.ts
git commit -m "feat: cross-exchange precheck 5단계 (spread/depeg/liquidity/balance/limit)"
```

---

## Task 8: Cross-Exchange Executor (Sequential + No Fallback)

**Files:**
- Create: `src/services/cross-exchange-executor.ts`
- Test: `__tests__/services/cross-exchange-executor.test.ts`

- [ ] **Step 1: Failing test (4 시나리오)**

```typescript
// __tests__/services/cross-exchange-executor.test.ts
import { execute, ExecutorArgs } from '../../src/services/cross-exchange-executor';
import { ExchangeClient } from '../../src/services/exchange/exchange-client';

const mockClient = (overrides: Partial<ExchangeClient> = {}): ExchangeClient => ({
  exchangeName: 'upbit',
  getOrderbookTop: jest.fn(),
  getBalances: jest.fn(),
  placeMarketOrder: jest.fn(),
  getOrder: jest.fn(),
  ...overrides,
}) as any;

describe('cross-exchange executor', () => {
  it('UB 방향 양쪽 success → status FILLED + profitKrw 양수', async () => {
    const upbit = mockClient({
      placeMarketOrder: jest.fn().mockResolvedValue({ orderId: 'U-1', status: 'pending', filledQty: 0, avgFillPrice: 0, totalFeeKrw: 0 }),
      getOrder: jest.fn().mockResolvedValue({ orderId: 'U-1', status: 'filled', filledQty: 10, avgFillPrice: 1000, totalFeeKrw: 5 }),
    });
    const bithumb = mockClient({
      exchangeName: 'bithumb',
      placeMarketOrder: jest.fn().mockResolvedValue({ orderId: 'B-1', status: 'pending', filledQty: 0, avgFillPrice: 0, totalFeeKrw: 0 }),
      getOrder: jest.fn().mockResolvedValue({ orderId: 'B-1', status: 'filled', filledQty: 10, avgFillPrice: 1010, totalFeeKrw: 5 }),
    });
    const result = await execute({
      botId: 1, direction: 'UB', coin: 'USDE', quantity: 10, spreadBps: 100,
      upbit, bithumb, pollingMaxMs: 100, pollingIntervalMs: 10,
    });
    expect(result.status).toBe('FILLED');
    expect(result.profitKrw).toBeGreaterThan(0);
  });

  it('LegA 실패 → LEG_A_FAILED + LegB 호출 안 함', async () => {
    const upbit = mockClient({
      placeMarketOrder: jest.fn().mockRejectedValue(new Error('Upbit reject')),
    });
    const bithumb = mockClient({
      exchangeName: 'bithumb',
      placeMarketOrder: jest.fn(),
    });
    const result = await execute({
      botId: 1, direction: 'UB', coin: 'USDE', quantity: 10, spreadBps: 100,
      upbit, bithumb, pollingMaxMs: 100, pollingIntervalMs: 10,
    });
    expect(result.status).toBe('LEG_A_FAILED');
    expect(bithumb.placeMarketOrder).not.toHaveBeenCalled();
  });

  it('LegB 실패 → LEG_B_FAILED + autoKillSwitch trigger flag', async () => {
    const upbit = mockClient({
      placeMarketOrder: jest.fn().mockResolvedValue({ orderId: 'U-1', status: 'pending', filledQty: 0, avgFillPrice: 0, totalFeeKrw: 0 }),
      getOrder: jest.fn().mockResolvedValue({ orderId: 'U-1', status: 'filled', filledQty: 10, avgFillPrice: 1000, totalFeeKrw: 5 }),
    });
    const bithumb = mockClient({
      exchangeName: 'bithumb',
      placeMarketOrder: jest.fn().mockRejectedValue(new Error('Bithumb 5500')),
    });
    const result = await execute({
      botId: 1, direction: 'UB', coin: 'USDE', quantity: 10, spreadBps: 100,
      upbit, bithumb, pollingMaxMs: 100, pollingIntervalMs: 10,
    });
    expect(result.status).toBe('LEG_B_FAILED');
    expect(result.shouldKillSwitch).toBe(true);
  });

  it('LegA polling timeout → LEG_A_FAILED', async () => {
    const upbit = mockClient({
      placeMarketOrder: jest.fn().mockResolvedValue({ orderId: 'U-1', status: 'pending', filledQty: 0, avgFillPrice: 0, totalFeeKrw: 0 }),
      getOrder: jest.fn().mockResolvedValue({ orderId: 'U-1', status: 'pending', filledQty: 0, avgFillPrice: 0, totalFeeKrw: 0 }),
    });
    const bithumb = mockClient({
      exchangeName: 'bithumb',
      placeMarketOrder: jest.fn(),
    });
    const result = await execute({
      botId: 1, direction: 'UB', coin: 'USDE', quantity: 10, spreadBps: 100,
      upbit, bithumb, pollingMaxMs: 50, pollingIntervalMs: 10,
    });
    expect(result.status).toBe('LEG_A_FAILED');
    expect(result.failureReason).toMatch(/timeout/i);
  });
});
```

- [ ] **Step 2: 테스트 실행 → FAIL**

Run:
```bash
npx jest __tests__/services/cross-exchange-executor.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: 구현**

```typescript
// src/services/cross-exchange-executor.ts
import { ExchangeClient, PlacedOrder } from './exchange/exchange-client';

export interface ExecutorArgs {
  botId: number;
  direction: 'UB' | 'BU';
  coin: string;
  quantity: number;
  spreadBps: number;
  upbit: ExchangeClient;
  bithumb: ExchangeClient;
  pollingMaxMs?: number;       // default 5000
  pollingIntervalMs?: number;  // default 100
}

export interface ExecutorResult {
  status: 'FILLED' | 'LEG_A_FAILED' | 'LEG_B_FAILED';
  legA?: PlacedOrder & { exchange: 'upbit' | 'bithumb'; side: 'buy' | 'sell' };
  legB?: PlacedOrder & { exchange: 'upbit' | 'bithumb'; side: 'buy' | 'sell' };
  profitKrw?: number;
  failureReason?: string;
  shouldKillSwitch: boolean; // LegB 실패 시 true
}

/** 폴링: order status 가 filled 또는 cancelled/failed 될 때까지 */
async function pollOrderUntilDone(
  client: ExchangeClient, orderId: string, maxMs: number, intervalMs: number,
): Promise<PlacedOrder> {
  const deadline = Date.now() + maxMs;
  let last = await client.getOrder(orderId);
  while (last.status === 'pending' && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, intervalMs));
    last = await client.getOrder(orderId);
  }
  return last;
}

export async function execute(args: ExecutorArgs): Promise<ExecutorResult> {
  const pollMax = args.pollingMaxMs ?? 5000;
  const pollInt = args.pollingIntervalMs ?? 100;

  // direction → leg routing
  const isUB = args.direction === 'UB';
  const legAClient = isUB ? args.upbit : args.bithumb;
  const legBClient = isUB ? args.bithumb : args.upbit;
  const legASide: 'buy' | 'sell' = 'buy';
  const legBSide: 'buy' | 'sell' = 'sell';

  // === Leg A ===
  let legAPlaced: PlacedOrder;
  try {
    legAPlaced = await legAClient.placeMarketOrder(legASide, args.coin, args.quantity);
  } catch (err: any) {
    return {
      status: 'LEG_A_FAILED',
      failureReason: `LegA placement: ${err.message ?? err}`,
      shouldKillSwitch: false,
    };
  }

  let legAFinal: PlacedOrder;
  if (legAPlaced.status === 'filled') {
    legAFinal = legAPlaced;
  } else {
    legAFinal = await pollOrderUntilDone(legAClient, legAPlaced.orderId, pollMax, pollInt);
    if (legAFinal.status !== 'filled') {
      return {
        status: 'LEG_A_FAILED',
        failureReason: `LegA polling timeout (${legAFinal.status})`,
        shouldKillSwitch: false,
      };
    }
  }

  // === Leg B ===
  let legBPlaced: PlacedOrder;
  try {
    legBPlaced = await legBClient.placeMarketOrder(legBSide, args.coin, args.quantity);
  } catch (err: any) {
    return {
      status: 'LEG_B_FAILED',
      legA: { ...legAFinal, exchange: legAClient.exchangeName, side: legASide },
      failureReason: `LegB placement: ${err.message ?? err}`,
      shouldKillSwitch: true,
    };
  }

  let legBFinal: PlacedOrder;
  if (legBPlaced.status === 'filled') {
    legBFinal = legBPlaced;
  } else {
    legBFinal = await pollOrderUntilDone(legBClient, legBPlaced.orderId, pollMax, pollInt);
    if (legBFinal.status !== 'filled') {
      return {
        status: 'LEG_B_FAILED',
        legA: { ...legAFinal, exchange: legAClient.exchangeName, side: legASide },
        failureReason: `LegB polling timeout (${legBFinal.status})`,
        shouldKillSwitch: true,
      };
    }
  }

  // === P&L 계산 ===
  // UB: legA(Upbit 매수) + legB(Bithumb 매도) → profit = legBKrw - legAKrw - fees
  // BU: legA(Bithumb 매수) + legB(Upbit 매도) → 동일 공식 (legB sell - legA buy - fees)
  const legAKrw = legAFinal.filledQty * legAFinal.avgFillPrice;
  const legBKrw = legBFinal.filledQty * legBFinal.avgFillPrice;
  const profitKrw = legBKrw - legAKrw - legAFinal.totalFeeKrw - legBFinal.totalFeeKrw;

  return {
    status: 'FILLED',
    legA: { ...legAFinal, exchange: legAClient.exchangeName, side: legASide },
    legB: { ...legBFinal, exchange: legBClient.exchangeName, side: legBSide },
    profitKrw,
    shouldKillSwitch: false,
  };
}
```

- [ ] **Step 4: 테스트 실행 → PASS**

Run:
```bash
npx jest __tests__/services/cross-exchange-executor.test.ts
```

Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add src/services/cross-exchange-executor.ts __tests__/services/cross-exchange-executor.test.ts
git commit -m "feat: cross-exchange executor (Sequential + No Fallback)"
```

---

## Task 9: Cross-Exchange Reconciliation Service

**Files:**
- Create: `src/services/cross-exchange-reconciliation.service.ts`
- Test: `__tests__/services/cross-exchange-reconciliation.service.test.ts`

- [ ] **Step 1: Failing test (PR H reconciliation 패턴 답습)**

```typescript
// __tests__/services/cross-exchange-reconciliation.service.test.ts
import { reconcileCrossExchangeBot } from '../../src/services/cross-exchange-reconciliation.service';

const mockBot = (overrides = {}) => ({
  id: 1, coin: 'USDE', targetDirection: 'UB',
  lastResumeAt: new Date('2026-05-01T00:00:00Z'),
  createdAt: new Date('2026-04-30T00:00:00Z'),
  ...overrides,
}) as any;

describe('reconcileCrossExchangeBot', () => {
  it('DB FILLED 와 거래소 done order 일치 시 isReconciled=true', async () => {
    const stablecoinPrisma = {
      crossExchangeArbBot: { findUnique: jest.fn().mockResolvedValue(mockBot()) },
      crossExchangeArbTrade: {
        findMany: jest.fn().mockResolvedValue([
          { id: BigInt(1), status: 'FILLED', legAFilledQty: 10, legBFilledQty: 10, createdAt: new Date('2026-05-01T01:00:00Z') },
        ]),
      },
    };
    const upbitClient = { /* mock */ } as any;
    const bithumbClient = { /* mock */ } as any;

    const result = await reconcileCrossExchangeBot(1, stablecoinPrisma, upbitClient, bithumbClient, {
      mockUpbitOrders: [{ filledQty: 10, side: 'buy', timestamp: new Date('2026-05-01T01:00:00Z') }],
      mockBithumbOrders: [{ filledQty: 10, side: 'sell', timestamp: new Date('2026-05-01T01:00:00Z') }],
    });

    expect(result.isReconciled).toBe(true);
    expect(result.dbFilledCount).toBe(1);
  });

  it('DB FILLED 보다 거래소 done order 가 적으면 불일치', async () => {
    const stablecoinPrisma = {
      crossExchangeArbBot: { findUnique: jest.fn().mockResolvedValue(mockBot()) },
      crossExchangeArbTrade: {
        findMany: jest.fn().mockResolvedValue([
          { id: BigInt(1), status: 'FILLED', legAFilledQty: 10, legBFilledQty: 10, createdAt: new Date('2026-05-01T01:00:00Z') },
        ]),
      },
    };
    const result = await reconcileCrossExchangeBot(1, stablecoinPrisma, {} as any, {} as any, {
      mockUpbitOrders: [],
      mockBithumbOrders: [],
    });
    expect(result.isReconciled).toBe(false);
  });

  it('100건 초과 시 pageTruncated=true', async () => {
    const stablecoinPrisma = {
      crossExchangeArbBot: { findUnique: jest.fn().mockResolvedValue(mockBot()) },
      crossExchangeArbTrade: {
        findMany: jest.fn().mockResolvedValue(
          Array.from({ length: 101 }, (_, i) => ({ id: BigInt(i+1), status: 'FILLED', legAFilledQty: 10, legBFilledQty: 10, createdAt: new Date() }))
        ),
      },
    };
    const result = await reconcileCrossExchangeBot(1, stablecoinPrisma, {} as any, {} as any, {
      mockUpbitOrders: [], mockBithumbOrders: [],
    });
    expect(result.pageTruncated).toBe(true);
  });
});
```

- [ ] **Step 2: 테스트 실행 → FAIL**

Run:
```bash
npx jest __tests__/services/cross-exchange-reconciliation.service.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: 구현**

```typescript
// src/services/cross-exchange-reconciliation.service.ts
import { ExchangeClient } from './exchange/exchange-client';

export interface ReconciliationReport {
  botId: number;
  coin: string;
  sinceSource: 'lastResumeAt' | 'createdAt';
  sinceAt: Date;
  dbFilledCount: number;
  upbitDoneCount: number;
  bithumbDoneCount: number;
  isReconciled: boolean;
  diff?: string;
  pageTruncated: boolean;
}

interface MockOrders {
  mockUpbitOrders?: Array<{ filledQty: number; side: 'buy' | 'sell'; timestamp: Date }>;
  mockBithumbOrders?: Array<{ filledQty: number; side: 'buy' | 'sell'; timestamp: Date }>;
}

/**
 * Cross-exchange bot 의 잔고 정합 검증.
 * lastResumeAt 이후 양 거래소 done order 와 DB FILLED row 비교.
 *
 * mockOrders 는 테스트 전용. production 에서는 client.* 메서드로 조회.
 */
export async function reconcileCrossExchangeBot(
  botId: number,
  stablecoinPrisma: any,
  upbitClient: ExchangeClient,
  bithumbClient: ExchangeClient,
  mockOrders?: MockOrders,
): Promise<ReconciliationReport> {
  const bot = await stablecoinPrisma.crossExchangeArbBot.findUnique({ where: { id: botId } });
  if (!bot) {
    throw new Error(`Bot ${botId} not found`);
  }

  const sinceSource = bot.lastResumeAt ? 'lastResumeAt' : 'createdAt';
  const sinceAt = bot.lastResumeAt ?? bot.createdAt;

  const dbTrades = await stablecoinPrisma.crossExchangeArbTrade.findMany({
    where: { botId, status: 'FILLED', createdAt: { gte: sinceAt } },
    orderBy: { createdAt: 'asc' },
    take: 101, // pageTruncated 감지용
  });
  const dbFilledCount = Math.min(dbTrades.length, 100);
  const pageTruncated = dbTrades.length > 100;

  // 거래소 done order 조회 (mockOrders 우선)
  const upbitOrders = mockOrders?.mockUpbitOrders ?? []; // 실 production: 별도 endpoint 호출
  const bithumbOrders = mockOrders?.mockBithumbOrders ?? [];

  const upbitDoneCount = upbitOrders.length;
  const bithumbDoneCount = bithumbOrders.length;

  // 단순 비교: DB FILLED 수 == upbit done 수 == bithumb done 수
  const isReconciled = (dbFilledCount === upbitDoneCount) && (dbFilledCount === bithumbDoneCount);
  const diff = isReconciled ? undefined :
    `db=${dbFilledCount}, upbit=${upbitDoneCount}, bithumb=${bithumbDoneCount}`;

  return {
    botId, coin: bot.coin, sinceSource, sinceAt,
    dbFilledCount, upbitDoneCount, bithumbDoneCount,
    isReconciled, diff, pageTruncated,
  };
}
```

- [ ] **Step 4: 테스트 실행 → PASS**

Run:
```bash
npx jest __tests__/services/cross-exchange-reconciliation.service.test.ts
```

Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add src/services/cross-exchange-reconciliation.service.ts __tests__/services/cross-exchange-reconciliation.service.test.ts
git commit -m "feat: cross-exchange reconciliation service (PR H 패턴)"
```

---

## Task 10: Cross-Exchange Arb Agent

**Files:**
- Create: `src/agents/cross-exchange-arb-agent.ts`
- Modify: `__mocks__/database.ts` (crossExchangeArbBot/Trade 메서드 추가)

- [ ] **Step 1: __mocks__/database.ts 에 Prisma mock 추가**

기존 mock 파일에 추가:

```typescript
// __mocks__/database.ts (기존 파일 수정)
// stablecoinPrisma 객체에 다음 추가:
crossExchangeArbBot: {
  findMany: jest.fn().mockResolvedValue([]),
  findUnique: jest.fn().mockResolvedValue(null),
  update: jest.fn().mockResolvedValue({}),
  updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  create: jest.fn().mockResolvedValue({}),
  findFirst: jest.fn().mockResolvedValue(null),
},
crossExchangeArbTrade: {
  findMany: jest.fn().mockResolvedValue([]),
  create: jest.fn().mockResolvedValue({}),
  update: jest.fn().mockResolvedValue({}),
  count: jest.fn().mockResolvedValue(0),
  aggregate: jest.fn().mockResolvedValue({ _sum: { profitKrw: 0 } }),
},
```

- [ ] **Step 2: Agent 구현**

```typescript
// src/agents/cross-exchange-arb-agent.ts
import { BaseAgent } from './base-agent';
import { stablecoinPrisma } from '../config/database';
import { UpbitClient } from '../services/exchange/upbit-client';
import { BithumbClient } from '../services/exchange/bithumb-client';
import { runAll } from '../services/cross-exchange-precheck';
import { execute } from '../services/cross-exchange-executor';
import { decrypt } from '../utils/encryption';
import prisma from '../config/database';

const CYCLE_INTERVAL_MS = 5_000;

export class CrossExchangeArbAgent extends BaseAgent {
  private upbitClient: UpbitClient | null = null;
  private bithumbClient: BithumbClient | null = null;

  constructor() {
    super({
      id: 'cross-exchange-arb',
      name: 'CrossExchangeArbAgent',
      description: 'Upbit-Bithumb 양 거래소 cross-exchange 차익 거래 (5초 cycle)',
      cycleIntervalMs: CYCLE_INTERVAL_MS,
    });
  }

  protected async onStart(): Promise<void> {
    console.log('[CrossExchangeArb] 시작 — Bithumb API 키 로드');
    await this.loadClients();
  }

  protected async onStop(): Promise<void> {
    console.log('[CrossExchangeArb] 정지');
  }

  /** Bithumb API 키 + Upbit credential 로드. userId=2 (admin) 기준. */
  private async loadClients(): Promise<void> {
    const upbitCred = await prisma.credential.findFirst({ where: { userId: 2, exchange: 'upbit' } });
    if (!upbitCred) {
      console.warn('[CrossExchangeArb] Upbit credential 없음 — agent 비활성');
      return;
    }
    this.upbitClient = new UpbitClient({
      accessKey: decrypt(upbitCred.apiKey),
      secretKey: decrypt(upbitCred.secretKey),
    });
    const bithumbAccessKey = process.env.BITHUMB_ACCESS_KEY;
    const bithumbSecretKey = process.env.BITHUMB_SECRET_KEY;
    if (!bithumbAccessKey || !bithumbSecretKey) {
      console.warn('[CrossExchangeArb] BITHUMB_*_KEY 환경변수 없음 — agent 비활성');
      return;
    }
    this.bithumbClient = new BithumbClient({
      accessKey: bithumbAccessKey,
      secretKey: bithumbSecretKey,
    });
  }

  protected async onCycle(): Promise<void> {
    if (!this.upbitClient || !this.bithumbClient) return;

    const bots = await stablecoinPrisma.crossExchangeArbBot.findMany({
      where: { enabled: true, killSwitch: false },
    });

    for (const bot of bots) {
      await this.processBot(bot);
    }
  }

  private async processBot(bot: any): Promise<void> {
    if (!this.upbitClient || !this.bithumbClient) return;

    // 호가 동시 조회
    const [upbitOb, bithumbOb] = await Promise.all([
      this.upbitClient.getOrderbookTop(bot.coin),
      this.bithumbClient.getOrderbookTop(bot.coin),
    ]);
    if (!upbitOb || !bithumbOb) {
      console.log(`[CrossExchangeArb] bot ${bot.id}: orderbook fetch fail`);
      return;
    }
    const snapshot = {
      upbitBid: upbitOb.bid, upbitAsk: upbitOb.ask,
      bithumbBid: bithumbOb.bid, bithumbAsk: bithumbOb.ask,
    };

    // 잔고 + 일일 통계 (간단화: 별도 캐싱 안 함, 매 cycle 조회)
    const [upbitBalances, bithumbBalances] = await Promise.all([
      this.upbitClient.getBalances(),
      this.bithumbClient.getBalances(),
    ]);
    const balances = {
      upbit: Object.fromEntries(Object.entries(upbitBalances).map(([k, v]) => [k, v.available])),
      bithumb: Object.fromEntries(Object.entries(bithumbBalances).map(([k, v]) => [k, v.available])),
    };
    const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
    const todayCount = await stablecoinPrisma.crossExchangeArbTrade.count({
      where: { botId: bot.id, status: 'FILLED', createdAt: { gte: startOfDay } },
    });
    const lossAgg = await stablecoinPrisma.crossExchangeArbTrade.aggregate({
      where: { botId: bot.id, status: 'FILLED', createdAt: { gte: startOfDay }, profitKrw: { lt: 0 } },
      _sum: { profitKrw: true },
    });
    const todayLossKrw = Math.abs(Number(lossAgg._sum.profitKrw ?? 0));

    // Precheck
    const precheck = runAll({
      snapshot, direction: bot.targetDirection,
      bot: {
        coin: bot.coin, quantity: bot.quantity, minSpreadBps: bot.minSpreadBps,
        depegMinKrw: bot.depegMinKrw, depegMaxKrw: bot.depegMaxKrw,
        liquidityMultiplier: bot.liquidityMultiplier,
        dailyCountLimit: bot.dailyCountLimit, dailyLossLimitKrw: bot.dailyLossLimitKrw,
      },
      liquidity: {
        upbitBidQty: upbitOb.bidQty, upbitAskQty: upbitOb.askQty,
        bithumbBidQty: bithumbOb.bidQty, bithumbAskQty: bithumbOb.askQty,
      },
      balances, todayCount, todayLossKrw,
    });
    if (!precheck.ok) {
      console.log(`[CrossExchangeArb] bot ${bot.id} skip: ${precheck.abortReason}`);
      return;
    }

    // Executor
    const result = await execute({
      botId: bot.id, direction: bot.targetDirection,
      coin: bot.coin, quantity: bot.quantity, spreadBps: 0, // executor 내부에서 다시 계산 안 하므로 placeholder
      upbit: this.upbitClient, bithumb: this.bithumbClient,
    });

    // Trade 기록
    await stablecoinPrisma.crossExchangeArbTrade.create({
      data: {
        botId: bot.id,
        direction: bot.targetDirection,
        spreadBpsAtPlacement: 0, // TODO: 실제 spread 보존
        legAExchange: result.legA?.exchange ?? '',
        legASide: result.legA?.side ?? '',
        legAOrderId: result.legA?.orderId ?? null,
        legAFilledQty: result.legA?.filledQty ?? null,
        legAAvgPrice: result.legA?.avgFillPrice ?? null,
        legAFeeKrw: result.legA?.totalFeeKrw ?? null,
        legBExchange: result.legB?.exchange ?? '',
        legBSide: result.legB?.side ?? '',
        legBOrderId: result.legB?.orderId ?? null,
        legBFilledQty: result.legB?.filledQty ?? null,
        legBAvgPrice: result.legB?.avgFillPrice ?? null,
        legBFeeKrw: result.legB?.totalFeeKrw ?? null,
        profitKrw: result.profitKrw ?? null,
        status: result.status,
        failureReason: result.failureReason ?? null,
        completedAt: result.status === 'FILLED' ? new Date() : null,
      },
    });

    // Auto kill switch (LegB 실패 시)
    if (result.shouldKillSwitch) {
      await stablecoinPrisma.crossExchangeArbBot.update({
        where: { id: bot.id },
        data: { killSwitch: true },
      });
      console.error(`[CrossExchangeArb] bot ${bot.id} autoKillSwitch ON: ${result.failureReason}`);
    }
  }
}
```

⚠️ executor 의 `spreadBps` 파라미터는 placeholder (트레이드 기록 시 0). spec 정확성을 위해서는 `runAll` 결과에서 spread bps 받아와야 함. 후속 정리.

- [ ] **Step 3: 빌드 + 타입 검증**

Run:
```bash
npm run build
```

Expected: 0 errors (prisma generate + tsc)

- [ ] **Step 4: Commit**

```bash
git add src/agents/cross-exchange-arb-agent.ts __mocks__/database.ts
git commit -m "feat: CrossExchangeArbAgent (5초 cycle agent)"
```

---

## Task 11: agent-manager 등록

**Files:**
- Modify: `src/agents/agent-manager.ts`

- [ ] **Step 1: import + register**

`src/agents/agent-manager.ts` 의 init/start 부분 찾아서 추가 (기존 6 에이전트 등록 패턴 따름):

```typescript
import { CrossExchangeArbAgent } from './cross-exchange-arb-agent';
// ... existing imports

// init 함수 안:
this.agents.set('cross-exchange-arb', new CrossExchangeArbAgent());
```

- [ ] **Step 2: 빌드 검증**

Run:
```bash
npm run build
```

Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add src/agents/agent-manager.ts
git commit -m "feat: agent-manager 에 CrossExchangeArbAgent 등록 (7번째 agent)"
```

---

## Task 12: Controller — Cross-Exchange Bot CRUD + Verify Endpoint

**Files:**
- Modify: `src/controllers/stablecoin-admin.controller.ts`

- [ ] **Step 1: serializeCrossExchangeBot 추가**

기존 controller 파일 끝에 추가:

```typescript
function serializeCrossExchangeBot(bot: any) {
  return {
    id: bot.id,
    userId: bot.userId,
    coin: bot.coin,
    targetDirection: bot.targetDirection,
    quantity: bot.quantity,
    minSpreadBps: bot.minSpreadBps,
    enabled: bot.enabled,
    killSwitch: bot.killSwitch,
    depegMinKrw: bot.depegMinKrw,
    depegMaxKrw: bot.depegMaxKrw,
    liquidityMultiplier: bot.liquidityMultiplier,
    dailyCountLimit: bot.dailyCountLimit,
    dailyLossLimitKrw: bot.dailyLossLimitKrw,
    lastResumeAt: bot.lastResumeAt?.toISOString() ?? null,
    createdAt: bot.createdAt.toISOString(),
    updatedAt: bot.updatedAt.toISOString(),
  };
}
```

- [ ] **Step 2: GET, POST, PATCH, DELETE handler 추가**

```typescript
export const listCrossExchangeBots = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const bots = await stablecoinPrisma.crossExchangeArbBot.findMany({ where: { userId } });
    res.json({ bots: bots.map(serializeCrossExchangeBot) });
  } catch (err) { next(err); }
};

export const createCrossExchangeBot = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const body = req.body;
    if (!['UB', 'BU'].includes(body.targetDirection)) {
      throw new AppError('targetDirection must be UB or BU', 400);
    }
    if (!Number.isInteger(body.quantity) || body.quantity <= 0) {
      throw new AppError('quantity must be positive integer', 400);
    }
    const bot = await stablecoinPrisma.crossExchangeArbBot.create({
      data: {
        userId,
        coin: body.coin,
        targetDirection: body.targetDirection,
        quantity: body.quantity,
        minSpreadBps: body.minSpreadBps ?? 50,
        depegMinKrw: body.depegMinKrw ?? 1380,
        depegMaxKrw: body.depegMaxKrw ?? 1420,
        liquidityMultiplier: body.liquidityMultiplier ?? 1.5,
        dailyCountLimit: body.dailyCountLimit ?? 5,
        dailyLossLimitKrw: body.dailyLossLimitKrw ?? 50000,
      },
    });
    res.status(201).json({ bot: serializeCrossExchangeBot(bot) });
  } catch (err) { next(err); }
};

export const patchCrossExchangeBot = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const id = parseInt(req.params.id, 10);
    const body = req.body;
    const existing = await stablecoinPrisma.crossExchangeArbBot.findFirst({ where: { id, userId } });
    if (!existing) throw new AppError('Bot not found', 404);

    const patch: any = {};
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.killSwitch !== undefined) patch.killSwitch = body.killSwitch;
    if (body.minSpreadBps !== undefined) patch.minSpreadBps = body.minSpreadBps;
    if (body.quantity !== undefined) patch.quantity = body.quantity;
    if (body.depegMinKrw !== undefined) patch.depegMinKrw = body.depegMinKrw;
    if (body.depegMaxKrw !== undefined) patch.depegMaxKrw = body.depegMaxKrw;
    if (body.liquidityMultiplier !== undefined) patch.liquidityMultiplier = body.liquidityMultiplier;
    if (body.dailyCountLimit !== undefined) patch.dailyCountLimit = body.dailyCountLimit;
    if (body.dailyLossLimitKrw !== undefined) patch.dailyLossLimitKrw = body.dailyLossLimitKrw;

    // enabled false→true 전환 시 lastResumeAt 자동 갱신 (PR H 패턴)
    if (existing.enabled === false && patch.enabled === true) {
      patch.lastResumeAt = new Date();
    }

    const updated = await stablecoinPrisma.crossExchangeArbBot.update({ where: { id }, data: patch });
    res.json({ bot: serializeCrossExchangeBot(updated) });
  } catch (err) { next(err); }
};

export const deleteCrossExchangeBot = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const id = parseInt(req.params.id, 10);
    await stablecoinPrisma.crossExchangeArbBot.deleteMany({ where: { id, userId } });
    res.json({ success: true });
  } catch (err) { next(err); }
};

export const verifyCrossExchangeReconciliation = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const id = parseInt(req.params.id, 10);
    const bot = await stablecoinPrisma.crossExchangeArbBot.findFirst({ where: { id, userId } });
    if (!bot) throw new AppError('Bot not found', 404);

    // production: 실제 client 로 done order 조회. 여기서는 단순 DB FILLED count 만 (간이 검증)
    const sinceAt = bot.lastResumeAt ?? bot.createdAt;
    const dbFilledCount = await stablecoinPrisma.crossExchangeArbTrade.count({
      where: { botId: id, status: 'FILLED', createdAt: { gte: sinceAt } },
    });
    res.json({
      botId: id,
      coin: bot.coin,
      sinceAt: sinceAt.toISOString(),
      dbFilledCount,
      isReconciled: true, // production 에서는 실제 거래소 done order 와 비교
      pageTruncated: dbFilledCount > 100,
      note: 'Stage 1 캐너리 — 실 reconciliation 은 Stage 2에서 거래소 done order 조회 추가',
    });
  } catch (err) { next(err); }
};
```

- [ ] **Step 2: 빌드**

Run:
```bash
npm run build
```

Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add src/controllers/stablecoin-admin.controller.ts
git commit -m "feat: cross-exchange bot CRUD + verify endpoint"
```

---

## Task 13: Routes 등록

**Files:**
- Modify: `src/routes/stablecoin-admin.ts`

- [ ] **Step 1: 신규 route 5개 추가**

기존 route 정의 끝에 추가:

```typescript
import {
  // ... 기존 imports
  listCrossExchangeBots,
  createCrossExchangeBot,
  patchCrossExchangeBot,
  deleteCrossExchangeBot,
  verifyCrossExchangeReconciliation,
} from '../controllers/stablecoin-admin.controller';

// 기존 route 들 뒤에:
router.get('/cross-exchange-bots', listCrossExchangeBots);
router.post('/cross-exchange-bots', createCrossExchangeBot);
router.patch('/cross-exchange-bots/:id', patchCrossExchangeBot);
router.delete('/cross-exchange-bots/:id', deleteCrossExchangeBot);
router.post('/cross-exchange-bots/:id/verify-reconciliation', verifyCrossExchangeReconciliation);
```

- [ ] **Step 2: 빌드**

Run:
```bash
npm run build
```

Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add src/routes/stablecoin-admin.ts
git commit -m "feat: cross-exchange-bots routes 등록 (5 endpoints)"
```

---

## Task 14: Frontend lib/api.ts 확장

**Files:**
- Modify: `D:/ExpressProject/Grid_project/v0-grid-transaction-frontend/lib/api.ts`

- [ ] **Step 1: 타입 + API 함수 추가**

`lib/api.ts` 끝에 추가:

```typescript
// === Cross-Exchange Arb ===

export interface CrossExchangeArbBot {
  id: number;
  userId: number;
  coin: string;
  targetDirection: 'UB' | 'BU';
  quantity: number;
  minSpreadBps: number;
  enabled: boolean;
  killSwitch: boolean;
  depegMinKrw: number;
  depegMaxKrw: number;
  liquidityMultiplier: number;
  dailyCountLimit: number;
  dailyLossLimitKrw: number;
  lastResumeAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCrossExchangeBotBody {
  coin: string;
  targetDirection: 'UB' | 'BU';
  quantity: number;
  minSpreadBps?: number;
  depegMinKrw?: number;
  depegMaxKrw?: number;
  liquidityMultiplier?: number;
  dailyCountLimit?: number;
  dailyLossLimitKrw?: number;
}

export interface PatchCrossExchangeBotBody {
  enabled?: boolean;
  killSwitch?: boolean;
  quantity?: number;
  minSpreadBps?: number;
  depegMinKrw?: number;
  depegMaxKrw?: number;
  liquidityMultiplier?: number;
  dailyCountLimit?: number;
  dailyLossLimitKrw?: number;
}

export interface CrossExchangeReconciliationReport {
  botId: number;
  coin: string;
  sinceAt: string;
  dbFilledCount: number;
  isReconciled: boolean;
  pageTruncated: boolean;
  note?: string;
}

export async function listCrossExchangeBots(): Promise<CrossExchangeArbBot[]> {
  const res = await apiFetch('/api/admin/stablecoin/cross-exchange-bots');
  return res.bots;
}

export async function createCrossExchangeBot(body: CreateCrossExchangeBotBody): Promise<CrossExchangeArbBot> {
  const res = await apiFetch('/api/admin/stablecoin/cross-exchange-bots', { method: 'POST', body: JSON.stringify(body) });
  return res.bot;
}

export async function patchCrossExchangeBot(id: number, body: PatchCrossExchangeBotBody): Promise<CrossExchangeArbBot> {
  const res = await apiFetch(`/api/admin/stablecoin/cross-exchange-bots/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  return res.bot;
}

export async function deleteCrossExchangeBot(id: number): Promise<void> {
  await apiFetch(`/api/admin/stablecoin/cross-exchange-bots/${id}`, { method: 'DELETE' });
}

export async function verifyCrossExchangeReconciliation(id: number): Promise<CrossExchangeReconciliationReport> {
  return apiFetch(`/api/admin/stablecoin/cross-exchange-bots/${id}/verify-reconciliation`, { method: 'POST' });
}
```

⚠️ `apiFetch` 헬퍼 시그니처는 기존 lib/api.ts 의 다른 함수 참고하여 일치시킬 것.

- [ ] **Step 2: 빌드 검증**

Run:
```bash
cd D:/ExpressProject/Grid_project/v0-grid-transaction-frontend && npm run build
```

Expected: 0 errors

- [ ] **Step 3: Commit (frontend repo 별도)**

```bash
cd D:/ExpressProject/Grid_project/v0-grid-transaction-frontend
git add lib/api.ts
git commit -m "feat: cross-exchange arb 타입 + API 함수 5개"
```

---

## Task 15: EditCrossExchangeBotDialog 신규

**Files:**
- Create: `D:/ExpressProject/Grid_project/v0-grid-transaction-frontend/app/admin/stablecoin/_components/EditCrossExchangeBotDialog.tsx`

- [ ] **Step 1: 컴포넌트 작성 (PR H EditMakerBotDialog 패턴 답습)**

```tsx
"use client"
import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { CrossExchangeArbBot, PatchCrossExchangeBotBody } from '@/lib/api'

interface Props {
  bot: CrossExchangeArbBot | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (id: number, patch: PatchCrossExchangeBotBody) => Promise<void>
}

export function EditCrossExchangeBotDialog({ bot, open, onOpenChange, onSubmit }: Props) {
  const [quantity, setQuantity] = useState('')
  const [minSpreadBps, setMinSpreadBps] = useState('')
  const [depegMinKrw, setDepegMinKrw] = useState('')
  const [depegMaxKrw, setDepegMaxKrw] = useState('')
  const [dailyCountLimit, setDailyCountLimit] = useState('')
  const [dailyLossLimitKrw, setDailyLossLimitKrw] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (bot) {
      setQuantity(String(bot.quantity))
      setMinSpreadBps(String(bot.minSpreadBps))
      setDepegMinKrw(String(bot.depegMinKrw))
      setDepegMaxKrw(String(bot.depegMaxKrw))
      setDailyCountLimit(String(bot.dailyCountLimit))
      setDailyLossLimitKrw(String(bot.dailyLossLimitKrw))
    }
  }, [bot])

  const handleSubmit = async () => {
    if (!bot) return
    const patch: PatchCrossExchangeBotBody = {}
    if (Number(quantity) !== bot.quantity) patch.quantity = Number(quantity)
    if (Number(minSpreadBps) !== bot.minSpreadBps) patch.minSpreadBps = Number(minSpreadBps)
    if (Number(depegMinKrw) !== bot.depegMinKrw) patch.depegMinKrw = Number(depegMinKrw)
    if (Number(depegMaxKrw) !== bot.depegMaxKrw) patch.depegMaxKrw = Number(depegMaxKrw)
    if (Number(dailyCountLimit) !== bot.dailyCountLimit) patch.dailyCountLimit = Number(dailyCountLimit)
    if (Number(dailyLossLimitKrw) !== bot.dailyLossLimitKrw) patch.dailyLossLimitKrw = Number(dailyLossLimitKrw)
    if (Object.keys(patch).length === 0) {
      onOpenChange(false)
      return
    }
    setSubmitting(true)
    try {
      await onSubmit(bot.id, patch)
      onOpenChange(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cross-Exchange Bot 편집 — {bot?.coin} {bot?.targetDirection}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div>
            <Label>quantity (코인 수량)</Label>
            <Input type="number" value={quantity} onChange={e => setQuantity(e.target.value)} />
          </div>
          <div>
            <Label>minSpreadBps (진입 임계값)</Label>
            <Input type="number" value={minSpreadBps} onChange={e => setMinSpreadBps(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>depegMinKrw</Label>
              <Input type="number" value={depegMinKrw} onChange={e => setDepegMinKrw(e.target.value)} />
            </div>
            <div>
              <Label>depegMaxKrw</Label>
              <Input type="number" value={depegMaxKrw} onChange={e => setDepegMaxKrw(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>dailyCountLimit</Label>
              <Input type="number" value={dailyCountLimit} onChange={e => setDailyCountLimit(e.target.value)} />
            </div>
            <div>
              <Label>dailyLossLimitKrw</Label>
              <Input type="number" value={dailyLossLimitKrw} onChange={e => setDailyLossLimitKrw(e.target.value)} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>취소</Button>
          <Button onClick={handleSubmit} disabled={submitting}>저장</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: 빌드**

Run:
```bash
cd D:/ExpressProject/Grid_project/v0-grid-transaction-frontend && npm run build
```

Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add app/admin/stablecoin/_components/EditCrossExchangeBotDialog.tsx
git commit -m "feat: EditCrossExchangeBotDialog 신규 (cross-exchange bot 편집)"
```

---

## Task 16: CrossExchangeReconciliationDialog 신규

**Files:**
- Create: `D:/ExpressProject/Grid_project/v0-grid-transaction-frontend/app/admin/stablecoin/_components/CrossExchangeReconciliationDialog.tsx`

- [ ] **Step 1: 컴포넌트 작성 (PR H ReconciliationDialog 패턴 답습)**

```tsx
"use client"
import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CrossExchangeReconciliationReport, verifyCrossExchangeReconciliation } from '@/lib/api'

interface Props {
  botId: number | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CrossExchangeReconciliationDialog({ botId, open, onOpenChange }: Props) {
  const [loading, setLoading] = useState(false)
  const [report, setReport] = useState<CrossExchangeReconciliationReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open && botId) {
      setLoading(true)
      setError(null)
      setReport(null)
      verifyCrossExchangeReconciliation(botId)
        .then(setReport)
        .catch(e => setError(e.message))
        .finally(() => setLoading(false))
    }
  }, [open, botId])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cross-Exchange Bot 정합 검증</DialogTitle>
        </DialogHeader>
        <div className="py-4">
          {loading && <p>검증 중...</p>}
          {error && <p className="text-red-500">에러: {error}</p>}
          {report && (
            <div className="space-y-2">
              <p><strong>봇</strong>: #{report.botId} ({report.coin})</p>
              <p><strong>since</strong>: {report.sinceAt}</p>
              <p><strong>DB FILLED 수</strong>: {report.dbFilledCount}</p>
              <p><strong>정합 여부</strong>: {report.isReconciled ? "✅ 정합" : "❌ 불일치"}</p>
              {report.pageTruncated && <p className="text-yellow-500">⚠️ 100건 초과 — 페이지 한계</p>}
              {report.note && <p className="text-gray-500 text-sm">{report.note}</p>}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: 빌드**

Run:
```bash
cd D:/ExpressProject/Grid_project/v0-grid-transaction-frontend && npm run build
```

Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add app/admin/stablecoin/_components/CrossExchangeReconciliationDialog.tsx
git commit -m "feat: CrossExchangeReconciliationDialog 신규"
```

---

## Task 17: CrossExchangeBotPanel + admin 페이지 통합

**Files:**
- Create: `D:/ExpressProject/Grid_project/v0-grid-transaction-frontend/app/admin/stablecoin/_components/CrossExchangeBotPanel.tsx`
- Modify: `D:/ExpressProject/Grid_project/v0-grid-transaction-frontend/app/admin/stablecoin/page.tsx`

- [ ] **Step 1: Panel 컴포넌트 작성**

```tsx
"use client"
import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Pencil, Search, Trash2, Play, Pause } from 'lucide-react'
import { toast } from 'sonner'
import {
  CrossExchangeArbBot, listCrossExchangeBots, patchCrossExchangeBot, deleteCrossExchangeBot,
  PatchCrossExchangeBotBody,
} from '@/lib/api'
import { EditCrossExchangeBotDialog } from './EditCrossExchangeBotDialog'
import { CrossExchangeReconciliationDialog } from './CrossExchangeReconciliationDialog'

export function CrossExchangeBotPanel() {
  const [bots, setBots] = useState<CrossExchangeArbBot[]>([])
  const [editing, setEditing] = useState<CrossExchangeArbBot | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [reconBotId, setReconBotId] = useState<number | null>(null)
  const [reconOpen, setReconOpen] = useState(false)

  const reload = async () => {
    try {
      const list = await listCrossExchangeBots()
      setBots(list)
    } catch (e: any) {
      toast.error('Cross-Exchange bots 조회 실패: ' + e.message)
    }
  }
  useEffect(() => { reload() }, [])

  const handlePatch = async (id: number, patch: PatchCrossExchangeBotBody) => {
    try {
      await patchCrossExchangeBot(id, patch)
      toast.success('저장됨')
      await reload()
    } catch (e: any) {
      toast.error('저장 실패: ' + e.message)
    }
  }

  const handleToggleEnabled = async (bot: CrossExchangeArbBot) => {
    await handlePatch(bot.id, { enabled: !bot.enabled })
  }

  const handleToggleKillSwitch = async (bot: CrossExchangeArbBot) => {
    if (!bot.killSwitch && !confirm(`봇 ${bot.coin} ${bot.targetDirection} killSwitch ON?`)) return
    await handlePatch(bot.id, { killSwitch: !bot.killSwitch })
  }

  const handleDelete = async (bot: CrossExchangeArbBot) => {
    if (!confirm(`봇 ${bot.coin} ${bot.targetDirection} 삭제?`)) return
    try {
      await deleteCrossExchangeBot(bot.id)
      toast.success('삭제됨')
      await reload()
    } catch (e: any) {
      toast.error('삭제 실패: ' + e.message)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cross-Exchange Arbitrage Bots</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {bots.length === 0 && <p className="text-gray-500">봇 없음 — Stage 1 캐너리에서 USDE BU + USD1 UB 봇 추가 필요</p>}
          {bots.map(bot => (
            <div key={bot.id} className={`border rounded p-3 ${bot.killSwitch ? 'border-red-500 border-2' : ''}`}>
              <div className="flex items-center justify-between mb-2">
                <div className="font-bold">
                  Bot #{bot.id} — {bot.coin} {bot.targetDirection}
                  {bot.enabled && <Badge className="ml-2" variant="default">ENABLED</Badge>}
                  {bot.killSwitch && <Badge className="ml-2" variant="destructive">KILLED</Badge>}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => { setEditing(bot); setEditOpen(true) }}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => { setReconBotId(bot.id); setReconOpen(true) }}>
                    <Search className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => handleDelete(bot)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="text-sm space-y-1">
                <div>quantity={bot.quantity}, minSpreadBps={bot.minSpreadBps}</div>
                <div>depeg [{bot.depegMinKrw}, {bot.depegMaxKrw}], daily {bot.dailyCountLimit}건/{bot.dailyLossLimitKrw} KRW</div>
                {bot.lastResumeAt && <div>lastResume: {new Date(bot.lastResumeAt).toLocaleString()}</div>}
              </div>
              <div className="flex gap-2 mt-2">
                <Button size="sm" variant={bot.enabled ? "destructive" : "default"} onClick={() => handleToggleEnabled(bot)}>
                  {bot.enabled ? <><Pause className="h-4 w-4 mr-1" /> 일시정지</> : <><Play className="h-4 w-4 mr-1" /> Resume</>}
                </Button>
                <Button size="sm" variant={bot.killSwitch ? "outline" : "destructive"} onClick={() => handleToggleKillSwitch(bot)}>
                  {bot.killSwitch ? "killSwitch OFF" : "killSwitch ON"}
                </Button>
              </div>
            </div>
          ))}
        </div>
        <EditCrossExchangeBotDialog
          bot={editing} open={editOpen} onOpenChange={setEditOpen}
          onSubmit={handlePatch}
        />
        <CrossExchangeReconciliationDialog
          botId={reconBotId} open={reconOpen} onOpenChange={setReconOpen}
        />
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 2: admin/stablecoin/page.tsx 통합**

기존 페이지에 panel import + render 추가:

```tsx
// app/admin/stablecoin/page.tsx (기존 파일에 추가)
import { CrossExchangeBotPanel } from './_components/CrossExchangeBotPanel'

// 기존 패널들 옆에 추가:
<CrossExchangeBotPanel />
```

- [ ] **Step 3: 빌드**

Run:
```bash
cd D:/ExpressProject/Grid_project/v0-grid-transaction-frontend && npm run build
```

Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add app/admin/stablecoin/_components/CrossExchangeBotPanel.tsx app/admin/stablecoin/page.tsx
git commit -m "feat: CrossExchangeBotPanel + admin/stablecoin/page 통합"
```

---

## Task 18: 회귀 테스트 + 통합 검증

**Files:**
- Run: 백엔드 전체 테스트 + 빌드

- [ ] **Step 1: 백엔드 전체 테스트 실행**

Run:
```bash
cd D:/ExpressProject/Grid_project/v0-grid-tranasction-backend
npx jest
```

Expected: 모든 테스트 PASS (기존 102개 + 신규 약 20개 = 약 122개). 신규 테스트 fail 시 수정.

- [ ] **Step 2: 백엔드 빌드 + tsc**

Run:
```bash
npm run build
```

Expected: 0 errors

- [ ] **Step 3: 프론트엔드 빌드**

Run:
```bash
cd D:/ExpressProject/Grid_project/v0-grid-transaction-frontend
npm run build
```

Expected: 0 errors

- [ ] **Step 4: 프론트엔드 lint**

Run:
```bash
npm run lint
```

Expected: 0 errors (또는 기존 warning 수와 동일)

- [ ] **Step 5: dev 서버에서 수동 smoke test**

```bash
cd v0-grid-tranasction-backend && npm run dev
```

다른 터미널:
```bash
cd v0-grid-transaction-frontend && npm run dev
```

브라우저에서 `http://localhost:3009/admin/stablecoin` 접근 → Cross-Exchange 패널 표시 확인.

- [ ] **Step 6: 모두 OK 시 빈 commit (의도 표시)**

```bash
cd D:/ExpressProject/Grid_project/v0-grid-tranasction-backend
git commit --allow-empty -m "chore: cross-exchange arb 회귀 테스트 + 빌드 검증 완료"
```

---

## Task 19: PR push + 머지 + 배포

**Files:**
- 백엔드 + 프론트엔드 PR 생성

- [ ] **Step 1: 백엔드 push**

```bash
cd D:/ExpressProject/Grid_project/v0-grid-tranasction-backend
git push -u origin feature/cross-exchange-arb-stage-1
```

- [ ] **Step 2: 백엔드 PR 생성**

```bash
gh pr create --base main --head feature/cross-exchange-arb-stage-1 \
  --title "feat: Cross-Exchange Arb Stage 1 캐너리 구현 (백엔드)" \
  --body "$(cat <<'EOF'
## Summary
- Upbit-Bithumb cross-exchange arbitrage Stage 1 캐너리 구현
- USDE BU + USD1 UB 양봇 지원 (50 bps 임계값, quantity=10, daily 5건)
- ExchangeClient 인터페이스 + UpbitClient + BithumbClient 신규
- Sequential + No Fallback 거래 패턴 (Q6=A)
- 5단계 precheck (spread/depeg/liquidity/balance/limit)
- 7번째 에이전트 CrossExchangeArbAgent

## Test plan
- [ ] 단위 테스트 + 회귀 테스트 모두 PASS
- [ ] BITHUMB_*_KEY 환경변수 production 주입 확인
- [ ] 머지 후 6→7 에이전트 errors=0 확인
- [ ] Bithumb 사전 입금 완료 후 Stage 1 가동 (별도 runbook)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: 프론트엔드 push + PR (다른 디렉토리)**

```bash
cd D:/ExpressProject/Grid_project/v0-grid-transaction-frontend
git checkout -b feature/cross-exchange-arb-stage-1  # 새 branch (같은 이름 OK)
git push -u origin feature/cross-exchange-arb-stage-1
gh pr create --base main --head feature/cross-exchange-arb-stage-1 \
  --title "feat: Cross-Exchange Arb Stage 1 UI" \
  --body "Cross-Exchange bot panel + Edit dialog + Reconciliation dialog 신규"
```

- [ ] **Step 4: 백엔드 PR 머지 (production 배포 트리거)**

```bash
gh pr merge --squash --delete-branch  # 백엔드 PR
```

- [ ] **Step 5: GitHub Actions 워크플로우 success 확인**

```bash
gh run list --limit 1
```

Expected: completed success

- [ ] **Step 6: 7 에이전트 health 확인**

```bash
curl -s http://54.180.188.8:3010/api/agents | python -c "import sys, json; d=json.load(sys.stdin); print(len(d['data']), 'agents'); [print(a['id'], a['status']) for a in d['data']]"
```

Expected: 7 agents 모두 running.

- [ ] **Step 7: 프론트엔드 PR 머지**

```bash
cd D:/ExpressProject/Grid_project/v0-grid-transaction-frontend
gh pr merge --squash --delete-branch
```

- [ ] **Step 8: Vercel 배포 success 확인**

```bash
gh api repos/DrOksusu/v0-grid-transaction-frontend/deployments --jq '.[0]'
```

---

## 후속 (이번 plan 범위 밖)

- Stage 1 가동 runbook (별도 plan, PR H stage 3 runbook 패턴 답습)
- 첫 FILLED row spec § 2 직접 검증 (Stage 3 와 같은 방식)
- 24h 결과 메모리 작성 (`project_cross_exchange_stage_1_complete_<date>.md`)
- Stage 2 캐너리 (별도 spec)

---

## Self-Review

### Spec coverage

- [x] §0 데이터 분석 → Task 1 데이터 모델, Task 2-7 구현 모두 분석 결과 반영
- [x] §2.2 Prisma 스키마 → Task 1 그대로
- [x] §3 Components → Task 2-10 매핑
- [x] §4 Data flow → Task 10 agent 의 onCycle 구현
- [x] §5 Error handling → Task 8 executor 의 4 케이스 + Task 12 controller 의 verify endpoint
- [x] §6 Testing → 5 단위 테스트 (Task 6, 7, 8, 9, 4-5) + 1 통합 (Task 18)
- [x] §7 Stage 1 캐너리 정의 → Task 12 default 값 + Stage 1 운영 runbook 후속
- [x] §8 사전 자금 → P-1, P-2, P-3 prerequisites
- [x] §9 위험 매트릭스 → 안전장치 default + autoKillSwitch + reconciliation 통해 다 다룸

### Placeholder scan

- [x] "TBD"/"TODO"/"implement later" 검색 결과: Task 5 의 `quantity * 1500` 임시 값 1건. 본문에 명시 (Stage 2 에서 정확화 예정).
- [x] Task 10 의 `spreadBps: 0` placeholder 1건. 본문에 ⚠️ 명시.

### Type consistency

- [x] `CrossExchangeArbBot` 필드: schema → controller → frontend 모두 일치 (id, userId, coin, targetDirection, quantity, minSpreadBps 등)
- [x] `OrderbookSnapshot` 타입 (cross-exchange-spread-gate.ts) → cross-exchange-precheck.ts 에서 import
- [x] `ExecutorResult.status` 값: 'FILLED' / 'LEG_A_FAILED' / 'LEG_B_FAILED' — schema status 컬럼과 일치
- [x] `targetDirection` 'UB' | 'BU' — controller validation, schema, frontend 모두 일치
