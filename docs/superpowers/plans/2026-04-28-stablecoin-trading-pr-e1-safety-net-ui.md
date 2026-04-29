# PR E1 — Maker-Taker Safety Net + Admin UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PR D Canary 사고 후속으로, Maker-Taker 봇의 spec 재구현(PR E2) 전에 자동 안전장치(잔고 사전 체크 + 재고 한도 자동 일시정지) + Admin UI 토글(enabled/killSwitch)을 먼저 마련한다. 이 PR 단독으로는 거래 패턴을 변경하지 않으며, 봇 #1은 enabled=false 유지.

**Architecture:** 두 개의 순수 함수(`checkMakerPlacementBalance`, `shouldAutoPauseForMinBalance`)를 새로 만들고 `MakerTakerSimulatorAgent.handleLiveBot()`에서 호출한다. Prisma 스키마에 `minTakerBalance Int?` 필드를 추가한다. Frontend `MakerTakerSimPanel.tsx`에 enabled/killSwitch 토글 + minTakerBalance 입력을 추가한다. Live executor(`maker-taker-live-executor.ts`) 자체는 PR E1에서 변경하지 않는다.

**Tech Stack:** TypeScript, Prisma (MySQL), Express, Jest, React/Next.js, shadcn/ui

**선행 컨텍스트:**
- 사고 분석: `~/.claude/projects/D--ExpressProject-Grid-project/memory/project_pr_d_canary_observation_2026_04_28.md`
- Spec: `v0-grid-tranasction-backend/docs/superpowers/specs/2026-04-24-maker-taker-simulator-design.md`
- 기존 PR C plan: `v0-grid-tranasction-backend/docs/superpowers/plans/2026-04-26-stablecoin-trading-pr-c-maker-taker-live.md`

**중요 규칙:**
- 모든 명령/주석/커밋 메시지 한국어
- production DB destructive 쿼리 금지 (read-only만)
- Prisma migrate: `--create-only` 후 migration.sql `tail -20` 검사 필수 (CLI garbage 방지)
- production은 `migrate deploy`만 사용 (CI/배포가 자동 실행)
- 새 npm 패키지 설치 금지

---

## Task 1: 사전 운영 점검 + AWS 스냅샷

**목적:** PR E1 작업 전에 운영 환경 안전 상태 확인 + 사전 스냅샷.

**Files:**
- Modify: 없음 (운영 검증만)

- [ ] **Step 1: 백엔드 health + 6 에이전트 상태 확인**

```bash
curl -s http://54.180.188.8:3010/api/health
curl -s http://54.180.188.8:3010/api/agents | python -c "
import sys, json
for a in json.load(sys.stdin)['data']:
    print(f\"  - {a['name']}: status={a['status']}, errors={a['metrics']['errors']}\")"
```

기대: 6개 에이전트 모두 `status=running, errors=0`.

- [ ] **Step 2: maker bot #1 enabled=false 재확인**

```bash
ssh -i "C:/pem/54.180.188.8.pem" ubuntu@54.180.188.8 \
  "docker exec grid-bot node -e \"
const { stablecoinPrisma } = require('/app/dist/config/database');
stablecoinPrisma.makerTakerSimBot.findMany({
  select: {id: true, enabled: true, live: true, killSwitch: true}
}).then(b => console.log(JSON.stringify(b, null, 2))).then(() => process.exit(0));
\""
```

기대: `id=1, enabled=false, live=false`. 다른 봇이 있다면 모두 enabled 확인.

- [ ] **Step 3: AWS Lightsail 사전 스냅샷 생성**

```bash
aws lightsail create-relational-database-snapshot \
  --region ap-northeast-2 \
  --relational-database-name Grid-bot-DB-v2 \
  --relational-database-snapshot-name "pre-pr-e1-$(date -u +%Y%m%d-%H%M%S)"
```

상태 확인 (Available 될 때까지 ~5분):

```bash
aws lightsail get-relational-database-snapshots --region ap-northeast-2 \
  --query "relationalDatabaseSnapshots[?starts_with(name, 'pre-pr-e1-')].[name, state]" --output table
```

- [ ] **Step 4: 작업 브랜치 생성**

```bash
cd D:/ExpressProject/Grid_project/v0-grid-tranasction-backend
git checkout main
git pull origin main
git checkout -b feature/pr-e1-safety-net-ui
```

---

## Task 2: BalancePrecheck 순수 함수 (TDD)

**목적:** Maker placement 직전에 두 leg 자산을 모두 갖췄는지 검증하는 순수 함수. BalanceCache 결과 + bot config → ok/reason.

**Files:**
- Create: `v0-grid-tranasction-backend/src/services/maker-taker-balance-precheck.ts`
- Test: `v0-grid-tranasction-backend/__tests__/services/maker-taker-balance-precheck.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`v0-grid-tranasction-backend/__tests__/services/maker-taker-balance-precheck.test.ts` 신규:

```typescript
import { checkMakerPlacementBalance } from '../../src/services/maker-taker-balance-precheck';

describe('checkMakerPlacementBalance', () => {
  const baseArgs = {
    takerCoin: 'USDT',
    quantity: 10,
    makerOrderPrice: 1480,
    makerFeeBps: 5,
  };

  it('USDT/KRW 충분 → ok', () => {
    const result = checkMakerPlacementBalance({
      ...baseArgs,
      balances: { USDT: 100, KRW: 100_000 },
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('USDT 잔고 부족 (수량 미달) → fail', () => {
    const result = checkMakerPlacementBalance({
      ...baseArgs,
      balances: { USDT: 5, KRW: 100_000 },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('USDT balance 5');
    expect(result.reason).toContain('< required 10');
  });

  it('USDT key 자체 부재 → 0으로 간주, fail', () => {
    const result = checkMakerPlacementBalance({
      ...baseArgs,
      balances: { KRW: 100_000 },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('USDT balance 0');
  });

  it('KRW 잔고 부족 (maker fee 포함 미달) → fail', () => {
    // 필요 KRW = 1480 × 10 × 1.0005 = 14807.4
    const result = checkMakerPlacementBalance({
      ...baseArgs,
      balances: { USDT: 100, KRW: 14000 },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('KRW balance 14000');
  });

  it('KRW 정확히 fee 포함 임계값 → ok', () => {
    const required = 1480 * 10 * (1 + 5 / 10000); // 14807.4
    const result = checkMakerPlacementBalance({
      ...baseArgs,
      balances: { USDT: 100, KRW: required },
    });
    expect(result.ok).toBe(true);
  });

  it('takerCoin이 USDC인 경우 → USDC 잔고 검증', () => {
    const result = checkMakerPlacementBalance({
      ...baseArgs,
      takerCoin: 'USDC',
      balances: { USDC: 100, USDT: 0, KRW: 100_000 },
    });
    expect(result.ok).toBe(true);
  });

  it('USDT 검증이 KRW 검증보다 먼저 발동', () => {
    // 둘 다 부족 시 USDT 메시지 우선
    const result = checkMakerPlacementBalance({
      ...baseArgs,
      balances: { USDT: 0, KRW: 0 },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('USDT');
  });
});
```

- [ ] **Step 2: 테스트 실행 → FAIL 확인**

```bash
cd D:/ExpressProject/Grid_project/v0-grid-tranasction-backend
npx jest __tests__/services/maker-taker-balance-precheck.test.ts --no-coverage
```

기대: `Cannot find module '../../src/services/maker-taker-balance-precheck'` 또는 유사 에러로 FAIL.

- [ ] **Step 3: 구현 작성**

`v0-grid-tranasction-backend/src/services/maker-taker-balance-precheck.ts` 신규:

```typescript
/**
 * Maker placement 직전 잔고 사전 검증 (순수 함수).
 *
 * Maker leg(저유동성 코인 매수)와 Taker leg(고유동성 코인 매도) 양쪽에
 * 필요한 자산을 모두 갖췄는지 검증. BalanceCache 결과(5초 TTL)를 입력으로 받음.
 *
 * - Taker leg 사전 예약: takerCoin 잔고 ≥ quantity
 * - Maker leg 자금: KRW 잔고 ≥ makerOrderPrice × quantity × (1 + makerFeeBps/10000)
 *
 * 검증 순서: takerCoin → KRW (taker 자산 부족이 더 치명적이므로 먼저 차단).
 *
 * 주의: BalanceCache TTL 5초이므로 best-effort. 동시 인출 race는
 * minTakerBalance 자동 일시정지(maker-taker-min-balance-guard)로 보완.
 */

export interface BalancePrecheckArgs {
  takerCoin: string;
  quantity: number;
  makerOrderPrice: number;
  makerFeeBps: number;
  balances: Record<string, number>;
}

export interface BalancePrecheckResult {
  ok: boolean;
  reason?: string;
}

export function checkMakerPlacementBalance(
  args: BalancePrecheckArgs,
): BalancePrecheckResult {
  const { takerCoin, quantity, makerOrderPrice, makerFeeBps, balances } = args;

  // 1. Taker leg 자산 (사전 예약)
  const takerBalance = balances[takerCoin] ?? 0;
  if (takerBalance < quantity) {
    return {
      ok: false,
      reason: `${takerCoin} balance ${takerBalance} < required ${quantity} (taker leg reservation)`,
    };
  }

  // 2. Maker leg 자금 (수수료 포함)
  const krwBalance = balances.KRW ?? 0;
  const requiredKrw = makerOrderPrice * quantity * (1 + makerFeeBps / 10000);
  if (krwBalance < requiredKrw) {
    return {
      ok: false,
      reason: `KRW balance ${krwBalance.toFixed(0)} < required ${requiredKrw.toFixed(0)} (maker leg with fee)`,
    };
  }

  return { ok: true };
}
```

- [ ] **Step 4: 테스트 실행 → PASS 확인**

```bash
npx jest __tests__/services/maker-taker-balance-precheck.test.ts --no-coverage
```

기대: 7 passed.

- [ ] **Step 5: 타입 체크**

```bash
npx tsc --noEmit
```

기대: 0 errors.

- [ ] **Step 6: 커밋**

```bash
git add src/services/maker-taker-balance-precheck.ts __tests__/services/maker-taker-balance-precheck.test.ts
git commit -m "feat: maker-taker 사전 잔고 체크 순수 함수 추가"
```

---

## Task 3: MinBalanceGuard 순수 함수 (TDD)

**목적:** Taker leg 자산이 `minTakerBalance` 미만일 때 자동 일시정지 신호. 순수 함수로, agent에서 호출 후 DB 업데이트.

**Files:**
- Create: `v0-grid-tranasction-backend/src/services/maker-taker-min-balance-guard.ts`
- Test: `v0-grid-tranasction-backend/__tests__/services/maker-taker-min-balance-guard.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`v0-grid-tranasction-backend/__tests__/services/maker-taker-min-balance-guard.test.ts` 신규:

```typescript
import { shouldAutoPauseForMinBalance } from '../../src/services/maker-taker-min-balance-guard';

describe('shouldAutoPauseForMinBalance', () => {
  it('minTakerBalance null → 자동 일시정지 비활성', () => {
    const r = shouldAutoPauseForMinBalance({
      takerCoin: 'USDT',
      takerBalance: 0,
      minTakerBalance: null,
    });
    expect(r.autoPause).toBe(false);
  });

  it('잔고 ≥ minTakerBalance → noop', () => {
    const r = shouldAutoPauseForMinBalance({
      takerCoin: 'USDT',
      takerBalance: 50,
      minTakerBalance: 30,
    });
    expect(r.autoPause).toBe(false);
  });

  it('잔고 == minTakerBalance → noop (경계값 통과)', () => {
    const r = shouldAutoPauseForMinBalance({
      takerCoin: 'USDT',
      takerBalance: 30,
      minTakerBalance: 30,
    });
    expect(r.autoPause).toBe(false);
  });

  it('잔고 < minTakerBalance → autoPause + reason', () => {
    const r = shouldAutoPauseForMinBalance({
      takerCoin: 'USDT',
      takerBalance: 10,
      minTakerBalance: 30,
    });
    expect(r.autoPause).toBe(true);
    expect(r.reason).toContain('USDT balance 10');
    expect(r.reason).toContain('minTakerBalance 30');
  });

  it('잔고 0 + minTakerBalance 양수 → autoPause', () => {
    const r = shouldAutoPauseForMinBalance({
      takerCoin: 'USDT',
      takerBalance: 0,
      minTakerBalance: 5,
    });
    expect(r.autoPause).toBe(true);
  });

  it('minTakerBalance 0 → 모든 잔고에서 noop (의도된 비활성)', () => {
    const r = shouldAutoPauseForMinBalance({
      takerCoin: 'USDT',
      takerBalance: 0,
      minTakerBalance: 0,
    });
    // 잔고 0 < 0은 false이므로 noop
    expect(r.autoPause).toBe(false);
  });
});
```

- [ ] **Step 2: 테스트 실행 → FAIL 확인**

```bash
npx jest __tests__/services/maker-taker-min-balance-guard.test.ts --no-coverage
```

기대: 모듈 미발견 에러.

- [ ] **Step 3: 구현 작성**

`v0-grid-tranasction-backend/src/services/maker-taker-min-balance-guard.ts` 신규:

```typescript
/**
 * Taker leg 자산 잔고 < minTakerBalance 시 자동 일시정지 신호 (순수 함수).
 *
 * 봇 운영 중 USDT 재고가 일정 수준 이하로 떨어지면 자동 enabled=false 처리하여
 * 의도치 않은 거래 누적을 차단. 호출자(agent)가 결과를 받아 DB 업데이트.
 *
 * minTakerBalance가 null/undefined면 기능 비활성 (legacy 봇 호환).
 * 정확히 minTakerBalance와 같으면 noop (경계값은 안전한 쪽으로 판정).
 */

export interface MinBalanceGuardArgs {
  takerCoin: string;
  takerBalance: number;
  minTakerBalance: number | null | undefined;
}

export interface MinBalanceGuardResult {
  autoPause: boolean;
  reason?: string;
}

export function shouldAutoPauseForMinBalance(
  args: MinBalanceGuardArgs,
): MinBalanceGuardResult {
  const { takerCoin, takerBalance, minTakerBalance } = args;

  if (minTakerBalance === null || minTakerBalance === undefined) {
    return { autoPause: false };
  }

  if (takerBalance < minTakerBalance) {
    return {
      autoPause: true,
      reason: `${takerCoin} balance ${takerBalance} < minTakerBalance ${minTakerBalance}`,
    };
  }

  return { autoPause: false };
}
```

- [ ] **Step 4: 테스트 실행 → PASS 확인**

```bash
npx jest __tests__/services/maker-taker-min-balance-guard.test.ts --no-coverage
```

기대: 6 passed.

- [ ] **Step 5: 커밋**

```bash
git add src/services/maker-taker-min-balance-guard.ts __tests__/services/maker-taker-min-balance-guard.test.ts
git commit -m "feat: maker-taker minTakerBalance 자동 일시정지 가드 함수 추가"
```

---

## Task 4: Prisma 스키마 — minTakerBalance 필드 추가

**목적:** `MakerTakerSimBot` 테이블에 `minTakerBalance Int?` 필드 추가. nullable이므로 legacy 봇 호환.

**Files:**
- Modify: `v0-grid-tranasction-backend/prisma-stablecoin/schema.prisma`
- Create: `v0-grid-tranasction-backend/prisma-stablecoin/migrations/<timestamp>_add_min_taker_balance/migration.sql`

- [ ] **Step 1: 스키마 수정**

`v0-grid-tranasction-backend/prisma-stablecoin/schema.prisma`의 `MakerTakerSimBot` 모델에서 `minTakerBidKrw Int?` 라인 바로 아래에 추가:

```prisma
  minTakerBidKrw Int?
  minTakerBalance Int?  // 자동 일시정지 임계값. null=비활성. 잔고 < 이 값이면 enabled=false.
```

- [ ] **Step 2: 마이그레이션 SQL 생성 (--create-only로 review 후 적용)**

```bash
cd D:/ExpressProject/Grid_project/v0-grid-tranasction-backend
DATABASE_URL=$STABLECOIN_DATABASE_URL npx prisma migrate dev \
  --schema prisma-stablecoin/schema.prisma \
  --name add_min_taker_balance \
  --create-only
```

→ `prisma-stablecoin/migrations/<timestamp>_add_min_taker_balance/migration.sql` 생성됨.

- [ ] **Step 3: 생성된 SQL 검사 (CLI garbage 방지)**

```bash
ls prisma-stablecoin/migrations/ | tail -1
# 디렉토리 이름 복사
cat prisma-stablecoin/migrations/<timestamp>_add_min_taker_balance/migration.sql
tail -10 prisma-stablecoin/migrations/<timestamp>_add_min_taker_balance/migration.sql
```

기대 SQL 내용:
```sql
-- AlterTable
ALTER TABLE `maker_taker_sim_bots` ADD COLUMN `minTakerBalance` INTEGER NULL;
```

박스 문자(`┌`, `│`, `└` 등) 혼입 없는지 확인. 있으면 수동으로 깨끗한 SQL로 덮어쓰기.

- [ ] **Step 4: 로컬 dev DB(localhost:3308)에 적용 + Prisma client 생성**

```bash
DATABASE_URL=$STABLECOIN_DATABASE_URL npx prisma migrate deploy \
  --schema prisma-stablecoin/schema.prisma
DATABASE_URL=$STABLECOIN_DATABASE_URL npx prisma generate \
  --schema prisma-stablecoin/schema.prisma
```

기대: `Database migrations applied. 1 migration applied.` + `Generated Prisma Client`.

- [ ] **Step 5: 타입 체크**

```bash
npx tsc --noEmit
```

기대: 0 errors. (Prisma generate가 끝나면 `bot.minTakerBalance`가 타입에 노출됨.)

- [ ] **Step 6: 커밋**

```bash
git add prisma-stablecoin/schema.prisma prisma-stablecoin/migrations/
git commit -m "feat: MakerTakerSimBot에 minTakerBalance 필드 추가"
```

> **참고**: production 배포는 GitHub Actions가 `migrate deploy`로 자동 처리. 수동 실행 금지.

---

## Task 5: Backend Agent + Controller 통합

**목적:** `MakerTakerSimulatorAgent.handleLiveBot()`에서 잔고 가드 + pre-check 호출. `stablecoin-admin.controller.ts patchMakerBot`/`createMakerBot`에 `minTakerBalance` 검증 추가. `arb.service.ts`의 함수 시그니처에 `minTakerBalance` 추가.

**Files:**
- Modify: `v0-grid-tranasction-backend/src/agents/maker-taker-simulator-agent.ts`
- Modify: `v0-grid-tranasction-backend/src/controllers/stablecoin-admin.controller.ts`
- Modify: `v0-grid-tranasction-backend/src/services/stablecoin-arb.service.ts` (createMakerBot/patchMakerBot 시그니처)

- [ ] **Step 1: arb.service.ts의 createMakerBot 시그니처 확인 + 수정**

먼저 현재 시그니처를 확인:

```bash
grep -n "createMakerBot\|patchMakerBot" src/services/stablecoin-arb.service.ts
```

`createMakerBot` 함수의 인자 타입에 `minTakerBalance?: number | null` 추가:

`src/services/stablecoin-arb.service.ts` (대략적 위치 — 실제 코드와 매칭):

```typescript
export async function createMakerBot(args: {
  userId: number;
  makerCoin: string;
  takerCoin: string;
  bidOffsetKrw: number;
  quantity: number;
  maxPendingMs?: number;
  minTakerBidKrw?: number | null;
  minTakerBalance?: number | null;  // ← 추가
  makerFeeBps?: number;
  takerFeeBps?: number;
}) {
  return stablecoinPrisma.makerTakerSimBot.create({
    data: {
      userId: args.userId,
      makerCoin: args.makerCoin,
      takerCoin: args.takerCoin,
      bidOffsetKrw: args.bidOffsetKrw,
      quantity: args.quantity,
      maxPendingMs: args.maxPendingMs,
      minTakerBidKrw: args.minTakerBidKrw,
      minTakerBalance: args.minTakerBalance,  // ← 추가
      makerFeeBps: args.makerFeeBps,
      takerFeeBps: args.takerFeeBps,
    },
  });
}
```

`patchMakerBot`도 동일하게 patch 객체에 `minTakerBalance` 통과 보장 (구현이 `data: patch`로 spread하면 자동 통과 — controller에서 검증한 값만 patch 객체에 들어가므로).

- [ ] **Step 2: stablecoin-admin.controller.ts createMakerBot 검증 추가**

`v0-grid-tranasction-backend/src/controllers/stablecoin-admin.controller.ts` createMakerBot 함수에서 optional 검증 블록(`if (body.minTakerBidKrw !== undefined ...)` 다음 라인)에 추가:

```typescript
    if (body.minTakerBalance !== undefined && body.minTakerBalance !== null && (!Number.isInteger(body.minTakerBalance) || body.minTakerBalance < 0)) {
      throw new AppError('Invalid body: minTakerBalance must be non-negative integer or null', 400);
    }
```

그리고 `arbService.createMakerBot({...})` 호출 시 인자에 추가:

```typescript
      minTakerBalance: body.minTakerBalance,
```

- [ ] **Step 3: stablecoin-admin.controller.ts patchMakerBot 검증 추가**

같은 파일 patchMakerBot 함수에서 `minTakerBidKrw` 검증 블록 다음에 추가:

```typescript
    if (body.minTakerBalance !== undefined) {
      if (body.minTakerBalance !== null && (!Number.isInteger(body.minTakerBalance) || body.minTakerBalance < 0)) throw new AppError('Invalid body: minTakerBalance must be non-negative integer or null', 400);
      patch.minTakerBalance = body.minTakerBalance;
    }
```

- [ ] **Step 4: maker-taker-simulator-agent.ts handleLiveBot 통합**

`v0-grid-tranasction-backend/src/agents/maker-taker-simulator-agent.ts` 파일 상단 import 블록에 추가:

```typescript
import { checkMakerPlacementBalance } from '../services/maker-taker-balance-precheck';
import { shouldAutoPauseForMinBalance } from '../services/maker-taker-min-balance-guard';
```

`handleLiveBot` 함수 — 기존 코드의 `// 2. 클라이언트` 블록 **이전**(즉 1번 PENDING 조회 이후, client 생성 전)에 잔고 가드 + pre-check 로직 삽입. 그리고 `runLiveExecutor` 호출의 `preCheckOk: true` 하드코딩을 동적 변수로 교체.

전체 수정 후 `handleLiveBot` 코드:

```typescript
  private async handleLiveBot(
    bot: Awaited<ReturnType<typeof prisma.makerTakerSimBot.findMany>>[number],
    books: ReadonlyMap<string, OrderbookTop>,
  ): Promise<void> {
    if (bot.killSwitch) return;

    // 1. PENDING 조회 (live=true 트레이드만)
    const pending = await prisma.makerTakerSimTrade.findFirst({
      where: { botId: bot.id, status: 'PENDING', live: true },
      orderBy: { createdAt: 'desc' },
    });

    const pendingInput: PendingTradeInput | null = pending
      ? {
          id: pending.id,
          status: pending.status,
          makerOrderUuid: pending.makerOrderUuid,
          makerOrderPrice: pending.makerOrderPrice,
          createdAt: pending.createdAt,
          notes: pending.notes,
        }
      : null;

    // 2. 클라이언트 (with credential cache)
    let upbitClient;
    try {
      upbitClient = await this.getClientFor(bot.userId);
    } catch (err: any) {
      console.error(
        `[MakerTakerSimulatorAgent] bot ${bot.id} credential missing:`,
        err.message,
      );
      return;
    }

    // 3. 잔고 가드 + pre-check (CASE A — pending null일 때만)
    let preCheckOk = true;
    if (pending === null) {
      let balances: Record<string, number>;
      try {
        balances = await upbitClient.cache.get();
      } catch (err: any) {
        console.error(
          `[MakerTakerSimulatorAgent] bot ${bot.id} balance fetch 실패:`,
          err.message,
        );
        return;
      }

      // (a) minTakerBalance 자동 일시정지
      const guard = shouldAutoPauseForMinBalance({
        takerCoin: bot.takerCoin,
        takerBalance: balances[bot.takerCoin] ?? 0,
        minTakerBalance: bot.minTakerBalance,
      });
      if (guard.autoPause) {
        await prisma.makerTakerSimBot.update({
          where: { id: bot.id },
          data: { enabled: false },
        });
        console.warn(
          `[MakerTakerSimulatorAgent] bot ${bot.id} 자동 일시정지 (enabled=false): ${guard.reason}`,
        );
        return;
      }

      // (b) 사전 잔고 체크 — maker placement 직전
      const makerBook = books.get(`KRW-${bot.makerCoin}`);
      if (!makerBook) {
        // executor에서도 noop 처리되지만 여기서 일찍 return
        return;
      }
      const makerOrderPrice = makerBook.bid.price + bot.bidOffsetKrw;
      const precheck = checkMakerPlacementBalance({
        takerCoin: bot.takerCoin,
        quantity: Number(bot.quantity),
        makerOrderPrice,
        makerFeeBps: bot.makerFeeBps,
        balances,
      });
      if (!precheck.ok) {
        console.log(
          `[MakerTakerSimulatorAgent] bot ${bot.id} pre-check 실패: ${precheck.reason}`,
        );
        preCheckOk = false;
      }
    }

    const client: OrderClient = {
      placeLimit: (m, s, p) => upbitClient.upbit.placeLimitOrder(m, s, p),
      placeBestIoc: (m, s, p) => upbitClient.upbit.placeBestIoc(m, s, p),
      getOrder: (uuid) => upbitClient.upbit.getOrder(uuid),
      cancelOrder: (uuid) => upbitClient.upbit.cancelOrder(uuid),
    };

    const liveBot: LiveBotInput = {
      id: bot.id,
      userId: bot.userId,
      makerCoin: bot.makerCoin,
      takerCoin: bot.takerCoin,
      bidOffsetKrw: bot.bidOffsetKrw,
      quantity: Number(bot.quantity),
      maxPendingMs: bot.maxPendingMs,
      killSwitch: bot.killSwitch,
    };

    const result = await runLiveExecutor({
      bot: liveBot,
      pending: pendingInput,
      books,
      client,
      isLocked: () => tradingLock.isLocked(),
      preCheckOk,
    });

    // 거래 직후 잔고 캐시 invalidate (다음 evaluate에서 fresh)
    if (
      result.kind === 'placed' ||
      result.kind === 'filled' ||
      result.kind === 'rolled_back' ||
      result.kind === 'partial_hold'
    ) {
      upbitClient.cache.invalidate();
    }

    // 4. 결과별 DB write
    await this.persistLiveResult(bot, pending, result);
  }
```

- [ ] **Step 5: 타입 체크 + 단위 테스트 전체 실행**

```bash
npx tsc --noEmit
npx jest __tests__/services/maker-taker-balance-precheck.test.ts \
         __tests__/services/maker-taker-min-balance-guard.test.ts \
         __tests__/services/maker-taker-live-executor.test.ts \
         __tests__/services/maker-taker-simulator.service.test.ts \
         __tests__/controllers/stablecoin-admin.controller.test.ts \
         --no-coverage
```

기대: 0 errors + all passed.

- [ ] **Step 6: 빌드 확인**

```bash
npm run build
```

기대: 빌드 성공, `dist/` 갱신.

- [ ] **Step 7: 커밋**

```bash
git add src/agents/maker-taker-simulator-agent.ts \
        src/controllers/stablecoin-admin.controller.ts \
        src/services/stablecoin-arb.service.ts
git commit -m "feat: maker-taker 잔고 사전 체크 + minTakerBalance 자동 일시정지 통합"
```

---

## Task 6: Frontend 타입 + UI 토글 + minTakerBalance 입력

**목적:** `MakerTakerSimBot` 타입에 `minTakerBalance` 추가. `MakerTakerSimPanel.tsx` 봇 카드에 enabled/killSwitch 토글 + 생성 다이얼로그에 minTakerBalance 입력.

**Files:**
- Modify: `v0-grid-transaction-frontend/lib/api.ts`
- Modify: `v0-grid-transaction-frontend/app/admin/stablecoin/_components/MakerTakerSimPanel.tsx`

- [ ] **Step 1: lib/api.ts 타입 + body 업데이트**

`v0-grid-transaction-frontend/lib/api.ts` `MakerTakerSimBot` 인터페이스에 `minTakerBalance` 추가 (기존 `minTakerBidKrw?: number | null` 라인 근처):

```typescript
export interface MakerTakerSimBot {
  id: number;
  userId: number;
  makerCoin: string;
  takerCoin: string;
  bidOffsetKrw: number;
  // ... 기존 필드 유지 ...
  minTakerBidKrw?: number | null;
  minTakerBalance?: number | null;  // ← 추가
  enabled: boolean;
  killSwitch: boolean;
  live: boolean;
  // ... 나머지 ...
}
```

`CreateMakerBotBody` 타입에 추가:

```typescript
export type CreateMakerBotBody = {
  makerCoin: string;
  takerCoin: string;
  bidOffsetKrw: number;
  quantity: number;
  maxPendingMs?: number;
  minTakerBidKrw?: number | null;
  minTakerBalance?: number | null;  // ← 추가
  makerFeeBps?: number;
  takerFeeBps?: number;
};
```

`PatchMakerBotBody` 타입에 추가 (Partial<{...}> 안에):

```typescript
export type PatchMakerBotBody = Partial<{
  enabled: boolean;
  killSwitch: boolean;
  live: boolean;
  bidOffsetKrw: number;
  quantity: number;
  maxPendingMs: number;
  minTakerBidKrw: number | null;
  minTakerBalance: number | null;  // ← 추가
  makerFeeBps: number;
  takerFeeBps: number;
}>;
```

- [ ] **Step 2: MakerTakerSimPanel.tsx 토글 + minTakerBalance UI**

`v0-grid-transaction-frontend/app/admin/stablecoin/_components/MakerTakerSimPanel.tsx` 변경.

(a) `CreateMakerBotDialog`의 form state + UI에 `minTakerBalance` 입력 추가:

```tsx
function CreateMakerBotDialog({
  onSubmit,
  submitting,
  error,
}: {
  onSubmit: (form: { makerCoin: string; takerCoin: string; bidOffsetKrw: number; quantity: number; minTakerBalance: number | null }) => void
  submitting: boolean
  error: string | null
}) {
  const [makerCoin, setMakerCoin] = useState(STABLECOINS[0])
  const [takerCoin, setTakerCoin] = useState(STABLECOINS[1])
  const [bidOffsetKrw, setBidOffsetKrw] = useState("1")
  const [quantity, setQuantity] = useState("10")
  const [minTakerBalance, setMinTakerBalance] = useState("")  // 빈 문자열=null

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSubmit({
      makerCoin,
      takerCoin,
      bidOffsetKrw: Number(bidOffsetKrw),
      quantity: Number(quantity),
      minTakerBalance: minTakerBalance.trim() === "" ? null : Number(minTakerBalance),
    })
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>봇 추가</DialogTitle>
      </DialogHeader>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* 기존 makerCoin/takerCoin/bidOffsetKrw/quantity 필드 유지 */}
        <div className="space-y-1">
          <Label>Maker 코인</Label>
          <select className="w-full border rounded px-2 py-1 text-sm" value={makerCoin} onChange={(e) => setMakerCoin(e.target.value)}>
            {STABLECOINS.map((c) => (<option key={c} value={c}>{c}</option>))}
          </select>
        </div>
        <div className="space-y-1">
          <Label>Taker 코인</Label>
          <select className="w-full border rounded px-2 py-1 text-sm" value={takerCoin} onChange={(e) => setTakerCoin(e.target.value)}>
            {STABLECOINS.map((c) => (<option key={c} value={c}>{c}</option>))}
          </select>
        </div>
        <div className="space-y-1">
          <Label>Bid Offset (KRW)</Label>
          <Input type="number" min="0" step="1" value={bidOffsetKrw} onChange={(e) => setBidOffsetKrw(e.target.value)} required />
        </div>
        <div className="space-y-1">
          <Label>수량 (Quantity)</Label>
          <Input type="number" min="1" step="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
        </div>
        <div className="space-y-1">
          <Label>최소 Taker 잔고 (자동 일시정지, 비워두면 비활성)</Label>
          <Input
            type="number"
            min="0"
            step="1"
            value={minTakerBalance}
            onChange={(e) => setMinTakerBalance(e.target.value)}
            placeholder="예: 5"
          />
        </div>
        {error && (
          <div className="text-red-500 text-sm flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />{error}
          </div>
        )}
        <DialogFooter>
          <Button type="submit" disabled={submitting || makerCoin === takerCoin}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            생성
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}
```

(b) `MakerTakerSimPanel`의 `handleCreate` form 타입 업데이트:

```tsx
  const handleCreate = async (form: {
    makerCoin: string
    takerCoin: string
    bidOffsetKrw: number
    quantity: number
    minTakerBalance: number | null
  }) => {
    setSubmitting(true)
    setCrudError(null)
    try {
      await createMakerBot(form)
      setCreateOpen(false)
      refreshBots()
    } catch (e) {
      setCrudError("봇 생성 실패: " + (e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }
```

(c) `handleToggleEnabled` + `handleToggleKillSwitch` 핸들러 추가 (`handleToggleLive` 함수 옆):

```tsx
  const handleToggleEnabled = async (bot: MakerTakerSimBot) => {
    try {
      await patchMakerBot(bot.id, { enabled: !bot.enabled })
      refreshBots()
    } catch (e) {
      setCrudError("enabled 토글 실패: " + (e as Error).message)
    }
  }

  const handleToggleKillSwitch = async (bot: MakerTakerSimBot) => {
    if (!bot.killSwitch) {
      const ok = confirm(
        `💀 ${bot.makerCoin}-${bot.takerCoin} 봇 killSwitch 활성화?\n` +
        `즉시 모든 거래 정지됩니다.`
      )
      if (!ok) return
    }
    try {
      await patchMakerBot(bot.id, { killSwitch: !bot.killSwitch })
      refreshBots()
    } catch (e) {
      setCrudError("killSwitch 토글 실패: " + (e as Error).message)
    }
  }
```

(d) bot 카드 UI에서 토글 버튼 추가 (기존 live 토글 옆):

기존 `bots.map((bot) => ... <div className="flex gap-2"> ...)` 부분의 `<div className="flex gap-2">` 내부를 다음으로 교체:

```tsx
                <div className="flex gap-2 flex-wrap">
                  <Button
                    size="sm"
                    variant={bot.enabled ? "outline" : "secondary"}
                    onClick={() => handleToggleEnabled(bot)}
                    title={bot.enabled ? "Stop bot (enabled=false)" : "Resume bot (enabled=true)"}
                  >
                    {bot.enabled ? "🛑 Stop" : "▶ Resume"}
                  </Button>
                  <Button
                    size="sm"
                    variant={bot.killSwitch ? "destructive" : "outline"}
                    onClick={() => handleToggleKillSwitch(bot)}
                    title="Kill switch — 즉시 모든 거래 정지"
                  >
                    💀 {bot.killSwitch ? "Kill ON" : "Kill"}
                  </Button>
                  <Button
                    size="sm"
                    variant={bot.live ? "default" : "destructive"}
                    onClick={() => handleToggleLive(bot)}
                  >
                    {bot.live ? "live 끄기" : "live 켜기"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => handleDelete(bot)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
```

(e) 봇 카드의 메타 정보 라인에 minTakerBalance 표시 추가 (기존 `qty=...` 라인을 다음으로 교체):

```tsx
                  <div className="text-xs text-muted-foreground">
                    qty={bot.quantity ?? "—"} / offset={bot.bidOffsetKrw} / 수수료 maker={bot.makerFeeBps}bp taker={bot.takerFeeBps}bp
                    {bot.minTakerBalance != null && ` / 최소잔고=${bot.minTakerBalance} ${bot.takerCoin}`}
                  </div>
```

- [ ] **Step 3: 빌드 확인**

```bash
cd D:/ExpressProject/Grid_project/v0-grid-transaction-frontend
npm run build
```

기대: 빌드 성공, 0 errors.

- [ ] **Step 4: 린트 확인**

```bash
npm run lint
```

기대: 0 errors.

- [ ] **Step 5: 커밋**

```bash
cd D:/ExpressProject/Grid_project/v0-grid-transaction-frontend
git add lib/api.ts app/admin/stablecoin/_components/MakerTakerSimPanel.tsx
git commit -m "feat: maker-taker 봇 enabled/killSwitch 토글 + minTakerBalance UI 추가"
```

---

## Task 7: 통합 검증 + PR + 머지 + 배포 + 운영 모니터링

**목적:** 전체 빌드/테스트 → 양쪽 PR 작성 + 머지 → 배포 후 운영 점검.

**Files:** 없음 (검증/배포 단계)

- [ ] **Step 1: 백엔드 전체 jest 실행**

```bash
cd D:/ExpressProject/Grid_project/v0-grid-tranasction-backend
npx jest --no-coverage
```

기대: all passed (기존 테스트 + 신규 13개 모두 통과).

- [ ] **Step 2: 백엔드 push + PR**

```bash
git push -u origin feature/pr-e1-safety-net-ui
gh pr create --title "feat: PR E1 — maker-taker 안전장치 + Admin UI 토글" --body "$(cat <<'EOF'
## Summary

PR D Canary 사고(2026-04-28) 후속 안전장치 + Admin UI 토글. 거래 패턴은 변경하지 않음(PR E2에서 처리).

- 사전 잔고 체크 (USDT/KRW) — `checkMakerPlacementBalance` 순수 함수
- minTakerBalance 자동 일시정지 — `shouldAutoPauseForMinBalance` 순수 함수
- Prisma 스키마: `MakerTakerSimBot.minTakerBalance Int?` 추가
- Admin UI: enabled/killSwitch 토글 버튼 + minTakerBalance 입력

## 안전성

- 봇 #1 enabled=false 유지. live 거래 영향 없음.
- AWS 사전 스냅샷: `pre-pr-e1-...` 생성됨.
- live executor 코드 자체는 PR E2까지 변경 없음.

## Test plan

- [ ] jest 단위 테스트 — `maker-taker-balance-precheck.test.ts` (7개), `maker-taker-min-balance-guard.test.ts` (6개) 모두 통과
- [ ] 기존 `maker-taker-live-executor.test.ts`/`maker-taker-simulator.service.test.ts` 영향 없는지 회귀 통과
- [ ] `npx tsc --noEmit` 0 errors
- [ ] 배포 후 6개 에이전트 errors=0 확인
- [ ] Admin UI에서 봇 #1에 minTakerBalance 설정 테스트 (DB row 확인)
- [ ] Admin UI 토글 동작 테스트 (enabled on/off, killSwitch on/off)
EOF
)"
```

- [ ] **Step 3: 프론트엔드 push + PR**

```bash
cd D:/ExpressProject/Grid_project/v0-grid-transaction-frontend
git push -u origin feature/pr-e1-safety-net-ui
gh pr create --title "feat: maker-taker 봇 enabled/killSwitch 토글 + minTakerBalance UI" --body "$(cat <<'EOF'
## Summary

백엔드 PR E1과 짝. Admin UI에 maker-taker 봇의 enabled/killSwitch 토글 추가 + 봇 생성 시 minTakerBalance 입력.

## Test plan

- [ ] `npm run build` 성공
- [ ] `npm run lint` 0 errors
- [ ] 배포 후 /admin/stablecoin 페이지에서 토글 동작 확인
EOF
)"
```

- [ ] **Step 4: 사용자 승인 + 머지**

사용자가 양쪽 PR 모두 검토 후 승인. 백엔드 PR을 먼저 머지(스키마 변경이 먼저 production 적용돼야 frontend에서 minTakerBalance 입력 시 500 에러 안 남).

```bash
# 백엔드 먼저 머지 (사용자 승인 후)
gh pr merge <백엔드 PR 번호> --merge --delete-branch
# 배포 완료 대기 (~3분)
gh run list --limit 1
# 배포 성공 확인 후 프론트엔드 머지
gh pr merge <프론트엔드 PR 번호> --merge --delete-branch
```

- [ ] **Step 5: 배포 후 운영 점검**

```bash
# 백엔드 health
curl -s http://54.180.188.8:3010/api/health

# 6개 에이전트 errors=0 확인
curl -s http://54.180.188.8:3010/api/agents | python -c "
import sys, json
for a in json.load(sys.stdin)['data']:
    print(f\"  - {a['name']}: status={a['status']}, errors={a['metrics']['errors']}\")"

# DB 컬럼 확인
ssh -i "C:/pem/54.180.188.8.pem" ubuntu@54.180.188.8 \
  "docker exec grid-bot node -e \"
const { stablecoinPrisma } = require('/app/dist/config/database');
stablecoinPrisma.\$queryRaw\`SHOW COLUMNS FROM maker_taker_sim_bots LIKE 'minTakerBalance'\`.then(r => console.log(JSON.stringify(r, null, 2))).then(() => process.exit(0));
\""
```

기대: 6개 errors=0 + `Field: minTakerBalance, Type: int(11), Null: YES`.

- [ ] **Step 6: Admin UI 토글 smoke test (브라우저)**

`/admin/stablecoin` 페이지에서:
1. 봇 #1의 "🛑 Stop" 버튼이 보이는지(enabled=false 상태이므로 "▶ Resume"으로 표시)
2. "💀 Kill" 버튼 보이는지
3. 봇 추가 다이얼로그에서 "최소 Taker 잔고" 필드 보이는지

DB로 검증 (동작 확인용 — 실제 토글은 운영 후 별도):
```bash
ssh -i "C:/pem/54.180.188.8.pem" ubuntu@54.180.188.8 \
  "docker exec grid-bot node -e \"
const { stablecoinPrisma } = require('/app/dist/config/database');
stablecoinPrisma.makerTakerSimBot.findMany({
  select: {id: true, enabled: true, killSwitch: true, minTakerBalance: true}
}).then(r => console.log(JSON.stringify(r, null, 2))).then(() => process.exit(0));
\""
```

- [ ] **Step 7: 메모리 갱신**

다음 세션이 PR E2를 빠르게 시작할 수 있도록 메모리 작성:

`~/.claude/projects/D--ExpressProject-Grid-project/memory/project_pr_e1_complete.md` 신규 (요지만):
- PR E1 머지 시각, 신규 컬럼/함수 위치, 봇 #1 상태
- 다음 PR E2 task: `live executor spec § 13-15 재구현` + `leg-2 false positive`
- PR E2 시작 전 USDT 잔고 ≥ 10 확인 필요 (advisor 권고)

`MEMORY.md` 인덱스에 추가.

---

## 세션 종료 체크리스트 (전 task 완료 후)

- [ ] 백엔드 PR + 프론트 PR 모두 머지됨
- [ ] 6 에이전트 errors=0
- [ ] DB 컬럼 적용됨
- [ ] 봇 #1 enabled=false 유지
- [ ] 메모리 갱신됨
- [ ] PR E2 작업 사전조건 정리됨 (USDT 잔고, fallback 정책 결정)

## 폴백/롤백

PR E1 머지 후 문제 발생 시:
1. `gh pr revert <백엔드 PR>` → 코드 롤백
2. minTakerBalance 컬럼은 nullable이라 데이터 손실 없음 (코드만 롤백하면 됨)
3. AWS 사전 스냅샷(`pre-pr-e1-...`)은 6일 보존 — DB 자체 롤백은 거의 불필요

## 주의 사항 모음

- **Prisma migrate dev CLI garbage**: `--create-only` 후 `tail -10 migration.sql` 검사 (세션 7~8 패턴)
- **production 컨테이너에 ts-node 없음**: dist만 있음. 일회성 스크립트는 `node /app/dist/...` 사용
- **메인 process module-state 격리**: 별도 process로 require하면 module-level Map/Set 격리됨 — 검증은 docker exec grid-bot node로
- **자동 sync 훅**: ~/.claude 작업 중 untracked 파일 같이 커밋될 수 있음. 민감 작업 전 `git status` 확인
- **로컬 .env**: DATABASE_URL이 production 가리키지 않도록 주의
