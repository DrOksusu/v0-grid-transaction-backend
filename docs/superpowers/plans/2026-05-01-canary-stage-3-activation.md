# Canary Stage 3 가동 Runbook

> **운영 문서**: 코드 변경 없이 production 시스템 조작 절차. PR H 안전장치(minSpreadKrw, lastResumeAt, BalancePrecheck/MinBalanceGuard, reconcileBotAssets) 머지 완료 후 시점 기준.

**Goal:** Maker-Taker 봇 #1, #2, #3 을 live=true 로 가동하여 24h 동안 실거래 관찰. Stage 2 (-4.905 KRW 손실) 의 후속으로 PR H minSpreadKrw 12 KRW 게이트 적용 + bidOffsetKrw 0/-4/-6 비교 분석.

**전제 조건:**
- PR H 백엔드 PR #20 (`dbc03d8`) + 프론트엔드 PR #6 (`086bd89`) 머지 완료
- 백엔드 GH Actions success, 6/6 에이전트 running
- DB columns `MakerTakerSimBot.minSpreadKrw` (default 12) + `lastResumeAt` 마이그레이션 적용 확인 완료

**Stage 3 파라미터:**
- 모드: live=true (실거래)
- 가동 봇: 봇 #1, #2, #3 (전부)
- minSpreadKrw: 전부 12 (default)
- 관찰 기간: 24h
- Exit 기준: FILLED ≥1건 + spec § 2 정합 + net profit ≥0

---

## 단계 1: Pre-flight 체크리스트

가동 시작 30분 전에 모두 통과 확인.

### 1-A. RDS 스냅샷 (수동 보강)

PR F automated snapshot 은 deploy 시점에만 작동. canary 가동은 deploy 와 무관하므로 수동 스냅샷 1건 추가.

```bash
aws lightsail create-relational-database-snapshot \
  --relational-database-name Grid-bot-DB-v2 \
  --relational-database-snapshot-name pre-canary-stage-3-$(date -u +%Y%m%d-%H%M%S) \
  --region ap-northeast-2
```

확인:
```bash
aws lightsail get-relational-database-snapshots --region ap-northeast-2 \
  --query 'relationalDatabaseSnapshots[?starts_with(name, `pre-canary-stage-3`)].[name,createdAt,state]' \
  --output table
```

`state=available` 까지 대기 (보통 5-10분).

### 1-B. 봇 #1 minSpreadKrw 정규화 (13 → 12)

현재 봇 #1 은 13 (Edit Dialog 테스트로 변경된 흔적). Stage 3 통일 정책 (전부 12) 적용:

```bash
ssh -i C:/pem/54.180.188.8.pem ubuntu@54.180.188.8 \
  'docker exec grid-bot node -e "const { PrismaClient } = require(\"/app/node_modules/.prisma/client-stablecoin\"); const p = new PrismaClient(); p.makerTakerSimBot.update({ where: { id: 1 }, data: { minSpreadKrw: 12 } }).then(r => console.log(JSON.stringify(r, null, 2))).finally(() => p.\$disconnect());"'
```

확인:
```bash
ssh -i C:/pem/54.180.188.8.pem ubuntu@54.180.188.8 \
  'docker exec grid-bot node -e "const { PrismaClient } = require(\"/app/node_modules/.prisma/client-stablecoin\"); const p = new PrismaClient(); p.makerTakerSimBot.findMany({ select: { id: true, minSpreadKrw: true } }).then(r => console.table(r)).finally(() => p.\$disconnect());"'
```

기대: 봇 #1, #2, #3 모두 minSpreadKrw=12.

### 1-C. 안전장치 ON 확인

| 봇 | enabled | live | killSwitch | 상태 |
|----|---------|------|-----------|------|
| #1, #2, #3 | true (sim 가동중) | **false** (현재 sim) | **false** | live=true 전환 직전 |

상태 확인 SQL (위 쿼리 컬럼만 추가):
```bash
ssh -i C:/pem/54.180.188.8.pem ubuntu@54.180.188.8 \
  'docker exec grid-bot node -e "const { PrismaClient } = require(\"/app/node_modules/.prisma/client-stablecoin\"); const p = new PrismaClient(); p.makerTakerSimBot.findMany({ select: { id: true, enabled: true, live: true, killSwitch: true, minTakerBalance: true } }).then(r => console.table(r)).finally(() => p.\$disconnect());"'
```

기대: 모두 `enabled=true`, `live=false`, `killSwitch=false`, `minTakerBalance` 설정값 (≥ quantity * 1.05).

### 1-D. Upbit 잔고 사전 확인

각 봇이 maker bid (USDS) + taker ask (USDT) 양쪽 다 가능해야 함.

Admin UI 잔고 페이지에서 확인 (또는 백엔드 API):

```bash
curl -s -H "Authorization: Bearer <admin_jwt>" \
  http://54.180.188.8:3010/api/upbit/balances | python -c "
import sys, json
d = json.load(sys.stdin)
for b in d.get('balances', []):
  if b['currency'] in ('USDS', 'USDT', 'KRW'):
    print(f\"{b['currency']:6s} balance={b['balance']:>15s} locked={b['locked']:>10s}\")"
```

기대 최소량 (quantity=20 기준 봇 3개 동시 동작):
- USDS ≥ 60 (3봇 × 20)
- USDT ≥ 60 (taker ask 시 필요)
- KRW: 거래 자체에 직접 필요 없음 (cross-coin direct swap)

### 1-E. 백엔드 health + 에이전트 상태

```bash
curl -s http://54.180.188.8:3010/api/health
curl -s http://54.180.188.8:3010/api/agents | python -c "
import sys, json
d = json.load(sys.stdin)
for a in d['data']:
  print(f\"  {a['id']:30s} status={a['status']} errors={a['metrics']['errors']}\")"
```

기대: 6/6 running, errors=0.

### 1-F. Frontend Admin UI 진입 확인

브라우저에서 `https://v0-grid-transaction.vercel.app/admin/stablecoin` 접근 가능 + Maker-Taker 패널에서 봇 3개 표시 확인.

---

## 단계 2: Stage 3 가동 (live=true 전환)

**가동 시각 (T_start) 기록**: 단계 2-A 시작 직전 시각을 별도 메모. T+24h 시점 = T_start + 24h.

### 2-A. 봇 enabled cycle (lastResumeAt 갱신)

각 봇의 `lastResumeAt` 을 새 canary 시작 시각으로 갱신하기 위해 enabled false → true cycle. Admin UI 에서 봇 #1, #2, #3 각각:

1. ⏸️ Pause 버튼 → enabled=false
2. (5초 대기)
3. ▶️ Resume 버튼 → enabled=true → `patchMakerBot` 이 lastResumeAt 자동 갱신

또는 한 번에 (DB 직접):
```bash
ssh -i C:/pem/54.180.188.8.pem ubuntu@54.180.188.8 \
  'docker exec grid-bot node -e "
const { PrismaClient } = require(\"/app/node_modules/.prisma/client-stablecoin\");
const p = new PrismaClient();
(async () => {
  for (const id of [1,2,3]) {
    await p.makerTakerSimBot.update({ where: { id }, data: { enabled: false } });
  }
  await new Promise(r => setTimeout(r, 1000));
  const now = new Date();
  for (const id of [1,2,3]) {
    await p.makerTakerSimBot.update({ where: { id }, data: { enabled: true, lastResumeAt: now } });
  }
  const r = await p.makerTakerSimBot.findMany({ select: { id: true, enabled: true, lastResumeAt: true } });
  console.table(r);
})().finally(() => p.\$disconnect());
"'
```

⚠️ DB 직접 update 는 patchMakerBot service 의 lastResumeAt 자동 로직을 우회하므로 명시적으로 lastResumeAt 도 같이 set. Admin UI 경로가 더 안전 (서비스 로직 검증).

확인: 봇 3개 모두 `lastResumeAt` 이 직전 시각으로 갱신됨.

### 2-B. live=true 전환 (실거래 시작)

**⚠️ 이 단계 후 첫 placement 부터 실제 자금 거래 발생.**

각 봇:

Admin UI 에서 ✏️ Edit Dialog → live 체크박스 ON (또는 별도 토글이 있으면 그것)

또는 DB 직접 (단일 트랜잭션):
```bash
ssh -i C:/pem/54.180.188.8.pem ubuntu@54.180.188.8 \
  'docker exec grid-bot node -e "
const { PrismaClient } = require(\"/app/node_modules/.prisma/client-stablecoin\");
const p = new PrismaClient();
p.makerTakerSimBot.updateMany({ where: { id: { in: [1,2,3] } }, data: { live: true } })
  .then(r => console.log(\"updated count:\", r.count))
  .finally(() => p.\$disconnect());
"'
```

확인:
```bash
ssh -i C:/pem/54.180.188.8.pem ubuntu@54.180.188.8 \
  'docker exec grid-bot node -e "const { PrismaClient } = require(\"/app/node_modules/.prisma/client-stablecoin\"); const p = new PrismaClient(); p.makerTakerSimBot.findMany({ select: { id: true, enabled: true, live: true, killSwitch: true, minSpreadKrw: true, bidOffsetKrw: true, lastResumeAt: true } }).then(r => console.table(r)).finally(() => p.\$disconnect());"'
```

기대 모두: `enabled=true, live=true, killSwitch=false, minSpreadKrw=12, lastResumeAt=<T_start>`.

### 2-C. 가동 직후 5분 모니터링

T_start + 5분 시점:
1. 백엔드 로그 tail:
   ```bash
   ssh -i C:/pem/54.180.188.8.pem ubuntu@54.180.188.8 'docker logs --tail=200 -f grid-bot 2>&1 | grep -E "(maker-taker|spread|placement|FILLED|killSwitch|MinBalance|reconcil)"'
   ```
2. 에이전트 errors=0 유지 확인 (단계 1-E 명령어)
3. 첫 placement 시도 발생 확인 (sim period 후 첫 sim->live placement)

이상 시 즉시 단계 5 (Rollback) 로 이동.

---

## 단계 3: 24h 관찰 윈도우

T_start + 0h ~ T_start + 24h. 정기 체크는 다음 인터벌:

| 시점 | 확인 항목 |
|------|---------|
| T+1h | 첫 placement, errors=0, 로그 이상 패턴 |
| T+6h | 첫 FILLED row 여부, MinBalanceGuard 트리거 안됨 |
| T+12h | FILLED 누적, killSwitch 트리거 안됨 |
| T+24h | 단계 4 종료 검증 |

### 3-A. 정기 상태 확인 명령

```bash
ssh -i C:/pem/54.180.188.8.pem ubuntu@54.180.188.8 \
  'docker exec grid-bot node -e "
const { PrismaClient } = require(\"/app/node_modules/.prisma/client-stablecoin\");
const p = new PrismaClient();
(async () => {
  const bots = await p.makerTakerSimBot.findMany({ select: { id: true, enabled: true, live: true, killSwitch: true, lastResumeAt: true } });
  console.log(\"--- BOTS ---\");
  console.table(bots);
  const trades = await p.makerTakerSimTrade.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 24*3600*1000) } },
    select: { id: true, botId: true, status: true, makerSide: true, createdAt: true, filledAt: true, profitKrw: true }
  });
  console.log(\"--- TRADES (24h) ---\");
  console.table(trades);
})().finally(() => p.\$disconnect());
"'
```

⚠️ 모델/필드명은 schema.prisma 와 다를 수 있음 — 실행 시 에러나면 schema 재확인.

### 3-B. 첫 FILLED 발생 시 즉시 spec § 2 검증

첫 FILLED row 가 발견되면 (T+6h 안에 발생 가능성 높음):

1. 거래소 실제 주문 확인:
   - Upbit 거래내역 조회 → 같은 시각에 maker (USDS bid) + taker (USDT ask) 양쪽 done order 존재 확인
   - 두 주문이 동일 quantity (또는 비례) 인지 확인
2. KRW 우회 패턴 (Stage 1 실패 패턴) 미발생 확인:
   - 같은 시각에 USDT/KRW market sell + USDS/KRW market buy 가 발생했으면 spec 이탈
3. P&L 계산 확인:
   - DB profitKrw 와 직접 계산 (taker_filled_krw - maker_filled_krw - fees) 일치 여부

이 부분이 PR D 캐너리 Stage 1 실패 사유의 핵심 검증. **불일치 시 즉시 단계 5 Rollback.**

### 3-C. 안전장치 트리거 모니터링

로그 grep:
```bash
ssh -i C:/pem/54.180.188.8.pem ubuntu@54.180.188.8 \
  'docker logs --since=1h grid-bot 2>&1 | grep -E "(killSwitch|MinBalanceGuard|BalancePrecheck|autoPause|spread.*<)"'
```

발생 시:
- killSwitch 자동 ON: 즉시 원인 분석 (잔고 부족? 거래소 에러? 과거 N분 이내 fill 미달성?)
- MinBalanceGuard autoPause: 의도된 동작. 봇 자동으로 enabled=false. 잔고 보충 후 enabled=true 가능.
- spread<12 skip: 정상 동작 (PR H 의도). placement 안 일어난 것 = 손실 회피.

---

## 단계 4: T+24h 종료 검증

### 4-A. 🔍 Reconciliation 자동 검증

각 봇 #1, #2, #3 의 Admin UI 패널에서 🔍 Verify 버튼 클릭. 또는:

```bash
# JWT 토큰 필요 (admin 계정 로그인 후 localStorage 또는 응답 헤더에서 추출)
TOKEN="<admin_jwt>"
for id in 1 2 3; do
  echo "=== Bot #$id ==="
  curl -s -X POST -H "Authorization: Bearer $TOKEN" \
    "http://54.180.188.8:3010/api/admin/stablecoin/maker-bots/$id/verify-reconciliation" \
    | python -m json.tool
done
```

기대: 각 봇 응답 `isReconciled=true`. `pageTruncated=true` 면 Upbit 100건 페이징 한계 — Stage 3 단일 봇 24h 에서는 거의 불가 (현재 시뮬 결과 FILLED 1건/봇 정도 예상).

### 4-B. 통계 집계

```bash
ssh -i C:/pem/54.180.188.8.pem ubuntu@54.180.188.8 \
  'docker exec grid-bot node -e "
const { PrismaClient } = require(\"/app/node_modules/.prisma/client-stablecoin\");
const p = new PrismaClient();
(async () => {
  const bots = await p.makerTakerSimBot.findMany({ select: { id: true, bidOffsetKrw: true, lastResumeAt: true } });
  for (const b of bots) {
    const since = b.lastResumeAt;
    const trades = await p.makerTakerSimTrade.findMany({
      where: { botId: b.id, createdAt: { gte: since } },
      select: { status: true, profitKrw: true, createdAt: true, filledAt: true }
    });
    const filled = trades.filter(t => t.status === \"FILLED\");
    const totalProfit = filled.reduce((s, t) => s + Number(t.profitKrw ?? 0), 0);
    console.log(\`Bot #\${b.id} (bidOffsetKrw=\${b.bidOffsetKrw}): total=\${trades.length} filled=\${filled.length} totalProfitKrw=\${totalProfit}\`);
  }
})().finally(() => p.\$disconnect());
"'
```

집계 항목:
- 봇별 placement 시도 수
- 봇별 FILLED 건수
- 봇별 net profit (KRW)
- bidOffsetKrw 0/-4/-6 비교 → 어느 설정이 fill rate × profit 곱이 가장 큰지

### 4-C. spread skip rate 분석

PR H minSpreadKrw=12 게이트가 얼마나 자주 placement 를 막았는지 확인. 로그 또는 별도 메트릭 (구현 안 됐으면 logical estimate):

```bash
ssh -i C:/pem/54.180.188.8.pem ubuntu@54.180.188.8 \
  'docker logs --since=24h grid-bot 2>&1 | grep -c "spread.*KRW.*<.*minSpreadKrw"'
```

기대: 0이 아닌 값 (스킵 발생 = 게이트 작동 증거). 실제 placement 시도 수 대비 비율 계산.

### 4-D. Exit 기준 판정

| 항목 | 기준 | 결과 |
|------|------|------|
| FILLED | ≥1건 (전체) | ✅ 또는 ❌ |
| spec § 2 정합 | 첫 FILLED 직접 검증 (단계 3-B) | ✅ 또는 ❌ |
| Net profit | ≥0 KRW (전체 합산) | ✅ 또는 ❌ |
| 안전장치 false positive | killSwitch / MinBalanceGuard 의도외 트리거 0건 | ✅ 또는 ❌ |
| spread gate 작동 | spread<12 시 skip 발생 | ✅ 또는 ❌ |

**전부 ✅** → Stage 3 SUCCESS, Stage 4 (장기 운영) 검토.
**하나라도 ❌** → Stage 3 FAIL, 단계 5 Rollback + 후속 분석.

---

## 단계 5: Rollback 절차 (실패 또는 이상 시)

심각도별로 단계적 적용. 더 가벼운 단계로 충분한 경우 다음 단계로 진행 안 함.

### Tier 1: 즉시 정지 (killSwitch ON)

가장 빠름. placement 즉시 중단, 기존 PENDING 주문은 유지.

Admin UI: 봇 #1, #2, #3 각각 ⛔ killSwitch 토글 ON.

또는 DB:
```bash
ssh -i C:/pem/54.180.188.8.pem ubuntu@54.180.188.8 \
  'docker exec grid-bot node -e "
const { PrismaClient } = require(\"/app/node_modules/.prisma/client-stablecoin\");
const p = new PrismaClient();
p.makerTakerSimBot.updateMany({ where: { id: { in: [1,2,3] } }, data: { killSwitch: true } })
  .then(r => console.log(\"killSwitch ON:\", r.count))
  .finally(() => p.\$disconnect());
"'
```

### Tier 2: enabled=false (봇 완전 중지)

placement + 기존 PENDING 모니터링도 중지.

Admin UI: ⏸️ Pause 클릭. 또는 DB:
```bash
ssh -i C:/pem/54.180.188.8.pem ubuntu@54.180.188.8 \
  'docker exec grid-bot node -e "
const { PrismaClient } = require(\"/app/node_modules/.prisma/client-stablecoin\");
const p = new PrismaClient();
p.makerTakerSimBot.updateMany({ where: { id: { in: [1,2,3] } }, data: { enabled: false } })
  .then(r => console.log(\"enabled OFF:\", r.count))
  .finally(() => p.\$disconnect());
"'
```

### Tier 3: live=false (sim 모드 복귀)

코드는 그대로, 단지 실거래만 중단. PR H 안전장치는 유지.

```bash
ssh -i C:/pem/54.180.188.8.pem ubuntu@54.180.188.8 \
  'docker exec grid-bot node -e "
const { PrismaClient } = require(\"/app/node_modules/.prisma/client-stablecoin\");
const p = new PrismaClient();
p.makerTakerSimBot.updateMany({ where: { id: { in: [1,2,3] } }, data: { live: false } })
  .then(r => console.log(\"live OFF:\", r.count))
  .finally(() => p.\$disconnect());
"'
```

### Tier 4: 코드 revert (PR H 머지 자체가 회귀 유발 시)

`gh pr revert` 또는 main 에 revert 커밋. 실 사고 시에만.

```bash
gh pr create --base main --head revert-pr-h --title "revert: PR H — Canary Stage 3 사전 정비"
```

⚠️ 마이그레이션 (`minSpreadKrw`, `lastResumeAt` 컬럼) 은 revert 안 함 (역방향 마이그레이션 위험). 컬럼은 남겨두고 default 값 (12, NULL) 으로만 두면 영향 없음.

---

## 단계 6: 사후 검토 + Stage 4 결정

T+24h 통계 + 단계 4 결과를 사용해서:

1. **Memory 업데이트**: `~/.claude/projects/.../memory/project_canary_stage_3_complete_<date>.md` 작성 — Stage 2 메모리 패턴 따름.
2. **Stage 4 판정**:
   - SUCCESS + bidOffsetKrw 비교 결과 명확 → 최선 설정 단일 봇으로 7일 장기 운영
   - SUCCESS but profit 미세 → minSpreadKrw 14 또는 15 로 상향 후 Stage 3.5 재검토
   - FAIL → 원인별 분기 (spec 이탈/안전장치 false positive/시장 환경 변화)
3. **다음 PR 후속 액션** (필요 시):
   - `verifyMakerBotReconciliation` controller 의 `instanceof AppError` 가드 추가
   - `serializeMakerBot` minSpreadKrw 라인 중복 제거
   - ReconciliationDialog `!== "0"` 문자열 비교 → 숫자 비교
   - patchMakerBot 의 `enabled false→true` 외 `live false→true` 도 lastResumeAt 갱신 대상에 포함 검토

---

## 부록 A: 알려진 위험 + 완화

| 위험 | 가능성 | 영향 | 완화 |
|------|--------|------|------|
| 첫 FILLED 가 spec § 2 위반 (KRW 우회 패턴) | 낮음 (PR E2 머지됨) | CRITICAL | 단계 3-B 즉시 검증 + Tier 2 Rollback |
| MinBalanceGuard false positive | 중간 | MEDIUM | 단계 3-C 모니터링, autoPause 후 잔고 보충 |
| Upbit API rate limit | 낮음 | LOW | 6 에이전트 정상 동작 = 현재 한도 내 |
| 24h 동안 FILLED 0건 (spread<12 lock) | 중간 | LOW | minSpreadKrw 11 또는 10 로 하향 후 Stage 3.5 |
| RDS 스냅샷 미생성 | 낮음 | HIGH (사고 시 복구 어려움) | 단계 1-A 필수, available 확인 후 진행 |
| ReconciliationDialog 의 pageTruncated=true | 낮음 (24h 데이터 적음) | MEDIUM | 직접 Upbit 거래내역 페이징 조회로 보강 |

## 부록 B: 참고 spec/plan

- `docs/superpowers/specs/2026-04-30-canary-stage-3-readiness-design.md` — PR H 설계 (코드 변경 부분)
- `docs/superpowers/plans/2026-04-30-canary-stage-3-readiness.md` — PR H 구현 계획
- 메모리: `project_canary_stage_2_complete_2026_04_30.md` — Stage 2 결과 (-4.905 KRW 손실, T+5.5h 첫 FILLED)
- 메모리: `project_pr_h_canary_stage_3_readiness_pushed_2026_04_30.md` — PR H 머지 전 시점 push 기록

## 부록 C: 시간표 예시 (T_start = 2026-05-01 21:00 KST 가정)

| 시각 KST | 이벤트 |
|----------|--------|
| 2026-05-01 20:30 | 단계 1 Pre-flight (스냅샷 시작, 백엔드 health 확인) |
| 2026-05-01 20:55 | 단계 1 완료 확인 |
| 2026-05-01 21:00 | T_start: 단계 2 가동 (enabled cycle + live=true) |
| 2026-05-01 21:05 | 단계 2-C 5분 모니터링 |
| 2026-05-01 22:00 | T+1h 점검 |
| 2026-05-02 03:00 | T+6h 점검 (첫 FILLED 가능성 시점) |
| 2026-05-02 09:00 | T+12h 점검 |
| 2026-05-02 21:00 | T+24h 단계 4 종료 검증 |
| 2026-05-02 22:00 | 단계 6 메모리 업데이트, Stage 4 결정 |
