# Canary Stage 3 사전 정비 (PR H) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Canary Stage 2 학습 4가지(수익성 gating, bidOffsetKrw UI, lastResumeAt T_start, 잔고 정합 검증)를 한 라운드에 반영해 Canary Stage 3 가동 준비 완료

**Architecture:** 스테이블 Prisma 스키마에 `minSpreadKrw` + `lastResumeAt` 컬럼 추가, 백엔드에 순수 함수 spread-gate + reconciliation 서비스 신규, agent 에서 게이팅 결정해 live executor 의 `preCheckOk` 에 합산, 프론트엔드는 종합 Edit Dialog + 검증 결과 Dialog 추가.

**Tech Stack:** TypeScript, Express 5, Prisma (MySQL, stablecoin DB 분리), Jest, Next.js 16, React 19, shadcn/ui

**Spec:** `v0-grid-tranasction-backend/docs/superpowers/specs/2026-04-30-canary-stage-3-readiness-design.md`

**Branch:** 백엔드/프론트 각각 `feature/pr-h-canary-stage-3-readiness`

---

## Task 1: 스테이블 스키마에 신규 컬럼 추가

**Files:**
- Modify: `v0-grid-tranasction-backend/prisma-stablecoin/schema.prisma:136-162`

- [ ] **Step 1: 스키마 파일에 두 컬럼 추가**

`MakerTakerSimBot` model 의 `takerFeeBps` 필드 다음 줄에 추가:

```prisma
  makerFeeBps Int @default(5)
  takerFeeBps Int @default(5)

  // PR H — Canary Stage 3 사전 정비
  minSpreadKrw Int       @default(12)  // (bestAsk - bestBid) >= 이 값일 때만 placement
  lastResumeAt DateTime?               // enabled false→true 전환 시각 (canary T_start)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
```

- [ ] **Step 2: 마이그레이션 생성 (--create-only)**

Run: `npm run prisma:migrate:stablecoin -- --name add_canary_stage_3_fields --create-only`
Expected: `prisma-stablecoin/migrations/{timestamp}_add_canary_stage_3_fields/migration.sql` 생성

- [ ] **Step 3: 마이그레이션 SQL tail 검사 (CLI garbage 방어)**

Run: `head -20 prisma-stablecoin/migrations/*_add_canary_stage_3_fields/migration.sql && echo "---" && tail -5 prisma-stablecoin/migrations/*_add_canary_stage_3_fields/migration.sql`

Expected: ALTER TABLE `maker_taker_sim_bots` ADD COLUMN `minSpreadKrw` INT NOT NULL DEFAULT 12 + ADD COLUMN `lastResumeAt` DATETIME(3) NULL. 박스 문자나 한글 garbage 없음.

문제 발견 시 `migration.sql` 직접 수정 후 다음 step.

- [ ] **Step 4: 마이그레이션 apply + Prisma client 재생성**

Run: `npm run prisma:migrate:stablecoin --` (no flags)
Run: `npm run prisma:generate`
Expected: stablecoin DB 에 컬럼 추가됨, `node_modules/.prisma/client-stablecoin/` 재생성됨

- [ ] **Step 5: 커밋**

```bash
git checkout -b feature/pr-h-canary-stage-3-readiness
git add prisma-stablecoin/schema.prisma prisma-stablecoin/migrations/ docs/superpowers/specs/2026-04-30-canary-stage-3-readiness-design.md docs/superpowers/plans/2026-04-30-canary-stage-3-readiness.md
git commit -m "feat: PR H Phase 1 — minSpreadKrw + lastResumeAt 컬럼 추가"
```

---

## Task 2: spread-gate 순수 함수 (TDD)

**Files:**
- Create: `v0-grid-tranasction-backend/src/services/maker-taker-spread-gate.ts`
- Create: `v0-grid-tranasction-backend/__tests__/services/maker-taker-spread-gate.test.ts`

- [ ] **Step 1: 테스트 작성 (RED)**

Create `__tests__/services/maker-taker-spread-gate.test.ts`:

```typescript
import { isSpreadProfitable } from '../../src/services/maker-taker-spread-gate';
import type { OrderbookTop } from '../../src/services/upbit-price-manager';

const mkBook = (bid: number, ask: number): OrderbookTop => ({
  market: 'KRW-USDS',
  bid: { price: bid, size: 1000 },
  ask: { price: ask, size: 1000 },
  timestamp: 0,
});

describe('isSpreadProfitable', () => {
  it('spread < minSpreadKrw → ok=false, reason 포함', () => {
    const r = isSpreadProfitable(mkBook(1490, 1495), 12);
    expect(r.ok).toBe(false);
    expect(r.spreadKrw).toBe(5);
    expect(r.reason).toContain('spread');
  });

  it('spread === minSpreadKrw → ok=true (경계값 포함)', () => {
    const r = isSpreadProfitable(mkBook(1490, 1502), 12);
    expect(r.ok).toBe(true);
    expect(r.spreadKrw).toBe(12);
  });

  it('spread > minSpreadKrw → ok=true', () => {
    const r = isSpreadProfitable(mkBook(1490, 1510), 12);
    expect(r.ok).toBe(true);
    expect(r.spreadKrw).toBe(20);
  });

  it('minSpreadKrw === 0 → 항상 ok=true (게이팅 비활성)', () => {
    const r = isSpreadProfitable(mkBook(1490, 1490), 0);
    expect(r.ok).toBe(true);
    expect(r.spreadKrw).toBe(0);
  });

  it('비정상: ask < bid 입력 → spread 음수, ok=false', () => {
    const r = isSpreadProfitable(mkBook(1500, 1490), 12);
    expect(r.ok).toBe(false);
    expect(r.spreadKrw).toBe(-10);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest __tests__/services/maker-taker-spread-gate.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/maker-taker-spread-gate'`

- [ ] **Step 3: 구현 (GREEN)**

Create `src/services/maker-taker-spread-gate.ts`:

```typescript
/**
 * 수익성 gating — makerCoin 호가의 (bestAsk - bestBid) 가 임계값 이상일 때만 maker 주문 허용.
 *
 * 근거: Canary Stage 2 (2026-04-30) 종료 시 spread=1 KRW (~6.7bps) < fees(10bps) 로 항상 손실.
 * 메모리 `project_canary_stage_2_complete_2026_04_30.md` § "수익성 미확보" 참조.
 *
 * 정책 결정은 호출자(agent)가 함 — live executor 는 spec § 2 정합 순수 함수 유지.
 */
import type { OrderbookTop } from './upbit-price-manager';

export interface SpreadGateResult {
  ok: boolean;
  spreadKrw: number;
  reason?: string;
}

export function isSpreadProfitable(
  makerBook: OrderbookTop,
  minSpreadKrw: number,
): SpreadGateResult {
  const spreadKrw = makerBook.ask.price - makerBook.bid.price;

  if (minSpreadKrw === 0) {
    return { ok: true, spreadKrw };
  }

  if (spreadKrw < minSpreadKrw) {
    return {
      ok: false,
      spreadKrw,
      reason: `spread ${spreadKrw} KRW < minSpreadKrw ${minSpreadKrw} (수익성 미달)`,
    };
  }

  return { ok: true, spreadKrw };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest __tests__/services/maker-taker-spread-gate.test.ts`
Expected: PASS — 5/5

- [ ] **Step 5: 커밋**

```bash
git add src/services/maker-taker-spread-gate.ts __tests__/services/maker-taker-spread-gate.test.ts
git commit -m "feat: PR H — isSpreadProfitable 순수 함수 (수익성 gating)"
```

---

## Task 3: live executor 에 minSpreadKrw 필드 추가

**Files:**
- Modify: `v0-grid-tranasction-backend/src/services/maker-taker-live-executor.ts:59-68`
- Modify: `v0-grid-tranasction-backend/__tests__/services/maker-taker-live-executor.test.ts:29-38`

게이팅 자체는 호출자(agent)가 결정해 `preCheckOk` 에 합산하므로 live-executor 자체 로직은 변경 없음. `LiveBotInput` 타입에 필드만 추가하고 기존 테스트의 baseBot 도 업데이트.

- [ ] **Step 1: LiveBotInput 타입에 필드 추가**

Modify `src/services/maker-taker-live-executor.ts:59-68`:

```typescript
/** 봇 입력 (DB 모델의 일부) */
export type LiveBotInput = {
  id: number;
  userId: number;
  makerCoin: string;
  takerCoin: string;
  bidOffsetKrw: number;
  quantity: number;
  maxPendingMs: number;
  killSwitch: boolean;
  minSpreadKrw: number; // NEW: PR H — agent 가 spread gate 결정 시 사용 (executor 자체 미사용)
};
```

- [ ] **Step 2: 기존 live-executor 테스트의 baseBot 업데이트**

Modify `__tests__/services/maker-taker-live-executor.test.ts:29-38`:

```typescript
const baseBot: LiveBotInput = {
  id: 1,
  userId: 2,
  makerCoin: 'USDT',
  takerCoin: 'USDC',
  bidOffsetKrw: -1,
  quantity: 5,
  maxPendingMs: 600_000,
  killSwitch: false,
  minSpreadKrw: 0, // 기존 테스트 의미 유지 — executor 자체는 이 필드 미사용
};
```

- [ ] **Step 3: 테스트 통과 확인**

Run: `npx jest __tests__/services/maker-taker-live-executor.test.ts`
Expected: PASS — 기존 10/10 (executor 동작은 변경 없음)

- [ ] **Step 4: 커밋**

```bash
git add src/services/maker-taker-live-executor.ts __tests__/services/maker-taker-live-executor.test.ts
git commit -m "feat: PR H — LiveBotInput 에 minSpreadKrw 필드 추가"
```

---

## Task 4: agent 에 spread gate 통합

**Files:**
- Modify: `v0-grid-tranasction-backend/src/agents/maker-taker-simulator-agent.ts`

- [ ] **Step 1: import 추가**

Modify `src/agents/maker-taker-simulator-agent.ts:24-25` (import 블록 끝에 추가):

```typescript
import { shouldAutoPauseForMinBalance } from '../services/maker-taker-min-balance-guard';
import { isSpreadProfitable } from '../services/maker-taker-spread-gate'; // NEW
import { UpbitService } from '../services/upbit.service';
```

- [ ] **Step 2: sim 분기 (live=false) 의 PENDING null 케이스에 게이팅**

Modify `src/agents/maker-taker-simulator-agent.ts:130-145`:

```typescript
    if (!pending) {
      // PR H — 수익성 게이팅 (live/sim 정합성)
      const gate = isSpreadProfitable(makerBook, bot.minSpreadKrw);
      if (!gate.ok) {
        // row 미생성 — 통계 단절 리스크는 spec §7 R1 참조
        return;
      }

      // 새 가상 주문 생성: makerCoin의 현재 best bid + bidOffsetKrw
      const makerOrderPrice = makerBook.bid.price + bot.bidOffsetKrw;
      await prisma.makerTakerSimTrade.create({
        data: {
          botId: bot.id,
          makerCoin: bot.makerCoin,
          takerCoin: bot.takerCoin,
          makerOrderPrice,
          quantity: bot.quantity,
          status: 'PENDING',
          notes: `생성: makerBid=${makerBook.bid.price}, offset=${bot.bidOffsetKrw}, spread=${gate.spreadKrw}`,
        },
      });
      return;
    }
```

- [ ] **Step 3: live 분기 (handleLiveBot) 의 PENDING null 케이스에 게이팅 + minSpreadKrw 전달**

Modify `src/agents/maker-taker-simulator-agent.ts:285-322` (precheck 다음 + liveBot 구성):

`(b) 사전 잔고 체크 — maker placement 직전` 블록 다음에 추가:

```typescript
      if (!precheck.ok) {
        console.log(
          `[MakerTakerSimulatorAgent] bot ${bot.id} pre-check 실패: ${precheck.reason}`,
        );
        preCheckOk = false;
      }

      // (c) PR H — 수익성 게이팅
      if (preCheckOk) {
        const gate = isSpreadProfitable(makerBook, bot.minSpreadKrw);
        if (!gate.ok) {
          console.log(
            `[MakerTakerSimulatorAgent] bot ${bot.id} spread gate: ${gate.reason}`,
          );
          preCheckOk = false;
        }
      }
    }
```

`liveBot` 구성에 minSpreadKrw 추가:

```typescript
    const liveBot: LiveBotInput = {
      id: bot.id,
      userId: bot.userId,
      makerCoin: bot.makerCoin,
      takerCoin: bot.takerCoin,
      bidOffsetKrw: bot.bidOffsetKrw,
      quantity: Number(bot.quantity),
      maxPendingMs: bot.maxPendingMs,
      killSwitch: bot.killSwitch,
      minSpreadKrw: bot.minSpreadKrw, // NEW PR H
    };
```

- [ ] **Step 4: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 5: 커밋**

```bash
git add src/agents/maker-taker-simulator-agent.ts
git commit -m "feat: PR H — agent 에 spread gate 통합 (sim+live)"
```

---

## Task 5: __mocks__/database.ts 에 makerTakerSimBot/Trade 메서드 추가

**Files:**
- Modify: `v0-grid-tranasction-backend/__mocks__/database.ts:30-48`

다음 task 들에서 mock 이 필요하므로 먼저 보강.

- [ ] **Step 1: stablecoinPrisma mock 확장**

Modify `__mocks__/database.ts:30-48`:

```typescript
const stablecoinPrisma = {
  stablecoinArbBot: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  stablecoinArbOpportunity: {
    count: jest.fn(),
    findMany: jest.fn(),
  },
  makerTakerSimBot: {
    findMany: jest.fn(),
    findFirst: jest.fn(),     // NEW
    findUnique: jest.fn(),    // NEW
    update: jest.fn(),        // NEW
    create: jest.fn(),
  },
  makerTakerSimTrade: {
    findMany: jest.fn(),
    findFirst: jest.fn(),     // NEW
    count: jest.fn(),         // NEW
    groupBy: jest.fn(),
    aggregate: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
};
```

- [ ] **Step 2: 기존 테스트 회귀 확인**

Run: `npx jest __tests__/services/`
Expected: 모든 기존 테스트 PASS (mock 추가는 호환성 유지)

- [ ] **Step 3: 커밋**

```bash
git add __mocks__/database.ts
git commit -m "test: PR H — stablecoinPrisma mock 에 신규 메서드 추가"
```

---

## Task 6: stablecoin-arb.service.patchMakerBot lastResumeAt 자동 갱신 (TDD)

**Files:**
- Modify: `v0-grid-tranasction-backend/src/services/stablecoin-arb.service.ts:316-330`
- Create: `v0-grid-tranasction-backend/__tests__/services/stablecoin-arb-service-patch-maker-bot.test.ts`

- [ ] **Step 1: 테스트 작성 (RED)**

Create `__tests__/services/stablecoin-arb-service-patch-maker-bot.test.ts`:

```typescript
import { stablecoinPrisma } from '../../__mocks__/database';
import { patchMakerBot } from '../../src/services/stablecoin-arb.service';

describe('patchMakerBot — lastResumeAt 자동 갱신', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const baseRow = {
    id: 1,
    userId: 100,
    enabled: false,
    killSwitch: false,
    live: false,
    makerCoin: 'USDS',
    takerCoin: 'USDT',
    bidOffsetKrw: 0,
    quantity: 10,
    minSpreadKrw: 12,
    lastResumeAt: null,
  };

  it('enabled false→true 전환 → lastResumeAt 자동 set', async () => {
    (stablecoinPrisma.makerTakerSimBot.findFirst as jest.Mock).mockResolvedValueOnce({
      ...baseRow,
      enabled: false,
    });
    (stablecoinPrisma.makerTakerSimBot.update as jest.Mock).mockResolvedValueOnce({
      ...baseRow,
      enabled: true,
      lastResumeAt: new Date('2026-04-30T12:00:00Z'),
    });

    await patchMakerBot(1, 100, { enabled: true });

    const updateCall = (stablecoinPrisma.makerTakerSimBot.update as jest.Mock).mock.calls[0][0];
    expect(updateCall.data.enabled).toBe(true);
    expect(updateCall.data.lastResumeAt).toBeInstanceOf(Date);
  });

  it('enabled true→true → lastResumeAt 미갱신', async () => {
    (stablecoinPrisma.makerTakerSimBot.findFirst as jest.Mock).mockResolvedValueOnce({
      ...baseRow,
      enabled: true,
    });
    (stablecoinPrisma.makerTakerSimBot.update as jest.Mock).mockResolvedValueOnce({
      ...baseRow,
      enabled: true,
    });

    await patchMakerBot(1, 100, { enabled: true });

    const updateCall = (stablecoinPrisma.makerTakerSimBot.update as jest.Mock).mock.calls[0][0];
    expect(updateCall.data.lastResumeAt).toBeUndefined();
  });

  it('enabled true→false → lastResumeAt 미갱신', async () => {
    (stablecoinPrisma.makerTakerSimBot.findFirst as jest.Mock).mockResolvedValueOnce({
      ...baseRow,
      enabled: true,
    });
    (stablecoinPrisma.makerTakerSimBot.update as jest.Mock).mockResolvedValueOnce({
      ...baseRow,
      enabled: false,
    });

    await patchMakerBot(1, 100, { enabled: false });

    const updateCall = (stablecoinPrisma.makerTakerSimBot.update as jest.Mock).mock.calls[0][0];
    expect(updateCall.data.lastResumeAt).toBeUndefined();
  });

  it('bidOffsetKrw 단독 변경 → lastResumeAt 미갱신', async () => {
    (stablecoinPrisma.makerTakerSimBot.findFirst as jest.Mock).mockResolvedValueOnce({
      ...baseRow,
      enabled: true,
    });
    (stablecoinPrisma.makerTakerSimBot.update as jest.Mock).mockResolvedValueOnce({
      ...baseRow,
      enabled: true,
      bidOffsetKrw: 5,
    });

    await patchMakerBot(1, 100, { bidOffsetKrw: 5 });

    const updateCall = (stablecoinPrisma.makerTakerSimBot.update as jest.Mock).mock.calls[0][0];
    expect(updateCall.data.lastResumeAt).toBeUndefined();
  });

  it('enabled false→true + bidOffsetKrw 동시 → lastResumeAt set', async () => {
    (stablecoinPrisma.makerTakerSimBot.findFirst as jest.Mock).mockResolvedValueOnce({
      ...baseRow,
      enabled: false,
    });
    (stablecoinPrisma.makerTakerSimBot.update as jest.Mock).mockResolvedValueOnce({
      ...baseRow,
      enabled: true,
      bidOffsetKrw: 5,
    });

    await patchMakerBot(1, 100, { enabled: true, bidOffsetKrw: 5 });

    const updateCall = (stablecoinPrisma.makerTakerSimBot.update as jest.Mock).mock.calls[0][0];
    expect(updateCall.data.lastResumeAt).toBeInstanceOf(Date);
  });

  it('ownership 미일치 → throw "Bot not found"', async () => {
    (stablecoinPrisma.makerTakerSimBot.findFirst as jest.Mock).mockResolvedValueOnce(null);

    await expect(patchMakerBot(1, 999, { enabled: true })).rejects.toThrow('Bot not found');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest __tests__/services/stablecoin-arb-service-patch-maker-bot.test.ts`
Expected: FAIL — 현재 patchMakerBot 은 updateMany 사용, findFirst 호출 안 함

- [ ] **Step 3: patchMakerBot 구현 변경**

Modify `src/services/stablecoin-arb.service.ts:316-330`:

```typescript
export async function patchMakerBot(id: number, userId: number, patch: PatchMakerBotInput) {
  // PR H — prev row 조회 (ownership 검증 + enabled 전환 감지)
  const existing = await prisma.makerTakerSimBot.findFirst({
    where: { id, userId },
  });
  if (!existing) {
    throw new Error('Bot not found or not owned by user');
  }

  // enabled false→true 전환 시에만 lastResumeAt 갱신 (canary T_start 의도)
  const finalPatch: typeof patch & { lastResumeAt?: Date } = { ...patch };
  if (existing.enabled === false && patch.enabled === true) {
    finalPatch.lastResumeAt = new Date();
  }

  const updated = await prisma.makerTakerSimBot.update({
    where: { id },
    data: finalPatch,
  });
  return updated;
}
```

또한 `PatchMakerBotInput` 타입(파일 위쪽에 정의돼 있음)에 `minSpreadKrw?: number` 와 `lastResumeAt?: Date` 추가:

```typescript
// PatchMakerBotInput interface 부분 — 기존 필드 유지하고 다음 두 줄 추가
  minSpreadKrw?: number;
  lastResumeAt?: Date;
```

(파일 내 기존 정의 위치 확인 후 동일 객체에 추가. 위치는 보통 `interface PatchMakerBotInput {` 블록.)

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest __tests__/services/stablecoin-arb-service-patch-maker-bot.test.ts`
Expected: PASS — 6/6

- [ ] **Step 5: 커밋**

```bash
git add src/services/stablecoin-arb.service.ts __tests__/services/stablecoin-arb-service-patch-maker-bot.test.ts
git commit -m "feat: PR H — patchMakerBot 에 lastResumeAt 자동 갱신"
```

---

## Task 7: asset-reconciliation 서비스 (TDD)

**Files:**
- Create: `v0-grid-tranasction-backend/src/services/maker-taker-asset-reconciliation.service.ts`
- Create: `v0-grid-tranasction-backend/__tests__/services/maker-taker-asset-reconciliation.service.test.ts`

- [ ] **Step 1: 테스트 작성 (RED)**

Create `__tests__/services/maker-taker-asset-reconciliation.service.test.ts`:

```typescript
import { stablecoinPrisma } from '../../__mocks__/database';
import { prisma } from '../../__mocks__/database';
import { reconcileBotAssets } from '../../src/services/maker-taker-asset-reconciliation.service';

// UpbitService mock — getOrdersByMarket 만 사용
jest.mock('../../src/services/upbit.service', () => ({
  UpbitService: jest.fn().mockImplementation(() => ({
    getOrdersByMarket: jest.fn(),
  })),
}));

import { UpbitService } from '../../src/services/upbit.service';

// encryption mock
jest.mock('../../src/utils/encryption', () => ({
  decrypt: jest.fn((s: string) => s),
}));

describe('reconcileBotAssets', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const baseBot = {
    id: 1,
    userId: 100,
    makerCoin: 'USDS',
    takerCoin: 'USDT',
    lastResumeAt: new Date('2026-04-30T00:00:00Z'),
    createdAt: new Date('2026-04-29T00:00:00Z'),
  };

  const baseCredential = {
    id: 1,
    userId: 100,
    exchange: 'upbit',
    apiKey: 'enc-access',
    secretKey: 'enc-secret',
  };

  it('filled 0건 + done 0건 → reconciled', async () => {
    (stablecoinPrisma.makerTakerSimBot.findUnique as jest.Mock).mockResolvedValueOnce(baseBot);
    (prisma.credential.findFirst as jest.Mock).mockResolvedValueOnce(baseCredential);
    (stablecoinPrisma.makerTakerSimTrade.findMany as jest.Mock).mockResolvedValueOnce([]);
    (stablecoinPrisma.makerTakerSimTrade.count as jest.Mock).mockResolvedValueOnce(0);
    const upbitInstance = (UpbitService as jest.Mock).mock.results[0]?.value;
    const getOrdersByMarketMock = jest.fn().mockResolvedValue([]);
    (UpbitService as jest.Mock).mockImplementation(() => ({
      getOrdersByMarket: getOrdersByMarketMock,
    }));

    const report = await reconcileBotAssets({ botId: 1, userId: 100 });

    expect(report.bot.filledTradesCount).toBe(0);
    expect(report.exchange.makerDoneOrderCount).toBe(0);
    expect(report.exchange.takerDoneOrderCount).toBe(0);
    expect(report.diff.makerCoinDiff).toBe('0');
    expect(report.isReconciled).toBe(true);
    expect(report.sinceSource).toBe('lastResumeAt');
  });

  it('filled 1건 (qty=10) + done 매칭 → reconciled', async () => {
    (stablecoinPrisma.makerTakerSimBot.findUnique as jest.Mock).mockResolvedValueOnce(baseBot);
    (prisma.credential.findFirst as jest.Mock).mockResolvedValueOnce(baseCredential);
    (stablecoinPrisma.makerTakerSimTrade.findMany as jest.Mock).mockResolvedValueOnce([
      { id: 1n, quantity: '10', makerFilledAt: new Date('2026-04-30T01:00:00Z') },
    ]);
    (stablecoinPrisma.makerTakerSimTrade.count as jest.Mock).mockResolvedValueOnce(0);

    (UpbitService as jest.Mock).mockImplementation(() => ({
      getOrdersByMarket: jest.fn().mockImplementation(async (market: string) => {
        if (market === 'KRW-USDS') {
          return [{ side: 'bid', state: 'done', executed_volume: '10', created_at: '2026-04-30T01:00:00Z' }];
        }
        if (market === 'KRW-USDT') {
          return [{ side: 'ask', state: 'done', executed_volume: '10', created_at: '2026-04-30T01:00:00Z' }];
        }
        return [];
      }),
    }));

    const report = await reconcileBotAssets({ botId: 1, userId: 100 });

    expect(report.diff.makerCoinDiff).toBe('0');
    expect(report.diff.takerCoinDiff).toBe('0');
    expect(report.isReconciled).toBe(true);
  });

  it('filled 1건 + done 0건 → 불일치, makerCoinDiff = 10', async () => {
    (stablecoinPrisma.makerTakerSimBot.findUnique as jest.Mock).mockResolvedValueOnce(baseBot);
    (prisma.credential.findFirst as jest.Mock).mockResolvedValueOnce(baseCredential);
    (stablecoinPrisma.makerTakerSimTrade.findMany as jest.Mock).mockResolvedValueOnce([
      { id: 1n, quantity: '10', makerFilledAt: new Date('2026-04-30T01:00:00Z') },
    ]);
    (stablecoinPrisma.makerTakerSimTrade.count as jest.Mock).mockResolvedValueOnce(0);

    (UpbitService as jest.Mock).mockImplementation(() => ({
      getOrdersByMarket: jest.fn().mockResolvedValue([]),
    }));

    const report = await reconcileBotAssets({ botId: 1, userId: 100 });

    expect(report.diff.makerCoinDiff).toBe('10');
    expect(report.isReconciled).toBe(false);
  });

  it('lastResumeAt=null → fallback createdAt, sinceSource=createdAt', async () => {
    (stablecoinPrisma.makerTakerSimBot.findUnique as jest.Mock).mockResolvedValueOnce({
      ...baseBot,
      lastResumeAt: null,
    });
    (prisma.credential.findFirst as jest.Mock).mockResolvedValueOnce(baseCredential);
    (stablecoinPrisma.makerTakerSimTrade.findMany as jest.Mock).mockResolvedValueOnce([]);
    (stablecoinPrisma.makerTakerSimTrade.count as jest.Mock).mockResolvedValueOnce(0);
    (UpbitService as jest.Mock).mockImplementation(() => ({
      getOrdersByMarket: jest.fn().mockResolvedValue([]),
    }));

    const report = await reconcileBotAssets({ botId: 1, userId: 100 });

    expect(report.sinceSource).toBe('createdAt');
    expect(report.sinceUtc).toBe(baseBot.createdAt.toISOString());
  });

  it('done order 가 lastResumeAt 이전이면 결과에서 제외', async () => {
    (stablecoinPrisma.makerTakerSimBot.findUnique as jest.Mock).mockResolvedValueOnce(baseBot);
    (prisma.credential.findFirst as jest.Mock).mockResolvedValueOnce(baseCredential);
    (stablecoinPrisma.makerTakerSimTrade.findMany as jest.Mock).mockResolvedValueOnce([]);
    (stablecoinPrisma.makerTakerSimTrade.count as jest.Mock).mockResolvedValueOnce(0);
    (UpbitService as jest.Mock).mockImplementation(() => ({
      getOrdersByMarket: jest.fn().mockImplementation(async (market: string) => {
        if (market === 'KRW-USDS') {
          return [
            // 이전 (제외)
            { side: 'bid', state: 'done', executed_volume: '5', created_at: '2026-04-29T12:00:00Z' },
            // 이후 (포함)
            { side: 'bid', state: 'done', executed_volume: '7', created_at: '2026-04-30T01:00:00Z' },
          ];
        }
        return [];
      }),
    }));

    const report = await reconcileBotAssets({ botId: 1, userId: 100 });

    expect(report.exchange.makerDoneOrderCount).toBe(1);
    expect(report.exchange.makerDoneBidQty).toBe('7');
  });

  it('done order count===100 → pageTruncated=true', async () => {
    (stablecoinPrisma.makerTakerSimBot.findUnique as jest.Mock).mockResolvedValueOnce(baseBot);
    (prisma.credential.findFirst as jest.Mock).mockResolvedValueOnce(baseCredential);
    (stablecoinPrisma.makerTakerSimTrade.findMany as jest.Mock).mockResolvedValueOnce([]);
    (stablecoinPrisma.makerTakerSimTrade.count as jest.Mock).mockResolvedValueOnce(0);
    const hundred = Array.from({ length: 100 }, () => ({
      side: 'bid',
      state: 'done',
      executed_volume: '0.1',
      created_at: '2026-04-30T01:00:00Z',
    }));
    (UpbitService as jest.Mock).mockImplementation(() => ({
      getOrdersByMarket: jest.fn().mockImplementation(async (market: string) => {
        if (market === 'KRW-USDS') return hundred;
        return [];
      }),
    }));

    const report = await reconcileBotAssets({ botId: 1, userId: 100 });

    expect(report.exchange.pageTruncated).toBe(true);
  });

  it('ownership 미일치 → throw', async () => {
    (stablecoinPrisma.makerTakerSimBot.findUnique as jest.Mock).mockResolvedValueOnce({
      ...baseBot,
      userId: 999,
    });

    await expect(reconcileBotAssets({ botId: 1, userId: 100 })).rejects.toThrow('not owned');
  });

  it('credential 부재 → throw "credential not registered"', async () => {
    (stablecoinPrisma.makerTakerSimBot.findUnique as jest.Mock).mockResolvedValueOnce(baseBot);
    (prisma.credential.findFirst as jest.Mock).mockResolvedValueOnce(null);

    await expect(reconcileBotAssets({ botId: 1, userId: 100 })).rejects.toThrow('credential not registered');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest __tests__/services/maker-taker-asset-reconciliation.service.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/maker-taker-asset-reconciliation.service'`

- [ ] **Step 3: 구현 (GREEN)**

Create `src/services/maker-taker-asset-reconciliation.service.ts`:

```typescript
/**
 * Maker-Taker 봇의 자산 정합 검증 — DB 기록(FILLED, live=true) 합계와
 * 거래소(Upbit) 의 done order 합계를 비교한다.
 *
 * Canary 검증 절차의 자동화 (PR D 수준의 수동 검증을 UI 한 번 클릭으로 대체).
 *
 * - 기준 시점(since): bot.lastResumeAt ?? bot.createdAt
 * - 비교 대상:
 *   - bot 측: makerTakerSimTrade(status=FILLED, live=true, makerFilledAt >= since)
 *   - Upbit 측: getOrdersByMarket(`KRW-${makerCoin}`, 'done').filter(side='bid' && created_at >= since)
 *               동일 패턴으로 takerCoin ask 합계
 *
 * 페이지네이션 미지원 (1봇 24h 규모 < 100건). count===100 이면 pageTruncated=true 로 표시.
 */

import { stablecoinPrisma } from '../config/database';
import mainPrisma from '../config/database';
import { UpbitService } from './upbit.service';
import { decrypt } from '../utils/encryption';

export interface ReconciliationReport {
  botId: number;
  sinceUtc: string;
  sinceSource: 'lastResumeAt' | 'createdAt';
  bot: {
    filledTradesCount: number;
    pendingTradesCount: number;
    filledMakerSumQty: string;
    filledTakerSumQty: string;
  };
  exchange: {
    makerCoin: string;
    takerCoin: string;
    makerDoneBidQty: string;
    takerDoneAskQty: string;
    makerDoneOrderCount: number;
    takerDoneOrderCount: number;
    pageTruncated: boolean;
  };
  diff: {
    makerCoinDiff: string;
    takerCoinDiff: string;
  };
  isReconciled: boolean;
}

const RECONCILE_TOLERANCE = 0.001;

function sumDecimal(values: Array<string | number>): number {
  return values.reduce((acc: number, v) => acc + (typeof v === 'string' ? parseFloat(v) : v), 0);
}

function fmt(n: number): string {
  return n.toFixed(8).replace(/\.?0+$/, '') || '0';
}

export async function reconcileBotAssets(params: {
  botId: number;
  userId: number;
}): Promise<ReconciliationReport> {
  const { botId, userId } = params;

  // 1. 봇 조회 + ownership
  const bot = await stablecoinPrisma.makerTakerSimBot.findUnique({
    where: { id: botId },
  });
  if (!bot) throw new Error('Bot not found');
  if (bot.userId !== userId) throw new Error('Bot not owned by user');

  // 2. 기준 시점
  const since = bot.lastResumeAt ?? bot.createdAt;
  const sinceSource: 'lastResumeAt' | 'createdAt' = bot.lastResumeAt ? 'lastResumeAt' : 'createdAt';

  // 3. credential
  const credential = await mainPrisma.credential.findFirst({
    where: { userId, exchange: 'upbit' },
  });
  if (!credential) throw new Error('Upbit credential not registered');

  // 4. bot DB 합계
  const filledTrades = await stablecoinPrisma.makerTakerSimTrade.findMany({
    where: {
      botId,
      status: 'FILLED',
      live: true,
      makerFilledAt: { gte: since },
    },
    select: { id: true, quantity: true, makerFilledAt: true },
  });
  const pendingTradesCount = await stablecoinPrisma.makerTakerSimTrade.count({
    where: { botId, status: 'PENDING', live: true },
  });

  const botMakerSum = sumDecimal(filledTrades.map((t: any) => t.quantity?.toString() ?? '0'));
  const botTakerSum = botMakerSum; // maker-taker 1:1 cross-coin direct swap

  // 5. Upbit done orders
  const accessKey = decrypt(credential.apiKey);
  const secretKey = decrypt(credential.secretKey);
  const upbit = new UpbitService({ accessKey, secretKey });

  const makerOrders = await upbit.getOrdersByMarket(`KRW-${bot.makerCoin}`, 'done');
  const takerOrders = await upbit.getOrdersByMarket(`KRW-${bot.takerCoin}`, 'done');

  const sinceMs = since.getTime();
  const makerBids = (makerOrders ?? []).filter(
    (o: any) => o.side === 'bid' && new Date(o.created_at).getTime() >= sinceMs,
  );
  const takerAsks = (takerOrders ?? []).filter(
    (o: any) => o.side === 'ask' && new Date(o.created_at).getTime() >= sinceMs,
  );
  const exchangeMakerSum = sumDecimal(makerBids.map((o: any) => o.executed_volume ?? '0'));
  const exchangeTakerSum = sumDecimal(takerAsks.map((o: any) => o.executed_volume ?? '0'));

  const pageTruncated =
    (makerOrders?.length ?? 0) === 100 || (takerOrders?.length ?? 0) === 100;

  // 6. diff
  const makerDiff = botMakerSum - exchangeMakerSum;
  const takerDiff = botTakerSum - exchangeTakerSum;
  const isReconciled =
    Math.abs(makerDiff) < RECONCILE_TOLERANCE &&
    Math.abs(takerDiff) < RECONCILE_TOLERANCE;

  return {
    botId,
    sinceUtc: since.toISOString(),
    sinceSource,
    bot: {
      filledTradesCount: filledTrades.length,
      pendingTradesCount,
      filledMakerSumQty: fmt(botMakerSum),
      filledTakerSumQty: fmt(botTakerSum),
    },
    exchange: {
      makerCoin: bot.makerCoin,
      takerCoin: bot.takerCoin,
      makerDoneBidQty: fmt(exchangeMakerSum),
      takerDoneAskQty: fmt(exchangeTakerSum),
      makerDoneOrderCount: makerBids.length,
      takerDoneOrderCount: takerAsks.length,
      pageTruncated,
    },
    diff: {
      makerCoinDiff: fmt(makerDiff),
      takerCoinDiff: fmt(takerDiff),
    },
    isReconciled,
  };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest __tests__/services/maker-taker-asset-reconciliation.service.test.ts`
Expected: PASS — 8/8

테스트 도중 mock 의 makerTakerSimTrade.count, prisma.credential 의 mock setup 이 부족하면 `__mocks__/database.ts` 에 추가. 이미 Task 5 에서 추가했으므로 정상 동작.

- [ ] **Step 5: 커밋**

```bash
git add src/services/maker-taker-asset-reconciliation.service.ts __tests__/services/maker-taker-asset-reconciliation.service.test.ts
git commit -m "feat: PR H — reconcileBotAssets 서비스 (잔고 정합 자동 검증)"
```

---

## Task 8: controller validation + 신규 verify endpoint

**Files:**
- Modify: `v0-grid-tranasction-backend/src/controllers/stablecoin-admin.controller.ts`
- Modify: `v0-grid-tranasction-backend/src/routes/stablecoin-admin.ts`

- [ ] **Step 1: createMakerBot / patchMakerBot 에 minSpreadKrw 검증 추가**

Modify `src/controllers/stablecoin-admin.controller.ts:280` 부근 (createMakerBot 의 validation 블록). `if (body.takerFeeBps !== undefined && ...)` 다음 줄에 추가:

```typescript
    if (body.minSpreadKrw !== undefined && (!Number.isInteger(body.minSpreadKrw) || body.minSpreadKrw < 0)) {
      throw new AppError('Invalid body: minSpreadKrw must be non-negative integer', 400);
    }
```

그리고 createMakerBot 의 service 호출 부분에 추가:

```typescript
    const bot = await arbService.createMakerBot({
      userId,
      makerCoin: body.makerCoin,
      takerCoin: body.takerCoin,
      bidOffsetKrw: body.bidOffsetKrw,
      quantity: body.quantity,
      maxPendingMs: body.maxPendingMs,
      minTakerBidKrw: body.minTakerBidKrw,
      minTakerBalance: body.minTakerBalance,
      makerFeeBps: body.makerFeeBps,
      takerFeeBps: body.takerFeeBps,
      minSpreadKrw: body.minSpreadKrw, // NEW PR H
    });
```

(arbService.createMakerBot 시그니처에도 minSpreadKrw?: number 추가 필요 — 다음 step 에서 같이.)

patchMakerBot 검증 (controller 의 patch 블록, 360 부근). takerFeeBps 다음에:

```typescript
    if (body.minSpreadKrw !== undefined) {
      if (!Number.isInteger(body.minSpreadKrw) || body.minSpreadKrw < 0) throw new AppError('Invalid body: minSpreadKrw must be non-negative integer', 400);
      patch.minSpreadKrw = body.minSpreadKrw;
    }
```

- [ ] **Step 2: arbService.createMakerBot input 타입 확장**

Modify `src/services/stablecoin-arb.service.ts` — `createMakerBot` 함수 위의 `CreateMakerBotInput` (또는 inline 시그니처) 에 추가:

```typescript
  minSpreadKrw?: number;
```

함수 본문에서 prisma.create 의 data 객체에 `minSpreadKrw: input.minSpreadKrw ?? 12,` 또는 default 가 schema 에 있으므로 그냥 `minSpreadKrw: input.minSpreadKrw,` 통과.

`PatchMakerBotInput` 에도 동일하게 (이미 Task 6 에서 추가됨, 재확인만).

`serializeMakerBot` 함수가 있다면 minSpreadKrw, lastResumeAt 도 응답에 포함:

```typescript
function serializeMakerBot(bot: ...) {
  return {
    // ... 기존 필드
    minSpreadKrw: bot.minSpreadKrw,
    lastResumeAt: bot.lastResumeAt?.toISOString() ?? null,
  };
}
```

(controller 의 serializeMakerBot 위치는 `src/controllers/stablecoin-admin.controller.ts` 파일 위쪽. 위치 확인 후 추가.)

- [ ] **Step 3: verifyMakerBotReconciliation controller 추가**

Modify `src/controllers/stablecoin-admin.controller.ts` — patchMakerBot 함수 다음에 추가:

```typescript
/**
 * POST /api/admin/stablecoin/maker-bots/:id/verify-reconciliation
 *
 * 봇 #id 의 lastResumeAt 이후 DB FILLED 합계와 Upbit done order 합계를 비교한다.
 * 응답: ReconciliationReport (서비스 동일 타입)
 */
export const verifyMakerBotReconciliation = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.userId!;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw new AppError('Invalid id', 400);

    const report = await reconcileBotAssets({ botId: id, userId });
    res.json(report);
  } catch (error: any) {
    if (error?.message?.includes('not found')) return next(new AppError('Bot not found', 404));
    if (error?.message?.includes('not owned')) return next(new AppError('Bot not owned by user', 403));
    if (error?.message?.includes('credential not registered'))
      return next(new AppError('Upbit credential not registered', 400));
    next(error);
  }
};
```

해당 controller 파일 import 블록에 추가:

```typescript
import { reconcileBotAssets } from '../services/maker-taker-asset-reconciliation.service';
```

- [ ] **Step 4: 라우트 등록**

Modify `src/routes/stablecoin-admin.ts` — patchMakerBot import 옆에 추가:

```typescript
import {
  // ... 기존
  patchMakerBot,
  verifyMakerBotReconciliation, // NEW
} from '../controllers/stablecoin-admin.controller';
```

`router.patch('/maker-bots/:id', patchMakerBot);` 다음 줄에:

```typescript
router.patch('/maker-bots/:id', patchMakerBot);
router.post('/maker-bots/:id/verify-reconciliation', verifyMakerBotReconciliation); // NEW PR H
```

- [ ] **Step 5: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 6: 전체 백엔드 테스트**

Run: `npm test`
Expected: 신규 + 기존 모두 PASS

- [ ] **Step 7: 빌드**

Run: `npm run build`
Expected: 빌드 성공

- [ ] **Step 8: 커밋**

```bash
git add src/controllers/stablecoin-admin.controller.ts src/routes/stablecoin-admin.ts src/services/stablecoin-arb.service.ts
git commit -m "feat: PR H — verifyMakerBotReconciliation endpoint + minSpreadKrw 검증"
```

---

## Task 9: 백엔드 PR push + 머지 대기

**Files:**
- (no code changes)

- [ ] **Step 1: 백엔드 변경사항 push**

```bash
git push origin feature/pr-h-canary-stage-3-readiness
```

(global 안전 규칙: push 전 사용자에게 브랜치명 + 대상 origin 보고. push 직접 실행은 사용자 승인 후.)

- [ ] **Step 2: PR 생성**

```bash
gh pr create --title "feat: PR H — Canary Stage 3 사전 정비 (백엔드)" --body "$(cat <<'EOF'
## Summary
- Canary Stage 2 학습 4가지 후속 액션 백엔드 부분
- 수익성 gating (`minSpreadKrw` 봇 컬럼 + spread-gate 순수 함수)
- T_start 별도 저장 (`lastResumeAt` 컬럼 + enabled false→true 전환 감지 자동 갱신)
- 잔고 정합 검증 (`reconcileBotAssets` 서비스 + POST `/maker-bots/:id/verify-reconciliation`)
- (UI 부분은 프론트엔드 PR 별도)

## Spec
docs/superpowers/specs/2026-04-30-canary-stage-3-readiness-design.md

## Plan
docs/superpowers/plans/2026-04-30-canary-stage-3-readiness.md

## Test plan
- [x] spread-gate 단위 테스트 (5 case)
- [x] patchMakerBot lastResumeAt 자동 갱신 (6 case)
- [x] reconcileBotAssets (8 case)
- [x] live-executor 회귀 (10 case)
- [x] tsc + build 성공
- [ ] 머지 후 Lightsail 배포 GH Actions 성공 확인
- [ ] 봇 #1 PATCH enabled=true → DB 의 lastResumeAt 채워짐 확인

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: 머지 후 GH Actions 확인**

Run: `gh run list --limit 1`
Expected: status = success

- [ ] **Step 4: Lightsail 배포 확인 (간단 health check)**

운영 host(54.180.188.8:3010) 의 health endpoint 호출 또는 admin UI 봇 목록이 minSpreadKrw 필드 포함해서 반환되는지 확인.

---

## Task 10: 프론트엔드 lib/api.ts 타입 + 함수 확장

**Files:**
- Modify: `v0-grid-transaction-frontend/lib/api.ts:2563-2750` (MakerTakerSimBot, PatchMakerBotBody, 신규 함수)

- [ ] **Step 1: MakerTakerSimBot 타입에 신규 필드 추가**

Modify `v0-grid-transaction-frontend/lib/api.ts:2563` 부근 (`export interface MakerTakerSimBot {` 블록):

```typescript
export interface MakerTakerSimBot {
  id: number;
  userId: number;
  enabled: boolean;
  killSwitch: boolean;
  live: boolean;
  makerCoin: string;
  takerCoin: string;
  bidOffsetKrw: number;
  quantity: string | number | null;
  maxPendingMs: number;
  minTakerBidKrw: number | null;
  minTakerBalance: number | null;
  makerFeeBps: number;
  takerFeeBps: number;
  minSpreadKrw: number;          // NEW PR H
  lastResumeAt: string | null;   // NEW PR H (ISO string or null)
  createdAt: string;
  updatedAt: string;
}
```

(기존 필드 정확한 정의 위치 확인 후 NEW 두 줄만 추가. 다른 필드는 그대로 유지.)

- [ ] **Step 2: PatchMakerBotBody 에 minSpreadKrw 추가**

Modify `v0-grid-transaction-frontend/lib/api.ts:2723` (patchMakerBot 의 body 타입):

```typescript
export interface PatchMakerBotBody {
  enabled?: boolean;
  killSwitch?: boolean;
  live?: boolean;
  bidOffsetKrw?: number;
  quantity?: number;
  maxPendingMs?: number;
  minTakerBidKrw?: number | null;
  minTakerBalance?: number | null;
  makerFeeBps?: number;
  takerFeeBps?: number;
  minSpreadKrw?: number;  // NEW PR H
}
```

- [ ] **Step 3: ReconciliationReport 타입 + verifyMakerBotReconciliation 함수**

`patchMakerBot` 함수 다음에 추가:

```typescript
export interface ReconciliationReport {
  botId: number;
  sinceUtc: string;
  sinceSource: 'lastResumeAt' | 'createdAt';
  bot: {
    filledTradesCount: number;
    pendingTradesCount: number;
    filledMakerSumQty: string;
    filledTakerSumQty: string;
  };
  exchange: {
    makerCoin: string;
    takerCoin: string;
    makerDoneBidQty: string;
    takerDoneAskQty: string;
    makerDoneOrderCount: number;
    takerDoneOrderCount: number;
    pageTruncated: boolean;
  };
  diff: {
    makerCoinDiff: string;
    takerCoinDiff: string;
  };
  isReconciled: boolean;
}

export const verifyMakerBotReconciliation = async (
  id: number,
): Promise<ReconciliationReport> => {
  const response = await fetch(
    `${API_URL}/api/admin/stablecoin/maker-bots/${id}/verify-reconciliation`,
    {
      method: 'POST',
      headers: getAuthHeaders(),
    },
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(error.message || 'Failed to verify reconciliation');
  }
  return response.json();
};
```

(`API_URL`, `getAuthHeaders` 는 파일 위쪽에 이미 정의됨 — 동일 패턴 차용.)

- [ ] **Step 4: 빌드 검증**

Run: `cd v0-grid-transaction-frontend && npm run build`
Expected: 빌드 성공

- [ ] **Step 5: 프론트엔드 별도 브랜치 + 커밋**

```bash
cd v0-grid-transaction-frontend
git checkout -b feature/pr-h-canary-stage-3-readiness
git add lib/api.ts
git commit -m "feat: PR H — MakerTakerSimBot 타입 확장 + verifyMakerBotReconciliation"
```

---

## Task 11: EditMakerBotDialog 컴포넌트 신규

**Files:**
- Create: `v0-grid-transaction-frontend/app/admin/stablecoin/_components/EditMakerBotDialog.tsx`

- [ ] **Step 1: 컴포넌트 작성**

Create `app/admin/stablecoin/_components/EditMakerBotDialog.tsx`:

```typescript
"use client"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2, AlertTriangle } from "lucide-react"
import type { MakerTakerSimBot, PatchMakerBotBody } from "@/lib/api"

interface EditMakerBotDialogProps {
  bot: MakerTakerSimBot | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (id: number, patch: PatchMakerBotBody) => Promise<void>
  submitting: boolean
  error: string | null
}

export function EditMakerBotDialog({
  bot,
  open,
  onOpenChange,
  onSubmit,
  submitting,
  error,
}: EditMakerBotDialogProps) {
  const [bidOffsetKrw, setBidOffsetKrw] = useState("")
  const [quantity, setQuantity] = useState("")
  const [minSpreadKrw, setMinSpreadKrw] = useState("")
  const [minTakerBalance, setMinTakerBalance] = useState("")
  const [makerFeeBps, setMakerFeeBps] = useState("")
  const [takerFeeBps, setTakerFeeBps] = useState("")

  // bot 로드 시 form 초기화
  useState(() => {
    if (bot) {
      setBidOffsetKrw(String(bot.bidOffsetKrw))
      setQuantity(String(bot.quantity ?? ""))
      setMinSpreadKrw(String(bot.minSpreadKrw))
      setMinTakerBalance(bot.minTakerBalance == null ? "" : String(bot.minTakerBalance))
      setMakerFeeBps(String(bot.makerFeeBps))
      setTakerFeeBps(String(bot.takerFeeBps))
    }
  })

  if (!bot) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const patch: PatchMakerBotBody = {}
    // 변경된 필드만 patch 에 포함 (서버 부담 최소화 + lastResumeAt 미갱신 보장)
    if (Number(bidOffsetKrw) !== bot.bidOffsetKrw) patch.bidOffsetKrw = Number(bidOffsetKrw)
    if (Number(quantity) !== Number(bot.quantity)) patch.quantity = Number(quantity)
    if (Number(minSpreadKrw) !== bot.minSpreadKrw) patch.minSpreadKrw = Number(minSpreadKrw)
    const newMin = minTakerBalance.trim() === "" ? null : Number(minTakerBalance)
    if (newMin !== bot.minTakerBalance) patch.minTakerBalance = newMin
    if (Number(makerFeeBps) !== bot.makerFeeBps) patch.makerFeeBps = Number(makerFeeBps)
    if (Number(takerFeeBps) !== bot.takerFeeBps) patch.takerFeeBps = Number(takerFeeBps)

    if (Object.keys(patch).length === 0) {
      onOpenChange(false)
      return
    }
    await onSubmit(bot.id, patch)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>봇 #{bot.id} 편집 ({bot.makerCoin} → {bot.takerCoin})</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1">
            <Label>Bid Offset (KRW)</Label>
            <Input
              type="number"
              step="1"
              value={bidOffsetKrw}
              onChange={(e) => setBidOffsetKrw(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1">
            <Label>수량 (Quantity)</Label>
            <Input
              type="number"
              min="1"
              step="1"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1">
            <Label>최소 Spread (KRW) — 0=비활성</Label>
            <Input
              type="number"
              min="0"
              step="1"
              value={minSpreadKrw}
              onChange={(e) => setMinSpreadKrw(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1">
            <Label>최소 Taker 잔고 (자동 일시정지) — 비워두면 비활성</Label>
            <Input
              type="number"
              min="0"
              step="1"
              value={minTakerBalance}
              onChange={(e) => setMinTakerBalance(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>Maker Fee (bps)</Label>
              <Input
                type="number"
                min="0"
                step="1"
                value={makerFeeBps}
                onChange={(e) => setMakerFeeBps(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <Label>Taker Fee (bps)</Label>
              <Input
                type="number"
                min="0"
                step="1"
                value={takerFeeBps}
                onChange={(e) => setTakerFeeBps(e.target.value)}
                required
              />
            </div>
          </div>
          {error && (
            <div className="text-red-500 text-sm flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              {error}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              저장
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
```

**주의**: `useState(() => { if (bot) {...} })` 는 초기화 함수가 아닌 lazy initial state 사용 패턴. 여기선 `useEffect` 가 더 정확함:

위 코드의 `useState(() => {...})` 부분을 다음으로 교체:

```typescript
import { useState, useEffect } from "react"

// ... 컴포넌트 안에서
useEffect(() => {
  if (bot) {
    setBidOffsetKrw(String(bot.bidOffsetKrw))
    setQuantity(String(bot.quantity ?? ""))
    setMinSpreadKrw(String(bot.minSpreadKrw))
    setMinTakerBalance(bot.minTakerBalance == null ? "" : String(bot.minTakerBalance))
    setMakerFeeBps(String(bot.makerFeeBps))
    setTakerFeeBps(String(bot.takerFeeBps))
  }
}, [bot])
```

- [ ] **Step 2: 빌드 검증**

Run: `npm run build`
Expected: 빌드 성공

- [ ] **Step 3: 커밋**

```bash
git add app/admin/stablecoin/_components/EditMakerBotDialog.tsx
git commit -m "feat: PR H — EditMakerBotDialog 컴포넌트 신규"
```

---

## Task 12: ReconciliationDialog 컴포넌트 신규

**Files:**
- Create: `v0-grid-transaction-frontend/app/admin/stablecoin/_components/ReconciliationDialog.tsx`

- [ ] **Step 1: 컴포넌트 작성**

Create `app/admin/stablecoin/_components/ReconciliationDialog.tsx`:

```typescript
"use client"

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, AlertTriangle, CheckCircle2, AlertCircle } from "lucide-react"
import type { ReconciliationReport } from "@/lib/api"
import { fmtKst } from "../_utils/formatters"

interface ReconciliationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  report: ReconciliationReport | null
  loading: boolean
  error: string | null
}

export function ReconciliationDialog({
  open,
  onOpenChange,
  report,
  loading,
  error,
}: ReconciliationDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>잔고 정합 검증</DialogTitle>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 py-8 justify-center">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>Upbit done order 조회 중...</span>
          </div>
        )}

        {error && (
          <div className="text-red-500 text-sm flex items-center gap-2 p-3 border rounded">
            <AlertTriangle className="h-4 w-4" />
            {error}
          </div>
        )}

        {report && !loading && (
          <div className="space-y-4">
            {/* 헤더 — 결과 요약 */}
            <div className="flex items-center gap-2">
              {report.isReconciled ? (
                <Badge variant="default" className="bg-green-600 hover:bg-green-700">
                  <CheckCircle2 className="h-4 w-4 mr-1" />
                  일치 (RECONCILED)
                </Badge>
              ) : (
                <Badge variant="destructive">
                  <AlertCircle className="h-4 w-4 mr-1" />
                  불일치 (DIFF 존재)
                </Badge>
              )}
              <span className="text-sm text-muted-foreground">
                Bot #{report.botId}
              </span>
            </div>

            {/* sinceSource 경고 */}
            {report.sinceSource === "createdAt" && (
              <div className="text-yellow-700 dark:text-yellow-400 text-sm flex items-center gap-2 p-2 border border-yellow-500 rounded">
                <AlertTriangle className="h-4 w-4" />
                ⚠️ Resume 기록 없음 — 봇 생성 시점부터 전체 기간 검증 (Upbit API 부담 클 수 있음)
              </div>
            )}

            {/* 페이지 절단 경고 */}
            {report.exchange.pageTruncated && (
              <div className="text-yellow-700 dark:text-yellow-400 text-sm flex items-center gap-2 p-2 border border-yellow-500 rounded">
                <AlertTriangle className="h-4 w-4" />
                ⚠️ Upbit done order 가 100건 도달 — 결과 절단 가능 (페이지네이션 필요)
              </div>
            )}

            <div className="text-sm">
              <span className="font-semibold">기준 시점:</span>{" "}
              {fmtKst(report.sinceUtc)} ({report.sinceSource})
            </div>

            {/* 비교 표 */}
            <table className="w-full text-sm border">
              <thead className="border-b bg-muted/30">
                <tr>
                  <th className="text-left p-2"></th>
                  <th className="text-right p-2">Maker ({report.exchange.makerCoin})</th>
                  <th className="text-right p-2">Taker ({report.exchange.takerCoin})</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b">
                  <td className="p-2 font-medium">Bot DB 합계</td>
                  <td className="text-right p-2 font-mono">{report.bot.filledMakerSumQty}</td>
                  <td className="text-right p-2 font-mono">{report.bot.filledTakerSumQty}</td>
                </tr>
                <tr className="border-b">
                  <td className="p-2 font-medium">Upbit done 합계</td>
                  <td className="text-right p-2 font-mono">{report.exchange.makerDoneBidQty}</td>
                  <td className="text-right p-2 font-mono">{report.exchange.takerDoneAskQty}</td>
                </tr>
                <tr className="border-b font-semibold">
                  <td className="p-2">Diff (Bot − Upbit)</td>
                  <td className={`text-right p-2 font-mono ${report.diff.makerCoinDiff !== "0" ? "text-red-500" : ""}`}>
                    {report.diff.makerCoinDiff}
                  </td>
                  <td className={`text-right p-2 font-mono ${report.diff.takerCoinDiff !== "0" ? "text-red-500" : ""}`}>
                    {report.diff.takerCoinDiff}
                  </td>
                </tr>
              </tbody>
            </table>

            <div className="text-xs text-muted-foreground space-y-1">
              <div>FILLED 거래: {report.bot.filledTradesCount}건 / PENDING: {report.bot.pendingTradesCount}건</div>
              <div>
                Upbit done order: maker {report.exchange.makerDoneOrderCount}건 / taker {report.exchange.takerDoneOrderCount}건
              </div>
              {report.bot.pendingTradesCount > 0 && (
                <div className="text-yellow-700 dark:text-yellow-400">
                  ⚠️ PENDING 진행 중 — 일시 불일치 가능
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            닫기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: 빌드 검증**

Run: `npm run build`
Expected: 빌드 성공

- [ ] **Step 3: 커밋**

```bash
git add app/admin/stablecoin/_components/ReconciliationDialog.tsx
git commit -m "feat: PR H — ReconciliationDialog 컴포넌트 신규"
```

---

## Task 13: MakerTakerSimPanel 통합 (편집 + 검증 + Resume since)

**Files:**
- Modify: `v0-grid-transaction-frontend/app/admin/stablecoin/_components/MakerTakerSimPanel.tsx`

- [ ] **Step 1: import 추가 + 신규 state**

Modify `MakerTakerSimPanel.tsx:1-30` (import 부분):

```typescript
"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Loader2, AlertTriangle, Trash2, Plus, Pencil, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  getStablecoinSimOverview,
  listMakerBots,
  createMakerBot,
  patchMakerBot,
  deleteMakerBot,
  verifyMakerBotReconciliation,           // NEW PR H
  type MakerTakerSimTrade,
  type MakerTakerSimBot,
  type PatchMakerBotBody,                  // NEW PR H
  type ReconciliationReport,               // NEW PR H
} from "@/lib/api"
import { usePolling } from "../_hooks/usePolling"
import { fmtKst } from "../_utils/formatters"
import { EditMakerBotDialog } from "./EditMakerBotDialog"           // NEW PR H
import { ReconciliationDialog } from "./ReconciliationDialog"       // NEW PR H
```

`MakerTakerSimPanel` 컴포넌트 안의 state 그룹 끝에 추가:

```typescript
  // PR H — 편집 dialog
  const [editingBot, setEditingBot] = useState<MakerTakerSimBot | null>(null)
  const [editSubmitting, setEditSubmitting] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  // PR H — 검증 dialog
  const [verifyOpen, setVerifyOpen] = useState(false)
  const [verifyReport, setVerifyReport] = useState<ReconciliationReport | null>(null)
  const [verifyLoading, setVerifyLoading] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)
```

- [ ] **Step 2: 편집 / 검증 핸들러 추가**

`handleDelete` 다음에 추가:

```typescript
  // 편집 dialog 핸들러
  const handleEdit = (bot: MakerTakerSimBot) => {
    setEditingBot(bot)
    setEditError(null)
  }

  const handleEditSubmit = async (id: number, patch: PatchMakerBotBody) => {
    setEditSubmitting(true)
    setEditError(null)
    try {
      await patchMakerBot(id, patch)
      setEditingBot(null)
      refreshBots()
    } catch (e) {
      setEditError("저장 실패: " + (e as Error).message)
    } finally {
      setEditSubmitting(false)
    }
  }

  // 검증 핸들러
  const handleVerify = async (bot: MakerTakerSimBot) => {
    setVerifyOpen(true)
    setVerifyLoading(true)
    setVerifyReport(null)
    setVerifyError(null)
    try {
      const report = await verifyMakerBotReconciliation(bot.id)
      setVerifyReport(report)
    } catch (e) {
      setVerifyError((e as Error).message)
    } finally {
      setVerifyLoading(false)
    }
  }
```

- [ ] **Step 3: 봇 카드에 편집/검증 버튼 + Resume since 표시**

봇 카드 메타 부분 (현재 `<div className="text-xs text-muted-foreground">` 블록) 수정:

```typescript
                  <div className="text-xs text-muted-foreground">
                    qty={bot.quantity ?? "—"} / offset={bot.bidOffsetKrw} / minSpread={bot.minSpreadKrw} / 수수료 maker={bot.makerFeeBps}bp taker={bot.takerFeeBps}bp
                    {bot.minTakerBalance != null && ` / 최소잔고=${bot.minTakerBalance} ${bot.takerCoin}`}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Resume since: {bot.lastResumeAt ? fmtKst(bot.lastResumeAt) : "—"}
                  </div>
```

봇 카드 버튼 그룹에 편집/검증 버튼 추가 — `<Button size="sm" variant="ghost" onClick={() => handleDelete(bot)}>` 직전에:

```typescript
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleEdit(bot)}
                    title="봇 파라미터 편집"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleVerify(bot)}
                    title="잔고 정합 검증 (DB vs Upbit)"
                  >
                    <Search className="h-4 w-4" />
                  </Button>
```

- [ ] **Step 4: Dialog 마운트 (CardContent 끝)**

`</CardContent>` 직전 (return 의 끝부분 전체 div 닫히기 전) 에 추가:

```typescript
        {/* PR H — 편집 / 검증 Dialog */}
        <EditMakerBotDialog
          bot={editingBot}
          open={editingBot !== null}
          onOpenChange={(open) => { if (!open) setEditingBot(null) }}
          onSubmit={handleEditSubmit}
          submitting={editSubmitting}
          error={editError}
        />
        <ReconciliationDialog
          open={verifyOpen}
          onOpenChange={setVerifyOpen}
          report={verifyReport}
          loading={verifyLoading}
          error={verifyError}
        />
```

- [ ] **Step 5: 빌드 + 린트**

```bash
npm run lint
npm run build
```

Expected: 0 errors

- [ ] **Step 6: 커밋**

```bash
git add app/admin/stablecoin/_components/MakerTakerSimPanel.tsx
git commit -m "feat: PR H — MakerTakerSimPanel 에 편집/검증 버튼 통합"
```

---

## Task 14: 통합 검증 (수동)

**Files:** (no code changes)

- [ ] **Step 1: 백엔드 dev 서버 + Upbit balance ready 확인**

```bash
cd v0-grid-tranasction-backend
npm run dev
```

별도 터미널에서:

```bash
curl -s http://localhost:3010/health
```

Expected: status=ok

- [ ] **Step 2: 프론트엔드 dev 서버**

```bash
cd v0-grid-transaction-frontend
npm run dev
```

브라우저 `http://localhost:3009/admin/stablecoin` 접속

- [ ] **Step 3: Edit Dialog 동작 확인**

1. 봇 #1 카드의 ✏️ 클릭
2. minSpreadKrw 를 12 → 15 로 변경 → 저장
3. 봇 카드에 minSpread=15 반영됨 확인
4. DB 직접 확인: `SELECT minSpreadKrw, lastResumeAt FROM maker_taker_sim_bots WHERE id=1`
   Expected: minSpreadKrw=15, lastResumeAt 미변경 (이전 값 유지)

- [ ] **Step 4: lastResumeAt 자동 갱신 동작 확인**

1. 봇 #1 enabled=false 상태에서 ▶ Resume 클릭 (off→on)
2. DB 직접 확인: `SELECT enabled, lastResumeAt FROM maker_taker_sim_bots WHERE id=1`
   Expected: enabled=true, lastResumeAt = 방금 시각
3. 다시 🛑 Stop → DB lastResumeAt 변경 없음 확인 (resume 시점 보존)

- [ ] **Step 5: 잔고 정합 검증 동작 확인**

1. 봇 #1 카드의 🔍 클릭
2. ReconciliationDialog 가 열리고 "Upbit done order 조회 중..." 표시
3. 결과 도착 후 Bot DB 합계 vs Upbit done 합계 비교 표 확인
4. Canary Stage 2 #382 FILLED row 가 lastResumeAt 이후라면 Bot 측에 quantity=10 표시
   Upbit 측 KRW-USDS bid 매수 1건(10 USDS) + KRW-USDT ask 매도 1건(10 USDT) 매칭
   Diff=0, isReconciled=true 확인

- [ ] **Step 6: spread gate 동작 확인 (sim 봇)**

1. 봇 #2 (live=false 인 다른 봇이 있다면) 또는 임시로 sim 봇 생성, minSpreadKrw=20
2. 현재 USDS 호가 spread 가 < 20 이면 PENDING row 미생성 확인
3. 백엔드 로그에서 spread gate 미달 메시지 확인 (또는 row 생성 빈도 변화로 간접 확인)

`SELECT count(*) FROM maker_taker_sim_trades WHERE botId=<id> AND createdAt >= NOW() - INTERVAL 1 MINUTE`

---

## Task 15: 프론트엔드 PR push + 머지

**Files:** (no code changes)

- [ ] **Step 1: 프론트엔드 push**

```bash
cd v0-grid-transaction-frontend
git push origin feature/pr-h-canary-stage-3-readiness
```

(사용자에게 push 승인 받은 후)

- [ ] **Step 2: PR 생성**

```bash
gh pr create --title "feat: PR H — Canary Stage 3 사전 정비 (프론트엔드)" --body "$(cat <<'EOF'
## Summary
- Canary Stage 2 학습 4가지 후속 액션 프론트엔드 부분
- ✏️ EditMakerBotDialog: bidOffsetKrw + quantity + minSpreadKrw + minTakerBalance + 수수료 종합 편집
- 🔍 ReconciliationDialog: 잔고 정합 검증 결과 표시
- 봇 카드에 minSpread + Resume since 표시
- (백엔드 부분은 백엔드 PR 별도 — 머지 + 배포 완료 필요)

## 의존성
- 백엔드 PR (`feature/pr-h-canary-stage-3-readiness` 백엔드 레포) 머지 + Lightsail 배포 완료 후 머지

## Test plan
- [x] 타입체크 + 빌드 성공
- [x] dev 서버에서 Edit Dialog → 저장 → DB 반영 확인
- [x] enabled false→true 전환 → DB lastResumeAt 자동 set 확인
- [x] 검증 버튼 → ReconciliationDialog → Upbit done order 조회 + diff 표시
- [x] sinceSource=createdAt 경고 배지 표시 확인

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: 머지 후 Vercel 배포 확인**

production URL `https://v0-grid-transaction.vercel.app/admin/stablecoin` 접속 → 봇 카드의 편집/검증 버튼 동작 확인.

---

## Task 16: 메모리 업데이트

**Files:**
- Create: `~/.claude/projects/D--ExpressProject-Grid-project/memory/project_pr_h_canary_stage_3_readiness_complete.md`
- Modify: `~/.claude/projects/D--ExpressProject-Grid-project/memory/MEMORY.md`

- [ ] **Step 1: 메모리 파일 작성**

Create `~/.claude/projects/D--ExpressProject-Grid-project/memory/project_pr_h_canary_stage_3_readiness_complete.md`:

```markdown
---
name: PR H 머지 완료 (2026-04-30) — Canary Stage 3 사전 정비
description: 4가지 후속 액션(수익성 gating, lastResumeAt, Edit Dialog, 잔고 정합 검증) 한 라운드에 반영. canary stage 3 가동 준비 완료.
type: project
---

# PR H 머지 완료 — Canary Stage 3 사전 정비

## 한 줄
Canary Stage 2 학습 4가지를 한 PR에 묶어 stage 3 가동 직전 정비 완료.

## 변경 요약
- DB: `MakerTakerSimBot.minSpreadKrw Int @default(12)` + `lastResumeAt DateTime?` 추가
- 수익성 gating: live + sim 양쪽 evaluate 에서 (bestAsk-bestBid) >= minSpreadKrw 미달 시 placement 스킵
- T_start: PATCH `enabled: false→true` 자동 감지로 `lastResumeAt` 갱신, 다른 PATCH 에선 미갱신
- 잔고 정합 검증: POST `/maker-bots/:id/verify-reconciliation` + Admin UI 🔍 버튼 + ReconciliationDialog
- bidOffsetKrw UI: ✏️ Edit Dialog 종합 편집 (bidOffsetKrw + quantity + minSpreadKrw + minTakerBalance + fees)

## 다음 라운드 (Canary Stage 3)
- 봇 #1 ▶ Resume → lastResumeAt 자동 채워짐
- 24h 관찰 후 🔍 클릭으로 자동 정합 검증 (PR D 수동 절차 자동화)
- 메모리 권고대로 minSpreadKrw 별도 봇으로 다른 값(예: 15, 20) 비교 가능

## 관련 메모리
- `project_canary_stage_2_complete_2026_04_30.md` — 4가지 후속 액션 출처
- `project_pr_e2_complete_2026_04_29.md` — live executor spec § 2 (이번 PR 에서 변경 없음)
- spec: `v0-grid-tranasction-backend/docs/superpowers/specs/2026-04-30-canary-stage-3-readiness-design.md`
- plan: `v0-grid-tranasction-backend/docs/superpowers/plans/2026-04-30-canary-stage-3-readiness.md`
```

- [ ] **Step 2: MEMORY.md 인덱스 갱신**

Modify `~/.claude/projects/D--ExpressProject-Grid-project/memory/MEMORY.md` 맨 위 (가장 최근 메모리):

```markdown
- 🚀 **[PR H 머지 완료 2026-04-30](project_pr_h_canary_stage_3_readiness_complete.md)** — Canary Stage 2 학습 4가지(minSpreadKrw, lastResumeAt, Edit Dialog, 잔고 정합 검증) 한 라운드에 반영. stage 3 가동 준비 완료.
```

- [ ] **Step 3: ~/.claude 동기화**

```bash
cd ~/.claude && /sync-config
```

또는 사용자 개입 (커밋 후 push).

---

## Self-Review

- ✅ 모든 spec 요구사항이 task 에 매핑됨
  - §2 데이터 모델 → Task 1
  - §3.1 spread-gate → Task 2
  - §3.1 asset-reconciliation → Task 7
  - §3.1 live executor 변경 → Task 3
  - §3.1 agent 변경 → Task 4
  - §3.1 patchMakerBot lastResumeAt → Task 6
  - §3.1 controller validation + verify endpoint + routes → Task 8
  - §3.2 lib/api.ts → Task 10
  - §3.2 EditMakerBotDialog → Task 11
  - §3.2 ReconciliationDialog → Task 12
  - §3.2 MakerTakerSimPanel → Task 13
  - §5 테스트 → Task 2/6/7 에 분산
  - §6 작업 순서 → Task 1~16 순서 일치
  - §7 리스크 → 검증 task (14) 의 수동 확인 항목으로 반영
- ✅ 타입 일관성: SpreadGateResult, ReconciliationReport, MakerTakerSimBot 필드 backend/frontend 일치
- ✅ 플레이스홀더 없음 — 모든 step 에 코드 포함
