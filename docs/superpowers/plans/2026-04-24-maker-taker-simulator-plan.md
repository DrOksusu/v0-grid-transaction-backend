# Maker-Taker 스테이블 시뮬레이터 구현 계획

> **For agentic workers:** 이 계획은 `docs/superpowers/specs/2026-04-24-maker-taker-simulator-design.md` 설계에 기반한다. 작업 시 먼저 설계서를 읽고 "10. 열린 결정 사항"을 사용자와 확정한 후 진행할 것.

**Goal**: Upbit 스테이블 2종 간 "maker 주문 선점 + taker 즉시 매도" 전략의 실거래 없는 시뮬레이터를 추가한다. 2~3일 관찰 데이터로 실거래(M3) 도입 여부 판단.

**Architecture**: 신규 에이전트 `MakerTakerSimulatorAgent`, 신규 테이블 2개(`maker_taker_sim_bots`, `maker_taker_sim_trades`) in `grid_stablecoin_arb` DB, 기존 Upbit orderbook WS 재활용.

**작업 브랜치**: `feat/maker-taker-simulator` (다음 세션 시작 시 생성)

**사전 참고 문서**
- 설계서: `docs/superpowers/specs/2026-04-24-maker-taker-simulator-design.md`
- Prisma migrate garbage 버그: `~/.claude/projects/D--ExpressProject-Grid-project/memory/feedback_prisma_migrate_cli_garbage.md`
- Agent cycles red herring: `~/.claude/projects/D--ExpressProject-Grid-project/memory/feedback_agent_cycles_red_herring.md`
- 세션 7 완료 상태: `project_session_7_handoff_2026_04_24.md`

---

## Task 1: 설계 열린 항목 확정

- [ ] **Step 1**: 사용자와 설계서 "10. 열린 결정 사항" 4가지 확인
  - 체결 판단 방식(A/D)
  - 초기 봇 개수(1 vs 3)
  - minTakerBidKrw 정책
  - trades API 사용 여부

- [ ] **Step 2**: 결정 사항을 설계서에 반영(추가 커밋)

---

## Task 2: Prisma 스키마 추가

**Files:**
- Modify: `prisma-stablecoin/schema.prisma`

- [ ] **Step 1**: 설계서 "5. 데이터 모델"의 두 모델 정의를 스키마 파일 끝에 추가
- [ ] **Step 2**: `npx prisma format --schema=prisma-stablecoin/schema.prisma`
- [ ] **Step 3**: `npx prisma validate --schema=prisma-stablecoin/schema.prisma`

---

## Task 3: 마이그레이션 생성 + garbage 검사 (**CRITICAL**)

**Files:**
- New: `prisma-stablecoin/migrations/<timestamp>_add_maker_taker_sim/migration.sql`

- [ ] **Step 1**: 로컬 dev DB에 `grid_stablecoin_arb` 스키마 준비 확인 (`.env.local`의 STABLECOIN_DATABASE_URL)

- [ ] **Step 2**: `npm run prisma:migrate:stablecoin -- --name add_maker_taker_sim` 실행

- [ ] **Step 3**: **tail 검사 필수** (feedback_prisma_migrate_cli_garbage.md):
  ```bash
  tail -10 prisma-stablecoin/migrations/*_add_maker_taker_sim/migration.sql
  ```
  박스 문자(`┌ │ └`) 또는 "Update available" 문구 발견 시 즉시 제거.

- [ ] **Step 4**: 로컬 dev DB에서 마이그레이션 성공 확인 + 테이블 2개 생성 확인

---

## Task 4: 체결 판단 서비스 (순수 함수 + 유닛 테스트)

**Files:**
- New: `src/services/maker-taker-simulator.service.ts`
- New: `__tests__/services/maker-taker-simulator.service.test.ts`

- [ ] **Step 1**: 체결 판단 함수 (방식 A):
  ```typescript
  export function shouldFill(
    pendingOrder: { makerOrderPrice: number; createdAt: Date; maxPendingMs: number },
    currentMakerOrderbook: OrderbookTop,
    now: Date
  ): 'fill' | 'expire' | 'wait' {
    const elapsed = now.getTime() - pendingOrder.createdAt.getTime();
    if (elapsed > pendingOrder.maxPendingMs) return 'expire';
    if (currentMakerOrderbook.bid.price <= pendingOrder.makerOrderPrice) return 'fill';
    return 'wait';
  }
  ```

- [ ] **Step 2**: Taker leg 시뮬레이션 + P&L 계산 함수:
  ```typescript
  export function simulateTakerLeg(
    makerFilledPrice: number,
    takerOrderbook: OrderbookTop,
    quantity: number,
    feeBpsMaker: number,
    feeBpsTaker: number,
    minTakerBidKrw?: number
  ): { takerPrice: number; netProfitKrw: number; realizedSpreadBps: number } | { abort: true; reason: string }
  ```

- [ ] **Step 3**: 유닛 테스트 최소 6건:
  - shouldFill: fill/expire/wait 각 1건
  - simulateTakerLeg: 정상 이익, 손실, minTakerBidKrw 미달로 abort 각 1건

- [ ] **Step 4**: `npm run test -- maker-taker-simulator`로 통과 확인

- [ ] **Step 5**: 커밋 `feat(sim): maker-taker 체결 판단 + P&L 유닛 테스트`

---

## Task 5: 에이전트 구현

**Files:**
- New: `src/agents/maker-taker-simulator-agent.ts`

- [ ] **Step 1**: `BaseAgent` 상속 클래스 작성
  - `id = 'maker-taker-sim'`
  - `name = 'MakerTakerSimulatorAgent'`
  - `start()`: 기존 `subscribeStablecoinOrderbooks()` 재활용, `onStablecoinOrderbookUpdate`로 리스너 등록
  - `stop()`: unsubscribe
  - `evaluate()` 구현

- [ ] **Step 2**: evaluate 로직:
  1. `maker_taker_sim_bots` where `enabled=true AND killSwitch=false` 조회
  2. 각 봇마다:
     - 현재 PENDING trade 없으면 → 새 가상 주문 생성 (`INSERT MakerTakerSimTrade with status='PENDING'`)
     - 현재 PENDING trade 있으면 → `shouldFill()` 체크
       - `fill` → `simulateTakerLeg()` → UPDATE (FILLED + P&L)
       - `expire` → UPDATE (EXPIRED)
       - `wait` → 아무것도 안함

- [ ] **Step 3**: 에이전트 동시 진입 방지 플래그 (StablecoinArbAgent처럼 `evaluateInFlight`)

- [ ] **Step 4**: 타입 체크 `npx tsc --noEmit`

- [ ] **Step 5**: 커밋 `feat(sim): MakerTakerSimulatorAgent 구현`

---

## Task 6: AgentManager 등록

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1**: `src/index.ts:89` 부근에 등록 추가:
  ```typescript
  agentManager.register(new MakerTakerSimulatorAgent());
  ```
- [ ] **Step 2**: 로그 문자열 갱신 (6개 에이전트)
- [ ] **Step 3**: 빌드 확인 + 커밋

---

## Task 7: 초기 봇 seed 스크립트

**Files:**
- New: `scripts/seed-maker-taker-sim-bots.ts`

- [ ] **Step 1**: 설계서 "7. 초기 봇 3개 제안" 기반 스크립트 작성. 3개 또는 1개(Task 1 결정에 따라) INSERT.

- [ ] **Step 2**: 로컬에서 dry-run으로 검증 (`npx ts-node scripts/seed-maker-taker-sim-bots.ts --dry-run`)

- [ ] **Step 3**: 커밋 (스크립트만, 실제 INSERT는 배포 후 수행)

---

## Task 8: 로컬 빌드 + 통합 테스트

- [ ] **Step 1**: `npm run build` 성공 확인
- [ ] **Step 2**: 로컬 dev 서버 기동 → `MakerTakerSimulatorAgent Started` 로그 확인
- [ ] **Step 3**: 로컬 dev DB에 봇 1개 INSERT → 30초 후 `maker_taker_sim_trades`에 PENDING 레코드 생성 확인

---

## Task 9: 배포 준비 — 사용자 승인

**⚠️ 사용자에게 push 전 명시적 승인 요청 필요:**
- push 대상: `feat/maker-taker-simulator` → `origin`
- PR base: `main`
- Expected 다운타임: 컨테이너 재시작 1~2분

- [ ] **Step 1**: AWS Lightsail 수동 스냅샷 생성 요청 (사용자 콘솔, `pre-maker-taker-sim-<date>`)

- [ ] **Step 2**: 사용자 승인 확인 후 다음 단계

---

## Task 10: Push + PR + 배포

- [ ] **Step 1**: `git push -u origin feat/maker-taker-simulator`

- [ ] **Step 2**: PR 생성 (`gh pr create`) with 요약 + test plan

- [ ] **Step 3**: PR 머지 (`gh pr merge <N> --squash --delete-branch`)

- [ ] **Step 4**: `gh run watch <run_id> --exit-status`로 배포 모니터링

---

## Task 11: 배포 후 검증

- [ ] **Step 1**: `/api/agents` → 6개 에이전트 running
- [ ] **Step 2**: 컨테이너 로그 `MakerTakerSimulatorAgent Started` 확인
- [ ] **Step 3**: `grid_stablecoin_arb` DB에 `maker_taker_sim_*` 테이블 2개 + `_prisma_migrations` 해당 migration applied 확인
- [ ] **Step 4**: seed 스크립트로 프로덕션 봇 INSERT (`docker exec grid-bot npx ts-node scripts/seed-maker-taker-sim-bots.ts` 또는 DB 직접 INSERT)
- [ ] **Step 5**: 1시간 뒤 `maker_taker_sim_trades` 레코드 쌓이는지 확인

---

## Task 12: 48시간 관찰 + 결과 보고서

- [ ] **Step 1**: 48시간 대기 (별도 세션)

- [ ] **Step 2**: 결과 집계 쿼리:
  ```sql
  SELECT
    bot.id, bot.makerCoin, bot.takerCoin, bot.bidOffsetKrw,
    COUNT(t.id) AS total_trades,
    SUM(CASE WHEN t.status='FILLED' THEN 1 ELSE 0 END) AS filled,
    SUM(CASE WHEN t.status='EXPIRED' THEN 1 ELSE 0 END) AS expired,
    AVG(t.realizedSpreadBps) AS avg_spread_bps,
    SUM(t.netProfitKrw) AS total_net_profit_krw
  FROM maker_taker_sim_bots bot
  LEFT JOIN maker_taker_sim_trades t ON t.botId = bot.id AND t.createdAt > <48h ago>
  GROUP BY bot.id;
  ```

- [ ] **Step 3**: 성공 기준 (설계서 §9) 대조 후 판단:
  - 모든 기준 충족 → M3 실거래 executor 설계에 통합
  - 일부 미충족 → 방식 D(trade WS 구독) 업그레이드 후 재시도
  - 과도한 미충족 → 전략 폐기

---

## Task 13: 메모리 업데이트

- [ ] **Step 1**: `project_session_<N>_handoff.md` 작성 (시뮬레이터 배포 완료 기록)
- [ ] **Step 2**: `project_resume_next_session.md` 갱신 (6개 에이전트, maker_taker_sim 관찰 중)
- [ ] **Step 3**: MEMORY.md 인덱스 갱신

---

## 작업 위험도 요약

| Task | 위험도 | 이유 |
|---|---|---|
| 1, 2, 4, 5, 6, 7, 8 | 낮음 | 로컬 작업, 배포 없음 |
| 3 | 중간 | Prisma migrate 생성 (garbage 버그 재발 주의 — tail 검사 필수) |
| 9, 10 | 높음 | Production 배포, 컨테이너 재시작 1~2분 다운타임 |
| 11 | 중간 | 배포 후 검증. DB 변경 확인 필요 |
| 12 | 낮음 | 관찰만 |

## 예상 소요 시간

| 단계 | 시간 |
|---|---|
| Task 1 (설계 확정) | 10분 |
| Task 2~8 (구현) | 2~3시간 |
| Task 9~11 (배포) | 30분 |
| Task 12 (관찰 대기) | 48시간 (작업 시간 아님) |
| Task 13 (메모리) | 15분 |
| **총 작업 시간** | **3~4시간** (단일 세션 가능) |
