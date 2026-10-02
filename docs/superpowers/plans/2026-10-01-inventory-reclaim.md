# 재고 되돌림 리컨실러 (백엔드) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 빗썸에 묶인 전송 비싼 재고를, 되돌림(빗썸 매도 + 업비트 매수) 순차익이 임계 이상일 때 min 최우선호가 사이징으로 자동 체결해 손해 없이 업비트로 재장전하는 신규 전용 서비스.

**Architecture:** 기존 재고형 아비/로밍과 격리된 신규 `src/services/reclaim/` 모듈. 순수함수(사이징·순차익·안전게이트)로 판정 로직을 분리하고, 집행은 기존 `ExchangeLeg`의 지정가 IOC(`sellLimitIoc`/`buyLimitIoc`)를 재사용하되 **flatten 없이 부분체결 남기기**. `BaseAgent` 상속으로 30초 주기 실행.

**Tech Stack:** Express 5 · TypeScript · Prisma(MySQL) · Jest. 재사용: `ExchangeLeg`(exchange-leg.ts), `BaseAgent`, `fetchOrderbookDepth`, `getKrwHoldings`/`getWithdrawFeeInfo`/`getUpbit`/`getBithumb`.

**범위 주의:** 이 계획은 **백엔드만** 다룬다. 관리자 UI(프론트)는 API 완성 후 별도 계획.

---

## 파일 구조

- Create `src/services/reclaim/net.ts` — 순차익 계산·판정 순수함수
- Create `src/services/reclaim/sizing.ts` — min 사이징 순수함수
- Create `src/services/reclaim/gate.ts` — 안전 게이트 순수함수
- Create `src/services/reclaim/executor.ts` — 집행(지정가 IOC 동시, no-flatten)
- Create `src/services/reclaim/target-selector.ts` — 대상 코인 선별
- Create `src/services/reclaim/reclaim.service.ts` — 오케스트레이션(scanOnce) + config/status
- Create `src/agents/reclaim-agent.ts` — 주기 실행 에이전트
- Create `src/controllers/reclaim.controller.ts` — config/status API
- Create `src/routes/reclaim.ts` — 라우트(authenticate+requireAdmin)
- Modify `prisma/schema.prisma` — `ArbReclaimConfig`, `ArbReclaimTrade` 모델
- Modify `src/routes/index.ts` — `/reclaim` 마운트
- Modify `src/index.ts` — 에이전트 등록
- Modify `src/agents/index.ts` — export
- Modify `__mocks__/database.ts` — `arbReclaimConfig`, `arbReclaimTrade` mock
- Test `__tests__/services/reclaim-net.test.ts`, `reclaim-sizing.test.ts`, `reclaim-gate.test.ts`, `reclaim-executor.test.ts`, `reclaim-target.test.ts`

---

## Task 1: Prisma 모델 + 마이그레이션

**Files:**
- Modify: `prisma/schema.prisma` (ArbRoamConfig 모델 뒤에 추가)

- [ ] **Step 1: 모델 추가**

`prisma/schema.prisma`의 `ArbRoamConfig` 모델 정의 바로 뒤에 추가:

```prisma
model ArbReclaimConfig {
  id                      Int      @id @default(autoincrement())
  userId                  Int      @unique
  enabled                 Boolean  @default(false)
  minNetPct               Float    @default(0)      // 순차익 임계(%), 0=본전
  maxOrderKrw             Float    @default(50000)  // 1회 한도(canary 소액)
  dailyMaxCount           Int?     @default(50)
  dailyMaxKrw             Float?   @default(1000000)
  withdrawFeePctThreshold Float    @default(0.3)    // 대상 선별: 출금수수료율(%) 이상만
  imbalanceCapKrw         Float    @default(100000) // 누적 부분체결 불균형 한도
  killSwitch              Boolean  @default(false)
  createdAt               DateTime @default(now())
  updatedAt               DateTime @updatedAt
  @@map("arb_reclaim_configs")
}

model ArbReclaimTrade {
  id               Int      @id @default(autoincrement())
  userId           Int
  symbol           String
  qty              Float
  bithumbSellPrice Float
  upbitBuyPrice    Float
  sellFilled       Float    @default(0)
  buyFilled        Float    @default(0)
  grossKrw         Float    @default(0)
  feeKrw           Float    @default(0)
  netKrw           Float    @default(0)
  status           String   // filled | partial | failed
  note             String?  @db.Text
  createdAt        DateTime @default(now())
  @@index([userId, createdAt])
  @@map("arb_reclaim_trades")
}
```

- [ ] **Step 2: 마이그레이션 생성·적용 (로컬 Dev DB)**

Run: `npx prisma migrate dev --name add_reclaim_config`
Expected: `prisma/migrations/20261001XXXXXX_add_reclaim_config/migration.sql` 생성 + `arb_reclaim_configs`·`arb_reclaim_trades` 테이블 생성. `npx prisma generate` 자동 실행.

- [ ] **Step 3: 타입 확인**

Run: `npx tsc --noEmit`
Expected: 0 errors (Prisma Client에 `arbReclaimConfig`·`arbReclaimTrade` 타입 생성됨)

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: ArbReclaimConfig/Trade 모델 + 마이그레이션"
```

---

## Task 2: 순차익 계산·판정 (순수함수)

**Files:**
- Create: `src/services/reclaim/net.ts`
- Test: `__tests__/services/reclaim-net.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`__tests__/services/reclaim-net.test.ts`:

```typescript
import { reclaimNetPct, shouldReclaim, RECLAIM_FEE_BPS } from '../../src/services/reclaim/net';

describe('reclaimNetPct', () => {
  it('되돌림 순차익% = (빗썸bid-업비트ask)/업비트ask×100 - 수수료%', () => {
    // 빗썸bid 1010, 업비트ask 1000 → gross 1.0%, 수수료 0.09% → net 0.91%
    expect(reclaimNetPct(1010, 1000)).toBeCloseTo(1.0 - RECLAIM_FEE_BPS / 100, 6);
  });
  it('gross가 수수료와 같으면 net 0', () => {
    const ask = 1000, bid = 1000 * (1 + RECLAIM_FEE_BPS / 10000); // gross = 0.09%
    expect(reclaimNetPct(bid, ask)).toBeCloseTo(0, 6);
  });
});

describe('shouldReclaim', () => {
  it('순차익 ≥ minNetPct면 true', () => {
    expect(shouldReclaim(1010, 1000, 0)).toBe(true);   // net 0.91% ≥ 0
    expect(shouldReclaim(1010, 1000, 0.5)).toBe(true);
  });
  it('순차익 < minNetPct면 false', () => {
    expect(shouldReclaim(1000, 1000, 0)).toBe(false);  // net -0.09% < 0
    expect(shouldReclaim(1010, 1000, 2.0)).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest reclaim-net -v`
Expected: FAIL — "Cannot find module '../../src/services/reclaim/net'"

- [ ] **Step 3: 구현**

`src/services/reclaim/net.ts`:

```typescript
// 되돌림(빗썸 매도 + 업비트 매수) 순차익 계산.
// ⚠️ 수수료 기본값은 코드 가정(빗썸 taker 0.04% + 업비트 taker 0.05%). 실제 빗썸 등급이 높으면
//    순차익≥0이 실제로는 손해가 될 수 있음 — 배포 전 실제 taker 등급으로 조정할 것.
export const RECLAIM_FEE_BPS = 9; // 0.09% (빗썸 4 + 업비트 5)

/** 되돌림 순차익(%) = (빗썸bid - 업비트ask)/업비트ask × 100 - 수수료% */
export function reclaimNetPct(bithumbBid: number, upbitAsk: number, feeBps = RECLAIM_FEE_BPS): number {
  if (!(upbitAsk > 0)) return -Infinity;
  const grossPct = ((bithumbBid - upbitAsk) / upbitAsk) * 100;
  return grossPct - feeBps / 100;
}

/** 순차익이 최소 임계 이상이면 실행 */
export function shouldReclaim(bithumbBid: number, upbitAsk: number, minNetPct: number, feeBps = RECLAIM_FEE_BPS): boolean {
  return reclaimNetPct(bithumbBid, upbitAsk, feeBps) >= minNetPct;
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest reclaim-net -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/reclaim/net.ts __tests__/services/reclaim-net.test.ts
git commit -m "feat: 되돌림 순차익 계산·판정 순수함수"
```

---

## Task 3: min 사이징 (순수함수)

**Files:**
- Create: `src/services/reclaim/sizing.ts`
- Test: `__tests__/services/reclaim-sizing.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`__tests__/services/reclaim-sizing.test.ts`:

```typescript
import { computeReclaimQty } from '../../src/services/reclaim/sizing';

const base = {
  bithumbBidQty: 100, upbitAskQty: 100, bithumbHolding: 100,
  upbitKrw: 1_000_000, upbitAsk: 1000, maxOrderKrw: 50000, feeBps: 5,
};

describe('computeReclaimQty', () => {
  it('최우선호가 물량이 가장 작으면 그 값으로 제한', () => {
    expect(computeReclaimQty({ ...base, bithumbBidQty: 3 })).toBeCloseTo(3, 8);
    expect(computeReclaimQty({ ...base, upbitAskQty: 2 })).toBeCloseTo(2, 8);
  });
  it('보유 재고가 가장 작으면 재고로 제한', () => {
    expect(computeReclaimQty({ ...base, bithumbHolding: 1.5 })).toBeCloseTo(1.5, 8);
  });
  it('1회 한도(maxOrderKrw)로 제한 — 50000/1000 = 50', () => {
    expect(computeReclaimQty(base)).toBeCloseTo(50, 8);
  });
  it('업비트 KRW 잔고 부족이면 그만큼만', () => {
    // upbitKrw 10000, ask 1000, fee 0.05% → 10000/(1000*1.0005) ≈ 9.995
    expect(computeReclaimQty({ ...base, upbitKrw: 10000 })).toBeLessThan(10);
  });
  it('음수/0 입력 방어 → 0', () => {
    expect(computeReclaimQty({ ...base, bithumbHolding: 0 })).toBe(0);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest reclaim-sizing -v`
Expected: FAIL — module not found

- [ ] **Step 3: 구현**

`src/services/reclaim/sizing.ts`:

```typescript
export interface ReclaimSizingInput {
  bithumbBidQty: number;   // 빗썸 최우선 매수호가 물량 (내가 매도 가능한 수량)
  upbitAskQty: number;     // 업비트 최우선 매도호가 물량 (내가 매수 가능한 수량)
  bithumbHolding: number;  // 빗썸 보유 재고
  upbitKrw: number;        // 업비트 KRW 잔고
  upbitAsk: number;        // 업비트 매수 체결 가격
  maxOrderKrw: number;     // 1회 한도
  feeBps: number;          // 업비트 매수 수수료(bps) — 예산 보정용
}

/**
 * 되돌림 주문 수량 = min(빗썸 bid 물량, 업비트 ask 물량, 빗썸 재고, 한도/가격, 업비트KRW/가격).
 * 최우선호가 물량 이내로 잡아 양쪽 완전체결 + 슬리피지 0을 목표.
 */
export function computeReclaimQty(i: ReclaimSizingInput): number {
  if (!(i.upbitAsk > 0)) return 0;
  const feeFactor = 1 + i.feeBps / 10000;
  const qtyByMaxOrder = i.maxOrderKrw / i.upbitAsk;
  const qtyByUpbitKrw = i.upbitKrw / (i.upbitAsk * feeFactor);
  const raw = Math.min(i.bithumbBidQty, i.upbitAskQty, i.bithumbHolding, qtyByMaxOrder, qtyByUpbitKrw);
  return Math.max(0, Math.floor(raw * 1e8) / 1e8);
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest reclaim-sizing -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/reclaim/sizing.ts __tests__/services/reclaim-sizing.test.ts
git commit -m "feat: 되돌림 min 사이징 순수함수"
```

---

## Task 4: 안전 게이트 (순수함수)

**Files:**
- Create: `src/services/reclaim/gate.ts`
- Test: `__tests__/services/reclaim-gate.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`__tests__/services/reclaim-gate.test.ts`:

```typescript
import { checkReclaimGate } from '../../src/services/reclaim/gate';

const ok = {
  enabled: true, killSwitch: false,
  todayCount: 0, dailyMaxCount: 50,
  todayNotionalKrw: 0, dailyMaxKrw: 1_000_000,
  imbalanceKrw: 0, imbalanceCapKrw: 100_000,
};

describe('checkReclaimGate', () => {
  it('정상 조건 → ok', () => { expect(checkReclaimGate(ok).ok).toBe(true); });
  it('enabled=false → disabled', () => { expect(checkReclaimGate({ ...ok, enabled: false })).toEqual({ ok: false, reason: 'disabled' }); });
  it('killSwitch → killSwitch', () => { expect(checkReclaimGate({ ...ok, killSwitch: true }).reason).toBe('killSwitch'); });
  it('일 건수 초과 → dailyMaxCount', () => { expect(checkReclaimGate({ ...ok, todayCount: 50 }).reason).toBe('dailyMaxCount'); });
  it('일 금액 초과 → dailyMaxKrw', () => { expect(checkReclaimGate({ ...ok, todayNotionalKrw: 1_000_000 }).reason).toBe('dailyMaxKrw'); });
  it('불균형 한도 초과 → imbalanceCap', () => { expect(checkReclaimGate({ ...ok, imbalanceKrw: 100_000 }).reason).toBe('imbalanceCap'); });
  it('null 한도는 무제한', () => { expect(checkReclaimGate({ ...ok, dailyMaxCount: null, dailyMaxKrw: null, todayCount: 9999 }).ok).toBe(true); });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest reclaim-gate -v` → FAIL (module not found)

- [ ] **Step 3: 구현**

`src/services/reclaim/gate.ts`:

```typescript
export interface ReclaimGateInput {
  enabled: boolean;
  killSwitch: boolean;
  todayCount: number;
  dailyMaxCount: number | null;
  todayNotionalKrw: number;
  dailyMaxKrw: number | null;
  imbalanceKrw: number;       // 누적 부분체결 불균형 금액
  imbalanceCapKrw: number;
}

/** 스캔/실행 전 안전 게이트. 하나라도 걸리면 미실행. */
export function checkReclaimGate(i: ReclaimGateInput): { ok: boolean; reason?: string } {
  if (!i.enabled) return { ok: false, reason: 'disabled' };
  if (i.killSwitch) return { ok: false, reason: 'killSwitch' };
  if (i.dailyMaxCount != null && i.todayCount >= i.dailyMaxCount) return { ok: false, reason: 'dailyMaxCount' };
  if (i.dailyMaxKrw != null && i.todayNotionalKrw >= i.dailyMaxKrw) return { ok: false, reason: 'dailyMaxKrw' };
  if (i.imbalanceKrw >= i.imbalanceCapKrw) return { ok: false, reason: 'imbalanceCap' };
  return { ok: true };
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest reclaim-gate -v` → PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/reclaim/gate.ts __tests__/services/reclaim-gate.test.ts
git commit -m "feat: 되돌림 안전 게이트 순수함수"
```

---

## Task 5: 집행기 (지정가 IOC 동시, no-flatten)

**Files:**
- Create: `src/services/reclaim/executor.ts`
- Test: `__tests__/services/reclaim-executor.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`__tests__/services/reclaim-executor.test.ts` (기존 `inventory-arb-executor.test.ts:4-21`의 mockLeg 패턴 사용):

```typescript
import { executeReclaim } from '../../src/services/reclaim/executor';
import type { ExchangeLeg } from '../../src/services/exchange-leg';

function mockLeg(over: Partial<Record<keyof ExchangeLeg, any>>): ExchangeLeg {
  const ni = () => { throw new Error('not impl'); };
  return {
    sellIoc: over.sellIoc ?? (async () => null),
    buyIoc: over.buyIoc ?? (async () => null),
    ...(over.sellLimitIoc ? { sellLimitIoc: over.sellLimitIoc } : {}),
    ...(over.buyLimitIoc ? { buyLimitIoc: over.buyLimitIoc } : {}),
    buyGtc: ni, placeMakerBid: ni, pollOrder: ni, placeMakerAsk: ni, cancelOrder: ni,
  } as ExchangeLeg;
}

describe('executeReclaim', () => {
  it('양쪽 완전체결 → filled, netKrw = 매도gross - 매수gross - 수수료', async () => {
    const bithumbLeg = mockLeg({ sellLimitIoc: async () => ({ filledQty: 10, grossKrw: 10100, feeKrw: 4 }) });
    const upbitLeg = mockLeg({ buyLimitIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }) });
    const r = await executeReclaim({ bithumbLeg, upbitLeg, symbol: 'XRP', qty: 10, bithumbBid: 1010, upbitAsk: 1000 });
    expect(r.status).toBe('filled');
    expect(r.netKrw).toBeCloseTo(10100 - 10000 - 9, 6);
  });

  it('한쪽만 체결 → partial (flatten 안 함, 남김)', async () => {
    const bithumbLeg = mockLeg({ sellLimitIoc: async () => ({ filledQty: 10, grossKrw: 10100, feeKrw: 4 }) });
    const upbitLeg = mockLeg({ buyLimitIoc: async () => null });   // 업비트 미체결
    const r = await executeReclaim({ bithumbLeg, upbitLeg, symbol: 'XRP', qty: 10, bithumbBid: 1010, upbitAsk: 1000 });
    expect(r.status).toBe('partial');
    expect(r.sellFilled).toBe(10);
    expect(r.buyFilled).toBe(0);
  });

  it('둘 다 미체결 → failed', async () => {
    const r = await executeReclaim({ bithumbLeg: mockLeg({}), upbitLeg: mockLeg({}), symbol: 'X', qty: 1, bithumbBid: 1, upbitAsk: 1 });
    expect(r.status).toBe('failed');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest reclaim-executor -v` → FAIL (module not found)

- [ ] **Step 3: 구현**

`src/services/reclaim/executor.ts`:

```typescript
import type { ExchangeLeg } from '../exchange-leg';

export interface ReclaimExecInput {
  bithumbLeg: ExchangeLeg;
  upbitLeg: ExchangeLeg;
  symbol: string;
  qty: number;
  bithumbBid: number;   // 빗썸 매도 지정가(최우선 매수호가)
  upbitAsk: number;     // 업비트 매수 지정가(최우선 매도호가)
}

export interface ReclaimExecResult {
  sellFilled: number;
  buyFilled: number;
  sellGrossKrw: number;
  buyGrossKrw: number;
  feeKrw: number;
  netKrw: number;
  status: 'filled' | 'partial' | 'failed';
  note: string;
}

const EPS = 1e-8;

/**
 * 빗썸 매도 + 업비트 매수를 지정가 IOC로 동시 발주. 최우선호가 지정가라 슬리피지 0.
 * 부분체결(한쪽만/부분)이어도 flatten하지 않고 체결된 만큼만 기록(남기기).
 */
export async function executeReclaim(i: ReclaimExecInput): Promise<ReclaimExecResult> {
  const sellFire = i.bithumbLeg.sellLimitIoc
    ? i.bithumbLeg.sellLimitIoc(i.symbol, i.qty, i.bithumbBid)
    : i.bithumbLeg.sellIoc(i.symbol, i.qty, i.bithumbBid);
  const buyFire = i.upbitLeg.buyLimitIoc
    ? i.upbitLeg.buyLimitIoc(i.symbol, i.qty, i.upbitAsk)
    : i.upbitLeg.buyIoc(i.symbol, i.qty, i.upbitAsk, undefined);

  const [s, b] = await Promise.allSettled([sellFire, buyFire]);
  const sell = s.status === 'fulfilled' && s.value ? s.value : { filledQty: 0, grossKrw: 0, feeKrw: 0 };
  const buy = b.status === 'fulfilled' && b.value ? b.value : { filledQty: 0, grossKrw: 0, feeKrw: 0 };

  const feeKrw = sell.feeKrw + buy.feeKrw;
  const netKrw = sell.grossKrw - buy.grossKrw - feeKrw;
  const both = sell.filledQty > EPS && buy.filledQty > EPS;
  const balanced = Math.abs(sell.filledQty - buy.filledQty) < EPS;
  const status: ReclaimExecResult['status'] =
    both && balanced ? 'filled'
    : (sell.filledQty > EPS || buy.filledQty > EPS) ? 'partial'
    : 'failed';

  return {
    sellFilled: sell.filledQty, buyFilled: buy.filledQty,
    sellGrossKrw: sell.grossKrw, buyGrossKrw: buy.grossKrw,
    feeKrw, netKrw, status,
    note: `sell ${sell.filledQty}/buy ${buy.filledQty}`,
  };
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest reclaim-executor -v` → PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/reclaim/executor.ts __tests__/services/reclaim-executor.test.ts
git commit -m "feat: 되돌림 집행기 (지정가 IOC 동시, no-flatten)"
```

---

## Task 6: 대상 선별기

**Files:**
- Create: `src/services/reclaim/target-selector.ts`
- Test: `__tests__/services/reclaim-target.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`__tests__/services/reclaim-target.test.ts`:

```typescript
import { selectReclaimTargets } from '../../src/services/reclaim/target-selector';

describe('selectReclaimTargets', () => {
  const holdings = { BORA: 1000, HBAR: 500, FOO: 10 }; // 빗썸 보유
  const upbitMarkets = new Set(['BORA', 'HBAR']);       // 업비트 공통상장 (FOO 미상장)
  const withdrawFeePct = { BORA: 1.0, HBAR: 0.001 };    // 출금수수료율(%)

  it('업비트 공통상장 + 출금수수료율 > 임계인 코인만', () => {
    // 임계 0.3%: BORA(1.0%) 통과, HBAR(0.001%) 제외(전송이 쌈), FOO 제외(업비트 미상장)
    const r = selectReclaimTargets({ holdings, upbitMarkets, withdrawFeePct, thresholdPct: 0.3 });
    expect(r).toEqual(['BORA']);
  });

  it('출금수수료율 미확인(undefined) 코인은 보수적으로 포함(전송 대안 불명 → 되돌림 후보)', () => {
    const r = selectReclaimTargets({ holdings: { BORA: 1 }, upbitMarkets: new Set(['BORA']), withdrawFeePct: {}, thresholdPct: 0.3 });
    expect(r).toEqual(['BORA']);
  });

  it('보유량 0은 제외', () => {
    const r = selectReclaimTargets({ holdings: { BORA: 0 }, upbitMarkets: new Set(['BORA']), withdrawFeePct: { BORA: 1 }, thresholdPct: 0.3 });
    expect(r).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest reclaim-target -v` → FAIL

- [ ] **Step 3: 구현**

`src/services/reclaim/target-selector.ts`:

```typescript
export interface SelectTargetsInput {
  holdings: Record<string, number>;       // 빗썸 보유 {symbol: qty}
  upbitMarkets: Set<string>;              // 업비트 KRW 공통상장 심볼
  withdrawFeePct: Record<string, number>; // 출금수수료율(%) {symbol: pct}. 미확인은 키 없음
  thresholdPct: number;                   // 이 값 초과(전송 비쌈)만 대상
}

/**
 * 되돌림 대상 = 빗썸 보유량>0 × 업비트 공통상장 × (출금수수료율 > 임계 또는 미확인).
 * 전송이 싼(임계 이하) 코인은 전송이 답이므로 제외.
 */
export function selectReclaimTargets(i: SelectTargetsInput): string[] {
  const out: string[] = [];
  for (const [sym, qty] of Object.entries(i.holdings)) {
    if (!(qty > 0)) continue;
    if (!i.upbitMarkets.has(sym)) continue;
    const fee = i.withdrawFeePct[sym];
    if (fee != null && fee <= i.thresholdPct) continue; // 전송이 싸면 제외
    out.push(sym);
  }
  return out;
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest reclaim-target -v` → PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/reclaim/target-selector.ts __tests__/services/reclaim-target.test.ts
git commit -m "feat: 되돌림 대상 선별기"
```

---

## Task 7: 서비스 오케스트레이션

**Files:**
- Create: `src/services/reclaim/reclaim.service.ts`
- Modify: `__mocks__/database.ts` (mock 추가)

> 이 서비스는 실거래 credential·외부 API에 의존하므로 순수함수(Task 2-6)로 로직을 이미 검증했다. 여기서는 그것들을 조립하고, 단위테스트는 순수함수로 충분하므로 서비스 자체는 통합 배선만 한다(별도 테스트는 scanOnce의 게이트 단락만 mock으로 확인).

- [ ] **Step 1: mock DB에 테이블 추가**

`__mocks__/database.ts`의 `prisma` 객체에 추가:

```typescript
  arbReclaimConfig: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
  arbReclaimTrade: {
    create: jest.fn(),
    findMany: jest.fn(),
    aggregate: jest.fn(),
  },
```

- [ ] **Step 2: 서비스 구현**

`src/services/reclaim/reclaim.service.ts`:

```typescript
import mainPrisma from '../../config/database';
import { config } from '../../config/env';
import { decrypt } from '../../utils/encryption';
import { UpbitClient } from '../../services/exchange/upbit-client';
import { UpbitService } from '../upbit.service';
import { BithumbClient } from '../exchange/bithumb-client';
import { UpbitLeg, BithumbLeg, ExchangeLeg } from '../exchange-leg';
import { fetchOrderbookDepth, fetchUpbitDepthBatch } from '../inventory-arb/orderbook-depth';
import { getKrwHoldings } from '../inventory-arb.service'; // 재사용: (userId) => {upbit,bithumb}
import { selectReclaimTargets } from './target-selector';
import { shouldReclaim, RECLAIM_FEE_BPS } from './net';
import { computeReclaimQty } from './sizing';
import { checkReclaimGate } from './gate';
import { executeReclaim } from './executor';

const UPBIT_BUY_FEE_BPS = 5;
const MIN_ORDER_KRW = 5000;
const KST = 9 * 3600 * 1000;

function kstDayStart(): Date {
  const n = new Date(Date.now() + KST); n.setUTCHours(0, 0, 0, 0);
  return new Date(n.getTime() - KST);
}

class ReclaimService {
  private upbitLegs = new Map<number, ExchangeLeg>();
  private bithumbLegs = new Map<number, ExchangeLeg>();
  private upbitMarketsCache: { at: number; set: Set<string> } | null = null;

  private async adminUserId(): Promise<number | null> {
    const u = await (mainPrisma as any).user.findFirst({ where: { email: config.adminEmail }, select: { id: true } });
    return u?.id ?? null;
  }

  private async getLegs(userId: number): Promise<{ upbit: ExchangeLeg; bithumb: ExchangeLeg }> {
    if (!this.upbitLegs.has(userId)) {
      const c = await (mainPrisma as any).credential.findFirst({ where: { userId, exchange: 'upbit' } });
      if (!c) throw new Error('upbit cred 없음');
      const creds = { accessKey: decrypt(c.apiKey), secretKey: decrypt(c.secretKey) };
      this.upbitLegs.set(userId, new UpbitLeg(new UpbitClient(creds), new UpbitService(creds)));
    }
    if (!this.bithumbLegs.has(userId)) {
      const c = await (mainPrisma as any).credential.findFirst({ where: { userId, exchange: 'bithumb' } });
      if (!c) throw new Error('bithumb cred 없음');
      this.bithumbLegs.set(userId, new BithumbLeg(new BithumbClient({ accessKey: decrypt(c.apiKey), secretKey: decrypt(c.secretKey) })));
    }
    return { upbit: this.upbitLegs.get(userId)!, bithumb: this.bithumbLegs.get(userId)! };
  }

  private async upbitMarkets(): Promise<Set<string>> {
    if (this.upbitMarketsCache && Date.now() - this.upbitMarketsCache.at < 3600_000) return this.upbitMarketsCache.set;
    const r = await fetch('https://api.upbit.com/v1/market/all');
    const arr = await r.json();
    const set = new Set<string>((arr as any[]).filter(m => String(m.market).startsWith('KRW-')).map(m => String(m.market).slice(4)));
    this.upbitMarketsCache = { at: Date.now(), set };
    return set;
  }

  async getConfig(userId: number) {
    return (mainPrisma as any).arbReclaimConfig.upsert({ where: { userId }, update: {}, create: { userId } });
  }

  async putConfig(userId: number, data: Record<string, any>) {
    return (mainPrisma as any).arbReclaimConfig.upsert({ where: { userId }, update: data, create: { userId, ...data } });
  }

  private async todayUsage(userId: number) {
    const rows = await (mainPrisma as any).arbReclaimTrade.findMany({
      where: { userId, createdAt: { gte: kstDayStart() }, status: { in: ['filled', 'partial'] } },
      select: { qty: true, upbitBuyPrice: true, sellFilled: true, buyFilled: true },
    });
    const count = rows.length;
    const notionalKrw = rows.reduce((s: number, r: any) => s + r.qty * r.upbitBuyPrice, 0);
    const imbalanceKrw = rows.reduce((s: number, r: any) => s + Math.abs(r.sellFilled - r.buyFilled) * r.upbitBuyPrice, 0);
    return { count, notionalKrw, imbalanceKrw };
  }

  /** 에이전트가 주기 호출. 게이트 통과 시 대상 스캔 → 순차익≥임계 → 사이징 → 집행 → 기록. */
  async scanOnce(): Promise<void> {
    const userId = await this.adminUserId();
    if (userId == null) return;
    const cfg = await this.getConfig(userId);
    const usage = await this.todayUsage(userId);
    const gate = checkReclaimGate({
      enabled: cfg.enabled, killSwitch: cfg.killSwitch,
      todayCount: usage.count, dailyMaxCount: cfg.dailyMaxCount,
      todayNotionalKrw: usage.notionalKrw, dailyMaxKrw: cfg.dailyMaxKrw,
      imbalanceKrw: usage.imbalanceKrw, imbalanceCapKrw: cfg.imbalanceCapKrw,
    });
    if (!gate.ok) { if (gate.reason === 'imbalanceCap') console.warn('[Reclaim] 불균형 한도 — 스캔 정지'); return; }

    const holdings = await getKrwHoldings(userId);
    const markets = await this.upbitMarkets();
    // 대상 선별 (출금수수료율은 별도 캐시 로직 — 초기엔 빈 객체로 두어 미확인=포함, 후속 캐시 채움)
    const targets = selectReclaimTargets({ holdings: holdings.bithumb, upbitMarkets: markets, withdrawFeePct: {}, thresholdPct: cfg.withdrawFeePctThreshold });
    if (targets.length === 0) return;

    const legs = await this.getLegs(userId);
    const upbitDepth = await fetchUpbitDepthBatch(targets);
    for (const sym of targets) {
      try {
        const up = upbitDepth.get(sym);
        const bt = await fetchOrderbookDepth('bithumb', sym);
        if (!up || !bt) continue;
        if (!shouldReclaim(bt.bid, up.ask, cfg.minNetPct, RECLAIM_FEE_BPS)) continue;
        const qty = computeReclaimQty({
          bithumbBidQty: bt.bidQty, upbitAskQty: up.askQty,
          bithumbHolding: holdings.bithumb[sym] ?? 0, upbitKrw: holdings.upbit['KRW'] ?? 0,
          upbitAsk: up.ask, maxOrderKrw: cfg.maxOrderKrw, feeBps: UPBIT_BUY_FEE_BPS,
        });
        if (qty * up.ask < MIN_ORDER_KRW) continue;
        const r = await executeReclaim({ bithumbLeg: legs.bithumb, upbitLeg: legs.upbit, symbol: sym, qty, bithumbBid: bt.bid, upbitAsk: up.ask });
        await (mainPrisma as any).arbReclaimTrade.create({ data: {
          userId, symbol: sym, qty, bithumbSellPrice: bt.bid, upbitBuyPrice: up.ask,
          sellFilled: r.sellFilled, buyFilled: r.buyFilled,
          grossKrw: Math.round(r.sellGrossKrw - r.buyGrossKrw), feeKrw: Math.round(r.feeKrw), netKrw: Math.round(r.netKrw),
          status: r.status, note: r.note,
        }});
        console.log(`[Reclaim] ${sym} ${r.status} net ${Math.round(r.netKrw)} (${r.note})`);
      } catch (e: any) { console.error(`[Reclaim] ${sym} 실패:`, e?.message); }
    }
  }

  async getStatus(userId: number) {
    const cfg = await this.getConfig(userId);
    const usage = await this.todayUsage(userId);
    const recent = await (mainPrisma as any).arbReclaimTrade.findMany({ where: { userId }, orderBy: { id: 'desc' }, take: 10 });
    return { config: cfg, today: usage, recentTrades: recent };
  }
}

export const reclaimService = new ReclaimService();
```

> 참고: `getKrwHoldings`가 현재 `inventory-arb.service`의 인스턴스 메서드라면, export된 함수 형태가 아닐 수 있다. 구현 시 `inventoryArbService.getKrwHoldings(userId)` 형태로 호출하도록 import를 맞출 것(Task 시작 시 확인).

- [ ] **Step 3: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 0 errors. (UpbitLeg/BithumbLeg 생성자 시그니처가 다르면 exchange-leg.ts를 확인해 맞춘다.)

- [ ] **Step 4: Commit**

```bash
git add src/services/reclaim/reclaim.service.ts __mocks__/database.ts
git commit -m "feat: 되돌림 서비스 오케스트레이션(scanOnce)"
```

---

## Task 8: 컨트롤러 + 라우트

**Files:**
- Create: `src/controllers/reclaim.controller.ts`
- Create: `src/routes/reclaim.ts`
- Modify: `src/routes/index.ts`

- [ ] **Step 1: 컨트롤러**

`src/controllers/reclaim.controller.ts`:

```typescript
import { Response, NextFunction } from 'express';
import { successResponse, errorResponse } from '../utils/response';
import { AuthRequest } from '../types';
import { reclaimService } from '../services/reclaim/reclaim.service';

export async function getReclaimStatus(req: AuthRequest, res: Response, next: NextFunction) {
  try { return successResponse(res, await reclaimService.getStatus(req.userId!)); }
  catch (e) { next(e); }
}

export async function putReclaimConfig(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const allowed = ['enabled', 'minNetPct', 'maxOrderKrw', 'dailyMaxCount', 'dailyMaxKrw', 'withdrawFeePctThreshold', 'imbalanceCapKrw', 'killSwitch'] as const;
    const data: Record<string, any> = {};
    for (const k of allowed) if (k in req.body) data[k] = req.body[k];
    if (data.maxOrderKrw != null && (typeof data.maxOrderKrw !== 'number' || data.maxOrderKrw <= 0 || data.maxOrderKrw > 1_000_000))
      return errorResponse(res, 'VALIDATION_ERROR', 'maxOrderKrw는 0~100만원', 400);
    if (data.minNetPct != null && (typeof data.minNetPct !== 'number' || data.minNetPct < 0))
      return errorResponse(res, 'VALIDATION_ERROR', 'minNetPct는 0 이상', 400);
    if (data.dailyMaxCount != null && (typeof data.dailyMaxCount !== 'number' || !Number.isInteger(data.dailyMaxCount) || data.dailyMaxCount < 0 || data.dailyMaxCount > 100_000))
      return errorResponse(res, 'VALIDATION_ERROR', 'dailyMaxCount는 0~100000 정수', 400);
    const cfg = await reclaimService.putConfig(req.userId!, data);
    return successResponse(res, cfg);
  } catch (e) { next(e); }
}
```

- [ ] **Step 2: 라우트**

`src/routes/reclaim.ts`:

```typescript
import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import { requireAdmin } from '../middlewares/requireAdmin';
import { getReclaimStatus, putReclaimConfig } from '../controllers/reclaim.controller';

const router = Router();
router.use(authenticate);
router.use(requireAdmin);

router.get('/status', getReclaimStatus);
router.put('/config', putReclaimConfig);

export default router;
```

- [ ] **Step 3: routes/index.ts 마운트**

`src/routes/index.ts`에 추가 (기존 `inventory-arb` 마운트 근처):

```typescript
import reclaimRoutes from './reclaim';
// ...
router.use('/reclaim', reclaimRoutes);
```

- [ ] **Step 4: 타입 체크**

Run: `npx tsc --noEmit` → 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/controllers/reclaim.controller.ts src/routes/reclaim.ts src/routes/index.ts
git commit -m "feat: 되돌림 config/status API"
```

---

## Task 9: 에이전트 등록

**Files:**
- Create: `src/agents/reclaim-agent.ts`
- Modify: `src/agents/index.ts`, `src/index.ts`

- [ ] **Step 1: 에이전트**

`src/agents/reclaim-agent.ts` (inventory-arb-agent.ts:10-34 패턴):

```typescript
import { BaseAgent } from './base-agent';
import { reclaimService } from '../services/reclaim/reclaim.service';

export class ReclaimAgent extends BaseAgent {
  constructor() {
    super({
      id: 'reclaim',
      name: 'ReclaimAgent',
      description: '재고 되돌림 리컨실러 (빗썸→업비트 재장전)',
      cycleIntervalMs: 30000, // 30초
    });
  }
  protected async onStart(): Promise<void> { console.log('[ReclaimAgent] 시작'); }
  protected async onStop(): Promise<void> { console.log('[ReclaimAgent] 정지'); }
  protected async onCycle(): Promise<void> { await reclaimService.scanOnce(); }
}
```

- [ ] **Step 2: export**

`src/agents/index.ts`에 추가:

```typescript
export { ReclaimAgent } from './reclaim-agent';
```

- [ ] **Step 3: 등록**

`src/index.ts`의 `agentManager.register(new UsdtInventoryArbAgent());` 다음 줄에 추가 (import도 상단에):

```typescript
import { ReclaimAgent } from './agents/reclaim-agent';
// ...
agentManager.register(new ReclaimAgent());
```

- [ ] **Step 4: 빌드 확인**

Run: `npm run build`
Expected: 컴파일 성공 (0 errors)

- [ ] **Step 5: 전체 테스트**

Run: `npx jest reclaim`
Expected: Task 2-6의 모든 순수함수 테스트 PASS

- [ ] **Step 6: Commit**

```bash
git add src/agents/reclaim-agent.ts src/agents/index.ts src/index.ts
git commit -m "feat: ReclaimAgent 30초 주기 등록"
```

---

## Self-Review 메모 (계획 작성자 체크)

- **스펙 커버리지**: 대상선별(T6)·사이징(T3)·순차익≥0(T2)·no-flatten(T5)·안전게이트/불균형(T4,T7)·config/API(T8)·주기실행(T9)·모델(T1) 모두 태스크 존재. 프론트 UI는 범위 외(명시).
- **수수료 caveat**: `RECLAIM_FEE_BPS=9`를 net.ts 상단 주석으로 명시. 배포 전 실제 빗썸 taker 등급 확인 필요(스펙 §11 CRITICAL).
- **미확인 시그니처**: `UpbitLeg`/`BithumbLeg` 생성자, `getKrwHoldings` export 형태는 Task 7 시작 시 exchange-leg.ts·inventory-arb.service.ts에서 확인해 맞출 것(계획에 주석으로 표시). 이 둘은 재사용 대상이라 실제 코드 확인 후 import 조정.
- **배포**: production 배포는 `migrate deploy` 포함. 기본 enabled=false라 배포해도 실행 안 됨(canary 토글 전까지 안전).
