# PR E2 — Maker-Taker Live Executor Spec Realignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PR D Canary에서 발견된 spec/구현 불일치를 해소한다. Live executor의 Stage 1을 "maker 코인(USDS) 매도"에서 spec § 2 "전략 핵심"의 "taker 코인(USDT) 시장가 매도"로 변경하고, KRW 우회 패턴(Stage 2 USDT 매수 + Stage 3 X 재매수 fallback)을 제거한다. 동시에 leg-2 IOC false positive(PR D 사례 uuid b04515ce: executed_volume=0이지만 실제 체결됨) 방어를 위해 1.5초 재폴링을 추가한다.

**Architecture:** `maker-taker-live-executor.ts`의 CASE B "체결됨" 분기(L173-210)만 변경. fallback 정책은 Option A(no fallback) 확정 — sim/live 정합성 유지가 최우선이고, PR E1의 `minTakerBalance` 자동 일시정지가 인벤토리 누적 위험을 보완. `rolled_back` kind와 `filledBuyKrw` 필드는 다운스트림(agent.ts persistLiveResult, FILLED note string) 정리 동반. Simulator(`maker-taker-simulator.service.ts`)는 변경 없음 — 이미 spec 의도대로 `(takerPrice − makerFilledPrice) × q` 계산.

**Tech Stack:** TypeScript, Prisma (MySQL), Express, Jest

**선행 컨텍스트:**
- 사고 분석: `~/.claude/projects/D--ExpressProject-Grid-project/memory/project_pr_d_canary_observation_2026_04_28.md`
- PR E1 머지 노트: `~/.claude/projects/D--ExpressProject-Grid-project/memory/project_pr_e1_complete_2026_04_29.md`
- Spec § 2 "전략 핵심": `v0-grid-tranasction-backend/docs/superpowers/specs/2026-04-24-maker-taker-simulator-design.md` (PR D/E1 메모의 "§ 13-15"는 § 2 오기. 본 plan부터 § 2 인용)
- 기존 PR C plan: `v0-grid-tranasction-backend/docs/superpowers/plans/2026-04-26-stablecoin-trading-pr-c-maker-taker-live.md`

**중요 규칙:**
- 모든 명령/주석/커밋 메시지 한국어
- production DB destructive 쿼리 금지 (read-only만)
- 새 npm 패키지 설치 금지
- 거래 패턴 변경 PR이므로 사전 AWS 스냅샷 필수 (Task 1에서 검증)
- 머지 직후 자동 canary 시작 금지 — 사용자가 별도 단계로 시작 (PR D 패턴)

**Fallback 정책 결정 (advisor 컨펌):**
> **Option A — no fallback. Stage 1(USDT 매도) 실패 시 PARTIAL_HOLD로 USDS 보유 + 수동 unwind.**
>
> 근거 3가지:
> 1. Sim/live 정합성 유지 — simulator는 fallback 없음. live가 fallback 가지면 P&L 메커니즘이 다시 어긋남(PR D 재발).
> 2. Spec § 2 일치 — cross-coin direct swap 외 동작 미정의.
> 3. PR E1 안전장치 보완 완료 — `minTakerBalance` 자동 일시정지가 인벤토리 누적 위험 처리.

---

## Task 1: 사전 운영 점검 + 사전조건 검증

**목적:** PR E2 작업 전 운영 안전 상태 확인 + 사전조건 3개 충족 검증.

**Files:**
- Modify: 없음 (검증만)

- [ ] **Step 1: 백엔드 health + 6 에이전트 상태 확인**

```bash
curl -s http://54.180.188.8:3010/api/health
curl -s http://54.180.188.8:3010/api/agents | python -c "
import sys, json
for a in json.load(sys.stdin)['data']:
    print(f\"  - {a['name']}: status={a['status']}, errors={a['metrics']['errors']}\")"
```

기대: 6개 에이전트 모두 `status=running, errors=0`. 이미 세션 시작 시 검증됨.

- [ ] **Step 2: AWS 사전 스냅샷 존재 확인**

`pre-pr-e2-*` 또는 사용자 수동 생성 스냅샷이 `Available` 상태인지 확인. 사용자가 콘솔에서 방금 생성 완료 보고함.

- [ ] **Step 3: 봇 #1 user의 Upbit USDT 잔고 ≥ 10 확인**

사용자가 ≥ 10 USDT 확보 보고. 봇 #1 quantity=10이므로 첫 체결까지는 충분.

- [ ] **Step 4: maker bot 3개 현재 상태 재확인**

```bash
ssh -i "C:/pem/54.180.188.8.pem" ubuntu@54.180.188.8 \
  "docker exec grid-bot node -e \"
const { stablecoinPrisma } = require('/app/dist/config/database');
stablecoinPrisma.makerTakerSimBot.findMany({
  select: { id: true, enabled: true, live: true, killSwitch: true, minTakerBalance: true }
}).then(rows => console.log(JSON.stringify(rows, null, 2))).finally(() => stablecoinPrisma.\\\$disconnect());
\""
```

기대 (PR E1 노트 기준): #1 enabled=false/live=false, #2/#3 enabled=true/live=false. PR E2 머지 후 봇 #1을 enabled=true + live=true + minTakerBalance 설정으로 재가동.

---

## Task 2: Live Executor 재구현 (spec § 2 정합)

**목적:** Stage 1을 USDS 매도 → USDT 매도로 교체. Stage 2/3 제거. leg-2 false positive 1.5초 재폴링 추가.

**Files:**
- Modify: `src/services/maker-taker-live-executor.ts`

- [ ] **Step 1: 결과 union 정리 — `rolled_back` kind 제거, `filledBuyKrw` 필드 제거**

`LiveExecutorResult` (L76-93) 변경:
- `kind: 'rolled_back'` 라인(L93) 삭제
- `kind: 'filled'` 인터페이스(L82-91)에서 `filledBuyKrw: number` 라인(L87) 삭제

- [ ] **Step 2: 헤더 주석(L1-21) 갱신**

"X 매도 → Y 매수", "fallback X 재매수" 등 KRW 우회 표현을 "Y 시장가 매도 (spec § 2)"로 교체. Stage 2/3 fallback 표현 제거.

- [ ] **Step 3: CASE B "체결됨" 분기 본문 교체 (L173-232)**

기존 Stage 1(maker 코인 매도) + Stage 2(taker 코인 매수) + Stage 3(fallback 재매수) 블록을 다음으로 교체:

```typescript
// Stage 1: taker 코인을 즉시 시장가로 매도 (spec § 2 "전략 핵심")
const sellResp = await client.placeBestIoc(
  `KRW-${bot.takerCoin}`,
  'ask',
  { volume: String(filledQty) },
);
let filledSellQty = parseFloat(sellResp.executed_volume || '0');
let effectiveSellResp: UpbitOrderResp = sellResp;

// leg-2 false positive 방어 (PR D 사례 uuid b04515ce: 즉시 응답 0 → ~2분 후 실제 체결)
// IOC 직후 1.5초 후 1회 재조회. 두 번째 재조회 도입은 실제 false positive 재발 시 PR E3에서 검토.
if (filledSellQty === 0 && sellResp.uuid) {
  await new Promise(resolve => setTimeout(resolve, 1500));
  const recheck = await client.getOrder(sellResp.uuid);
  const recheckQty = parseFloat(recheck.executed_volume || '0');
  if (recheckQty > 0) {
    filledSellQty = recheckQty;
    effectiveSellResp = recheck;
  }
}

if (filledSellQty === 0) {
  // taker leg 미체결 → maker leg(USDS) 그대로 보유, 수동 unwind 필요
  return {
    kind: 'partial_hold',
    pendingId: pending.id,
    reason: 'taker(Y) sell failed after IOC + recheck, holding X',
  };
}

const filledSellKrw = sumFunds(effectiveSellResp.trades);
const paidFeeSell = parseFloat(effectiveSellResp.paid_fee || '0');

// P&L 계산 — simulator와 동일 공식: (T_received - M_paid) * q - fees
// filledSellKrw = USDT 매도 받은 KRW (taker 체결가 × q)
// filledMakerKrw = USDS 매수 지불 KRW (maker 체결가 × q)
const paidFeeKrw = paidFeeMaker + paidFeeSell;
const netProfitKrw = filledSellKrw - filledMakerKrw - paidFeeKrw;
const realizedSpreadBps = Math.floor(
  (filledSellKrw / filledMakerKrw - 1) * 10000,
);

return {
  kind: 'filled',
  pendingId: pending.id,
  filledQty,
  filledMakerKrw,
  filledSellKrw,
  paidFeeKrw,
  netProfitKrw,
  realizedSpreadBps,
};
```

핵심 변경 4가지:
1. Stage 1 market 인자: `KRW-${bot.makerCoin}` → `KRW-${bot.takerCoin}` (USDS → USDT)
2. Stage 2(receive KRW로 USDT 매수) 블록 전체 삭제
3. Stage 3(fallback X 재매수) 블록 전체 삭제 — Option A "no fallback"
4. `filledSellQty===0` 즉시 PARTIAL_HOLD 대신 1.5초 재폴링 1회

- [ ] **Step 4: `sumFunds` helper는 그대로 유지**

L105-107 변경 없음.

- [ ] **Step 5: `npx tsc --noEmit` 통과 확인 (다음 태스크에서 합쳐서 실행)**

---

## Task 3: Agent persistLiveResult 정리

**목적:** `rolled_back` kind 제거에 따른 persist 로직 dead branch 제거. FILLED 노트에서 `filledBuyKrw` 참조 제거.

**Files:**
- Modify: `src/agents/maker-taker-simulator-agent.ts`

- [ ] **Step 1: invalidate 트리거 union에서 `'rolled_back'` 제거 (L334-341)**

```typescript
if (
  result.kind === 'placed' ||
  result.kind === 'filled' ||
  result.kind === 'partial_hold'
) {
  upbitClient.cache.invalidate();
}
```

- [ ] **Step 2: FILLED 노트 string에서 `result.filledBuyKrw` 참조 제거 (L416)**

기존:
```typescript
notes:
  (pending?.notes ?? '') +
  ` | LIVE FILLED sell=${result.filledSellKrw} buy=${result.filledBuyKrw} fees=${feeKrw} net=${netProfitKrw}`,
```

변경 후:
```typescript
notes:
  (pending?.notes ?? '') +
  ` | LIVE FILLED maker=${result.filledMakerKrw} sell=${result.filledSellKrw} fees=${feeKrw} net=${netProfitKrw}`,
```

(`filledMakerKrw`로 교체 — debugging 시 entry/exit 가격을 모두 보고 싶음)

- [ ] **Step 3: `case 'rolled_back':` 블록 제거 (L432-440)**

`switch (result.kind)` 안의 `case 'rolled_back': ...` 4줄 블록 삭제. 컴파일러 exhaustive check(`_exhaustive: never`)가 union 변경을 자동 검증.

DB enum/status 컬럼의 `'ROLLED_BACK'` 값은 그대로 유지 — 향후 다시 도입할 가능성 + 기존 row 보존. Prisma migrate 불필요.

- [ ] **Step 4: import + agent body 다른 부분 변경 없음 확인**

`runLiveExecutor` import, `LiveExecutorResult` import 그대로.

---

## Task 4: Unit Test 업데이트 + Sanity Test 추가

**목적:** 기존 `__tests__/services/maker-taker-live-executor.test.ts`를 새 패턴에 맞춰 갱신. sim/live divergence 재발 방지용 sanity test 1개 추가.

**Files:**
- Modify: `__tests__/services/maker-taker-live-executor.test.ts`

- [ ] **Step 1: 기존 "체결됨" 시나리오 mock 업데이트**

기존 테스트 중 Stage 2 (USDT 매수 IOC) mock과 Stage 3 (fallback X 재매수) mock 시나리오 정리:
- "happy path" 테스트: Stage 1 USDT 매도가 즉시 성공하는 mock으로 변경. 결과 kind='filled', `filledBuyKrw` 필드 미참조.
- "Y 매수 실패 → fallback" 테스트: 삭제 또는 "taker 매도 IOC 즉시 0 + 재폴링도 0 → partial_hold" 시나리오로 교체.
- "X 매도 실패 → partial_hold" 테스트: 그대로 남기되, Stage 1 market을 takerCoin으로 검증.

- [ ] **Step 2: 신규 테스트 — leg-2 false positive 재폴링 검증**

```typescript
it('Stage 1 즉시 응답 0 + 1.5초 후 재폴링에서 체결 확인 → filled', async () => {
  // mock: placeBestIoc는 executed_volume=0 + uuid 반환
  //       getOrder(uuid)는 executed_volume=10 + trades 반환
  // 기대: kind='filled', filledSellKrw > 0
});
```

- [ ] **Step 3: 신규 테스트 — sim/live P&L 정합성 sanity**

```typescript
it('동일 호가/체결 조건에서 simulator와 live의 netProfitKrw가 동일해야 한다', async () => {
  // Given: 동일 makerFilledPrice, 동일 takerPrice, 동일 q, 동일 fee bps
  // simulator: simulateTakerLeg(...) → netProfitKrw_sim
  // live mock: maker fill + Stage 1(USDT 매도) 즉시 fill, 동일 가격
  //           → netProfitKrw_live
  // Expect: |netProfitKrw_sim - netProfitKrw_live| < 1 KRW (수수료 단위 round 허용)
});
```

이 테스트가 향후 Stage 1을 다시 오염시키는 변경을 즉시 잡아줌.

- [ ] **Step 4: 기존 'rolled_back' 사용 테스트 정리**

`expect(result.kind).toBe('rolled_back')` 또는 `LiveExecutorResult` union에 의존하는 테스트가 있다면 컴파일 에러 발생 → 'partial_hold'로 교체 또는 삭제.

- [ ] **Step 5: `npm test -- maker-taker-live-executor` 실행 → 모두 통과 확인**

---

## Task 5: 타입 체크 + 빌드 검증

**목적:** Task 2/3/4 변경이 컴파일 에러 없는지 검증. Windows DLL 잠금(PR E1 미해결)이 발생하면 다른 환경 사용.

**Files:**
- Modify: 없음

- [ ] **Step 1: 타입 체크**

```bash
cd D:/ExpressProject/Grid_project/v0-grid-tranasction-backend
npx tsc --noEmit
```

기대: 에러 0개. exhaustive check가 `rolled_back` 제거 누락을 자동 발견.

- [ ] **Step 2: 빌드**

```bash
npm run build
```

Windows DLL 잠금(`query_engine-windows.dll EPERM`) 발생 시:
- 옵션 A: node 프로세스 모두 종료 후 재시도
- 옵션 B: WSL 또는 컨테이너에서 빌드
- 옵션 C: CI(GitHub Actions)에 푸시 후 빌드 결과 확인

- [ ] **Step 3: 전체 테스트 sweep**

```bash
npm test -- --testPathPattern=maker-taker
```

`maker-taker-live-executor.test.ts`, `maker-taker-simulator.service.test.ts` (있다면) 모두 통과 확인. `trading.service.chunk-{2,3,4,5}.test.ts`의 13개 pre-existing fail은 본 PR 무관(PR E1 노트 명시).

---

## Task 6: PR 작성

**목적:** PR 작성 + 사용자 머지. PR 본문에 사고 분석 + spec 정정 + fallback 결정 근거 포함.

**Files:**
- Modify: 없음 (PR 본문만)

- [ ] **Step 1: 변경 파일 final diff 확인**

```bash
cd D:/ExpressProject/Grid_project/v0-grid-tranasction-backend
git status
git diff src/services/maker-taker-live-executor.ts
git diff src/agents/maker-taker-simulator-agent.ts
git diff __tests__/services/maker-taker-live-executor.test.ts
```

기대 변경 파일 4개:
1. `src/services/maker-taker-live-executor.ts`
2. `src/agents/maker-taker-simulator-agent.ts`
3. `__tests__/services/maker-taker-live-executor.test.ts`
4. `docs/superpowers/plans/2026-04-29-stablecoin-trading-pr-e2-spec-realignment.md` (이 plan 자체)

- [ ] **Step 2: 사용자 승인 후 커밋 (글로벌 규칙: push 전 사용자 승인)**

브랜치명 사용자에게 확인. 권장: `feat/maker-taker-spec-realignment-pr-e2`.

커밋 메시지(한국어, 50자 이내 제목):
```
feat: Maker-Taker live executor를 spec § 2에 맞춰 재구현

- Stage 1을 USDS 매도 → USDT 시장가 매도로 교체 (cross-coin direct swap)
- Stage 2(KRW로 USDT 매수) + Stage 3(fallback X 재매수) 제거
- leg-2 IOC false positive 방어: 즉시 0 응답 시 1.5초 후 재폴링 1회
- LiveExecutorResult union에서 rolled_back kind + filledBuyKrw 필드 제거
- agent.persistLiveResult에서 rolled_back case + FILLED 노트 정리

Fallback 정책: Option A (no fallback). 근거: sim/live 정합성, spec § 2 일치,
PR E1 minTakerBalance가 인벤토리 누적 위험 보완.

PR D 사고 분석: project_pr_d_canary_observation_2026_04_28.md
Spec: 2026-04-24-maker-taker-simulator-design.md § 2
```

- [ ] **Step 3: gh pr create**

PR 본문에 다음 섹션 포함:
- ## Summary (3 bullets)
- ## Why (PR D 사고 + spec 불일치 명시 + advisor 컨펌)
- ## Test plan (체크리스트)
- ## Post-merge (Canary 별도 단계 — 자동 시작 금지)

- [ ] **Step 4: 사용자 머지 대기 + GitHub Actions 워크플로우 결과 확인**

머지 후:
```bash
gh run list --limit 1 --repo DrOksusu/v0-grid-transaction-backend
```

배포 성공 + 6 에이전트 errors=0 재확인.

---

## Task 7: 머지 후 운영 검증 (Canary 시작은 별도)

**목적:** 머지/배포 후 운영 정상성 검증. Canary 실거래 재개는 본 plan 범위 밖 (별도 단계로 사용자 승인).

**Files:**
- Modify: 없음

- [ ] **Step 1: 6 에이전트 status=running, errors=0 재확인**

- [ ] **Step 2: 봇 #1/#2/#3 enabled/live/killSwitch/minTakerBalance 상태 재확인**

머지 직후 #1 enabled=false 유지(PR D 후속), live=false. PR E2는 코드만 교체.

- [ ] **Step 3: 마지막 봇 #2/#3 가상 시뮬 데이터 추이 sanity 체크**

`maker_taker_sim_trades` 최근 1시간 row가 정상 생성되는지(live=false PENDING/EXPIRED/FILLED 패턴).

- [ ] **Step 4: 사용자에게 Canary Stage 1 시작 의사 확인**

Canary 시작 조건 (PR D 패턴 + PR E1 안전장치):
- 봇 #1 minTakerBalance 설정 (예: 8 USDT — quantity=10이므로 8 이하 떨어지면 자동 일시정지)
- 봇 #1 enabled=true + live=true 토글 (PR E1 UI)
- Canary 임계값: `netProfitKrw ≤ −1000 KRW` 단독 사용 금지 (PR E1 노트 정정 사항)
  - + MTM 자동 계산 (Upbit USDT bid - 봇 매수가 차이 + 수수료)
  - + T+4h 시점 FILLED 0건이면 abort 후보
- 24h 관측 후 Stage 2/3 결정

이 단계는 본 plan 외 별도 task list로 진행.

---

## 롤백 계획

PR 머지 후 운영 이상(에이전트 죽음, errors 발생, 봇 #2/#3 가상 시뮬 중단 등) 발생 시:

1. **즉시 GitHub Actions Revert PR 머지** — main 이전 커밋(PR E1 head)으로 복구
2. **컨테이너 재배포 자동** — Lightsail이 새 이미지 받아서 시작
3. **DB 변경 없음** — Prisma migrate 없음. 롤백 시 데이터 손실 없음
4. **AWS 스냅샷 사용 가능** — Task 1 Step 2 스냅샷이 fallback

봇 #1 live=true에서 이상 발생 시 (Canary 단계, 본 plan 외):
- Admin UI 🛑 Stop 토글 즉시
- 또는 Admin UI 💀 Kill 토글 (killSwitch=true)
- 또는 백엔드 컨테이너에서 SQL UPDATE (PR D 사용 패턴)

---

## 미해결 / 본 plan 외 (메모리 갱신 시 반영)

- **`filledBuyKrw` DB persist 컬럼 정리**: schema의 `MakerTakerSimTrade`에 `filledBuyKrw` 컬럼이 있다면 제거할지 결정. 현재 agent persist 코드는 해당 컬럼에 쓰지 않음 → 컬럼 자체는 그대로 둬도 동작 영향 없음. 향후 schema cleanup PR에서 정리.
- **trade history API 매칭으로 false positive 방어 강화**: 1.5초 재폴링으로 안 잡히는 케이스 발생 시 PR E3에서 도입.
- **`ROLLED_BACK` status enum**: DB enum 값 그대로 유지. 기존 PR D 케이스 row 보존 + 향후 재도입 여지.
- **메모리 정정**: PR D/E1 노트의 "spec § 13-15" 표기를 "spec § 2"로 정정.
- **plan 미커밋 leftover**: PR C/D plan 두 개가 main에 untracked 상태(PR E1 노트). 본 PR E2 plan과 함께 커밋 또는 별도 docs PR.
