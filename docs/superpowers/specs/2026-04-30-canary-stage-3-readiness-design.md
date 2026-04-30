# Canary Stage 3 사전 정비 설계서 (PR H)

> 작성: 2026-04-30
> 상태: **초안 — 사용자 승인 후 writing-plans 로 구현 plan 작성**
> 출처: Canary Stage 2 종료 메모리(`project_canary_stage_2_complete_2026_04_30.md`) 권고 4가지

## 1. 목표 / 범위

### 1.1 목표

Canary Stage 2 종료(2026-04-30) 학습 4가지 후속 액션을 한 라운드에 묶어 Canary Stage 3 가동 준비 완료:

1. **수익성 gating** — `bestAsk - bestBid >= 12 KRW` 조건부 placement (수수료 > spread 손실 방지)
2. **bidOffsetKrw UI 추가** — DB UPDATE 우회 패턴 정식화 (Edit Dialog)
3. **T_start 별도 저장** — `bot.updatedAt` 의존 제거 (lastResumeAt 컬럼)
4. **거래소 done order 검증 절차** — PR D 수준의 잔고 정합 검증 자동화 (Admin UI 버튼)

### 1.2 PR 구조

단일 PR (`PR H — canary stage 3 readiness`). 백엔드/프론트 각각 별도 레포라 PR 2개로 push (PR E1과 동일 분할). 머지 순서: **백엔드 먼저 + Lightsail 배포 완료 후 프론트엔드** (R9 참조).

### 1.3 Out of Scope

- 다중 봇 병렬 canary (USD1/USDT 등 다른 페어) — stage 4
- Upbit `getOrdersByMarket` pagination/throttle — 1봇 24h 규모는 단일 페이지로 충분, 필요 시 stage 4
- canary 가동 자체 — 이번 PR은 정비만, 가동은 별도 plan

## 2. 데이터 모델 변경

```prisma
model MakerTakerSimBot {
  // ... existing 필드 유지
  minSpreadKrw  Int       @default(12)   // NEW: (bestAsk - bestBid) >= 이 값일 때만 placement
  lastResumeAt  DateTime?                // NEW: enabled false→true 전환 시각 (canary T_start)
}
```

마이그레이션 이름: `20260430_add_canary_stage_3_fields`

### 2.1 기존 row 영향

- 봇 #1: `minSpreadKrw=12` (default), `lastResumeAt=NULL` (다음 수동 resume 에서 채워짐)
- 다른 봇 없음

### 2.2 lastResumeAt 갱신 규칙

`patchMakerBot` 서비스에서:

- `enabled: false → true` 전환만 트리거
- `bidOffsetKrw`, `minSpreadKrw`, `quantity` 등 다른 필드 변경에는 갱신 X (메모리에서 지적된 함정 회피)
- `enabled: true → false` 변경에도 갱신 X (resume 시점만 캡쳐)
- 구현: PATCH 시 기존 row 조회 → `prevEnabled === false && patch.enabled === true` 면 `patch.lastResumeAt = new Date()` 추가

### 2.3 minSpreadKrw 사용 위치

- live executor CASE A 진입 직전 (placement 결정)
- simulator-agent 의 sim 분기 PENDING null 분기 (sim/live 정합성 — 둘 다 게이팅)
- 측정 기준: `KRW-${makerCoin}` orderbook 의 `bestAsk - bestBid`
- minSpreadKrw=0 → 게이팅 비활성 (스킵)

## 3. 컴포넌트 / 함수 분해

### 3.1 백엔드 (`v0-grid-tranasction-backend/`)

#### 신규 파일

**`src/services/maker-taker-spread-gate.ts`** — 순수 함수

```ts
import type { OrderbookTop } from './upbit-price-manager';

export interface SpreadGateResult {
  ok: boolean;
  spreadKrw: number;
  reason?: string;
}

export function isSpreadProfitable(
  makerBook: OrderbookTop,
  minSpreadKrw: number,
): SpreadGateResult;
```

DB I/O 없음, mock 단순. live executor + sim 양쪽에서 호출.

**`src/services/maker-taker-asset-reconciliation.service.ts`** — 검증 로직

```ts
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
    pageTruncated: boolean; // count === 100 일 때 true (R3)
  };
  diff: {
    makerCoinDiff: string;
    takerCoinDiff: string;
  };
  isReconciled: boolean;
}

export async function reconcileBotAssets(params: {
  botId: number;
  userId: number;
}): Promise<ReconciliationReport>;
```

#### 수정 파일

- **`src/services/maker-taker-live-executor.ts`** — `LiveBotInput` 에 `minSpreadKrw: number` 추가만. 게이팅 자체는 호출자(agent)가 결정해 `preCheckOk` 에 합산.
- **`src/agents/maker-taker-simulator-agent.ts`**
  - `processBot` sim 분기 PENDING null + `isSpreadProfitable` 미달 → 즉시 return (row 미생성)
  - `handleLiveBot` PENDING null → `isSpreadProfitable` 호출 → `preCheckOk` 와 합산
  - `liveBot` 구성 시 `minSpreadKrw: bot.minSpreadKrw` 전달
- **`src/controllers/stablecoin-admin.controller.ts`**
  - `createMakerBot` / `patchMakerBot` 에 `minSpreadKrw` 검증 (Int, >=0) 추가
  - 신규 `verifyMakerBotReconciliation` (POST `/maker-bots/:id/verify-reconciliation`)
- **`src/services/stablecoin-arb.service.ts`** — `patchMakerBot(id, userId, patch)` 변경
  - 현재: `updateMany({ where: {id, userId}, data: patch })` → ownership + update 한 번에 처리하지만 prev row 미보유
  - 변경: `findFirst({ where: {id, userId} })` 로 prev 먼저 조회 → ownership 검증 → `prev.enabled === false && patch.enabled === true` 면 `patch.lastResumeAt = new Date()` 추가 → `update({ where: {id}, data: patch })`
  - findFirst↔update 간 race 가능성은 admin-only mutation 이라 수용 (tx 미사용)
- **`src/routes/stablecoin-admin.ts`**
  - `router.post('/maker-bots/:id/verify-reconciliation', verifyMakerBotReconciliation)` 추가
- **`prisma-stablecoin/schema.prisma`** — §2 의 두 컬럼 추가

### 3.2 프론트엔드 (`v0-grid-transaction-frontend/`)

#### 신규 파일

- **`app/admin/stablecoin/_components/EditMakerBotDialog.tsx`**
  - props: `{ bot: MakerTakerSimBot; onSubmit; submitting; error }`
  - 필드: bidOffsetKrw, quantity, minSpreadKrw, minTakerBalance, makerFeeBps, takerFeeBps
  - 기존 값으로 초기화, 변경된 필드만 PATCH (제출 시 비교)
- **`app/admin/stablecoin/_components/ReconciliationDialog.tsx`**
  - props: `{ open; onOpenChange; report: ReconciliationReport | null; loading; error }`
  - 표시: sinceUtc, bot 합계 vs exchange 합계, diff(highlight if non-zero), isReconciled 배지, sinceSource='createdAt' 일 때 ⚠️ 경고

#### 수정 파일

- **`app/admin/stablecoin/_components/MakerTakerSimPanel.tsx`**
  - 봇 카드에 `✏️ 편집` 버튼 → EditMakerBotDialog 열기
  - 봇 카드에 `🔍 검증` 버튼 → verifyMakerBotReconciliation 호출 → ReconciliationDialog
  - 카드 메타에 `Resume since: ${lastResumeAt|"—"}` 표시
- **`lib/api.ts`**
  - `MakerTakerSimBot` 타입에 `minSpreadKrw: number; lastResumeAt: string | null` 추가
  - `PatchMakerBotBody` 에 `minSpreadKrw?: number` 추가
  - 신규 `verifyMakerBotReconciliation(id: number): Promise<ReconciliationReport>`
  - 신규 `ReconciliationReport` 타입

## 4. 데이터 흐름

### 4.1 수익성 gating (live + sim 공통)

```
upbit orderbook tick
  → MakerTakerSimulatorAgent.evaluate()
    → 활성 봇 loop
      → processBot(bot, books)
        ├─ live=false 분기:
        │   ├─ pending 있으면 → 기존 shouldFill 흐름 (변경 없음)
        │   └─ pending 없으면:
        │       ├─ isSpreadProfitable(makerBook, bot.minSpreadKrw)
        │       │   └─ false → return (row 미생성, log)
        │       └─ true → 기존 PENDING row create
        └─ live=true 분기 (handleLiveBot):
            ├─ pending 있으면 → 기존 polling 흐름 (변경 없음)
            └─ pending 없으면:
                ├─ minBalanceGuard 검사 (기존)
                ├─ balance precheck (기존)
                ├─ isSpreadProfitable(makerBook, bot.minSpreadKrw)  ← NEW
                │   └─ false → preCheckOk=false (또는 별도 noop reason)
                └─ live executor 호출 → CASE A 에서 preCheckOk=false → noop
```

**구현 결정**: spread 게이팅을 live executor 내부에 넣지 않고 **agent 에서 결정해 `preCheckOk` 에 합산**. 이유: live executor 는 spec § 2 정합 검증된 순수 함수 유지. 정책 로직은 agent 에서 결정.

### 4.2 lastResumeAt 갱신

```
PATCH /api/admin/stablecoin/maker-bots/:id
  body: { enabled: true, ... }
    → controller.patchMakerBot
      → service.patchMakerBot(id, userId, patch)
        ├─ const existing = findUnique(id)
        ├─ ownership check (existing.userId === userId)
        ├─ if (existing.enabled === false && patch.enabled === true)
        │     patch.lastResumeAt = new Date()
        └─ prisma.update({ where: {id}, data: patch })
```

### 4.3 reconcileBotAssets 검증 흐름

```
사용자가 봇 카드 "🔍 검증" 클릭
  → POST /api/admin/stablecoin/maker-bots/:id/verify-reconciliation
    → controller.verifyMakerBotReconciliation
      → service.reconcileBotAssets({ botId, userId })
        ├─ bot = stablecoinPrisma.makerTakerSimBot.findUnique
        ├─ ownership check
        ├─ since = bot.lastResumeAt ?? bot.createdAt
        ├─ botFilledTrades = stablecoinPrisma.makerTakerSimTrade.findMany({
        │     where: { botId, status: 'FILLED', live: true, makerFilledAt: { gte: since } }
        │   })
        ├─ pendingCount = stablecoinPrisma.makerTakerSimTrade.count({
        │     where: { botId, status: 'PENDING', live: true }
        │   })
        ├─ botMakerSumQty = sum(filledQty)  // bot 매수 USDS
        ├─ botTakerSumQty = same            // bot 매도 USDT (동량)
        ├─ Upbit credentials 로 client 생성
        ├─ makerDoneOrders = upbit.getOrdersByMarket(`KRW-${makerCoin}`, 'done')
        │     .filter(o => o.side === 'bid' && new Date(o.created_at) >= since)
        ├─ takerDoneOrders = upbit.getOrdersByMarket(`KRW-${takerCoin}`, 'done')
        │     .filter(o => o.side === 'ask' && new Date(o.created_at) >= since)
        ├─ 합계 계산: exchangeMakerBidQty / exchangeTakerAskQty
        ├─ diff: bot - exchange (둘 다)
        └─ return ReconciliationReport
      ← UI: ReconciliationDialog 에 표시 (diff 0 이면 ✅, 아니면 ⚠️)
```

## 5. 테스트 전략 (TDD)

### 5.1 백엔드 단위 테스트

**신규**:

1. `src/services/__tests__/maker-taker-spread-gate.test.ts`
   - `bestAsk - bestBid < minSpreadKrw` → `{ ok: false, reason: 'spread too narrow' }`
   - `bestAsk - bestBid === minSpreadKrw` → `{ ok: true }` (경계값)
   - `bestAsk - bestBid > minSpreadKrw` → `{ ok: true }`
   - `minSpreadKrw === 0` → 항상 `{ ok: true }` (게이팅 비활성)

2. `src/services/__tests__/maker-taker-asset-reconciliation.service.test.ts`
   - mock prisma + mock UpbitService
   - filled 0건 + done 0건 → `isReconciled=true, diff=0`
   - filled 1건(qty=10) + done 1건(qty=10) → `isReconciled=true`
   - filled 1건(qty=10) + done 0건 → `isReconciled=false, makerCoinDiff=10`
   - lastResumeAt=null → fallback createdAt 사용, `sinceSource='createdAt'`
   - lastResumeAt 이전 done order 필터링 → 결과에서 제외
   - done order count===100 → `pageTruncated=true`

**기존 수정**:

3. `src/services/__tests__/maker-taker-live-executor.test.ts`
   - 새 케이스: CASE A 에서 `preCheckOk=false` → `{ kind: 'noop' }`
   - 기존 CASE B 흐름은 변경 없음

4. service patchMakerBot 테스트
   - PATCH `enabled: true` (기존 false) → `lastResumeAt` 자동 set
   - PATCH `enabled: true` (기존 true) → 미갱신
   - PATCH `enabled: false` → 미갱신
   - PATCH `bidOffsetKrw: 5` 단독 → 미갱신
   - PATCH `enabled: true, bidOffsetKrw: 5` 동시 (기존 false) → 갱신

### 5.2 검증

- `npx tsc --noEmit` — 타입 0 errors
- `npm test` — 신규/수정 테스트 모두 통과
- `npm run build` — 빌드 성공

### 5.3 프론트엔드

기존 패턴(unit test 없음) 따름.

- `npm run build` — Next 빌드 성공
- `npm run lint` — ESLint 0 errors
- 수동: dev 서버에서 Edit Dialog/Verify 버튼 동작 확인

## 6. 작업 순서

### Phase 1: 데이터 모델 (백엔드)

1. `prisma-stablecoin/schema.prisma` 에 `minSpreadKrw`, `lastResumeAt` 추가
2. `npm run prisma:migrate:stablecoin -- --name add_canary_stage_3_fields --create-only`
3. `prisma-stablecoin/migrations/{timestamp}_add_canary_stage_3_fields/migration.sql` tail 검사 (CLI garbage 방어)
4. `npm run prisma:migrate:stablecoin --` (no flags → 미적용 마이그레이션 apply) + `npm run prisma:generate`

### Phase 2: 백엔드 순수 함수 (TDD)

5. spread-gate.test.ts 작성 (RED)
6. spread-gate.ts 구현 (GREEN)
7. asset-reconciliation.service.test.ts 작성 (RED)
8. asset-reconciliation.service.ts 구현 (GREEN)

### Phase 3: 백엔드 통합

9. live-executor `LiveBotInput` 확장 (`minSpreadKrw` 필드)
10. agent.handleLiveBot 에서 `isSpreadProfitable` 호출 → `preCheckOk` 합산
11. agent.processBot sim 분기에 `isSpreadProfitable` 추가
12. service.patchMakerBot 에 enabled 전환 감지 + `lastResumeAt` 자동 set + 테스트
13. controller validation 에 `minSpreadKrw` 검증 추가
14. controller `verifyMakerBotReconciliation` 신규 엔드포인트
15. routes 등록

### Phase 4: 백엔드 검증

16. `npx tsc --noEmit`
17. `npm test`
18. `npm run build`

### Phase 5: 프론트엔드

19. `lib/api.ts` 타입 확장 + `verifyMakerBotReconciliation`
20. `EditMakerBotDialog.tsx` 신규 (CreateMakerBotDialog 패턴 차용)
21. `ReconciliationDialog.tsx` 신규
22. `MakerTakerSimPanel.tsx`: ✏️ 편집 + 🔍 검증 버튼, Resume since 표시
23. `npm run lint && npm run build`

### Phase 6: 통합 검증

24. dev 서버에서 Edit Dialog/Verify 버튼 수동 검증
25. 봇 #1 PATCH `enabled=true` 한 번 → DB 에 `lastResumeAt` 채워졌는지 확인
26. 검증 버튼 → 봇 #1 의 #382 FILLED 1건이 Upbit done order 와 매칭되는지 확인

### Phase 7: 머지

27. 백엔드 PR + 프론트엔드 PR 각각 push
28. 머지 후 `gh run list --limit 1` 으로 GitHub Actions 성공 확인
29. 메모리 업데이트 (`project_pr_h_canary_stage_3_readiness_complete.md`)

## 7. 리스크 / 엣지 케이스

### R1. simulator 통계 단절

- 문제: live=false 봇도 minSpreadKrw 게이팅 적용 → 좁은 스프레드 시간대 EXPIRED row 미생성
- 영향: "이전 7일 vs 이후 7일" 직접 비교 어려움
- 대응: 메모리/PR description 에 cutoff 명시

### R2. lastResumeAt NULL 인 기존 봇

- 검증 버튼 동작: `since = lastResumeAt ?? createdAt` → 봇 생성 시점부터 전체 기간
- 대응: 응답에 `sinceSource: 'createdAt'` 표시. UI 에 ⚠️ 경고 배지

### R3. Upbit getOrdersByMarket 페이지네이션

- canary stage 3 규모 1봇 24h ≈ 24건 → 단일 페이지 OK
- 방어: 응답이 정확히 100건이면 `pageTruncated=true` 표시
- pagination 자체는 stage 4 또는 다중 봇에서 구현

### R4. 검증 시점 race condition

- 검증 클릭 시 PENDING 진행 중 → 일시 불일치 가능
- 대응: 응답에 `pendingTradesCount` 포함. UI 에서 안내

### R5. 봇 ownership 보호

- `bot.userId !== userId` 시 throw (기존 patchMakerBot 패턴)

### R6. Upbit credential 부재

- 검증 시 credential 없으면 `400 Upbit credential not registered`

### R7. enabled 토글 race

- 의도된 동작: 마지막 resume 시점이 측정 기준
- bot.update 트랜잭션으로 보장됨

### R8. minSpreadKrw=0

- 게이팅 비활성. spread-gate 에서 `if (minSpreadKrw === 0) return { ok: true }`
- 음수는 controller validation 에서 차단

### R9. 동시 머지 충돌

- 프론트엔드가 백엔드보다 먼저 머지 → 신규 필드 사용 시 400/undefined
- 대응: 백엔드 머지 + Lightsail 배포 완료 → 프론트엔드 머지 순서. PR description 에 명시

## 8. 참고

- `project_canary_stage_2_complete_2026_04_30.md` — 4가지 후속 액션 출처
- `project_pr_e2_complete_2026_04_30.md` — live executor spec § 2 정합 (이번 PR 에서 변경 없음)
- `project_pr_d_canary_observation_2026_04_28.md` — 잔고 정합 검증 절차 (PR D 수준 자동화 대상)
- `feedback_prisma_migrate_cli_garbage.md` — migration SQL tail 검사
- `2026-04-24-maker-taker-simulator-design.md` — 시뮬레이터 원본 설계
