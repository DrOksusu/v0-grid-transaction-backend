# PR D — Maker-Taker Canary Stage 1 운영 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PR C에서 머지된 Maker-Taker live executor를 운영 환경에서 처음으로 활성화한다 — maker bot 5개 중 **1개만** `live=true`로 토글하고 24시간 관측 후 결과로 다음 PR(E) 방향을 결정한다.

**Architecture:** 코드 변경 없음. 100% 운영 절차 plan. (1) 사전 헬스 검증 → (2) RDS 수동 스냅샷 → (3) Canary 후보 봇 1개 선정 → (4) Admin UI/API로 `live=true` PATCH → (5) T+5min/T+4h/T+12h/T+24h 체크포인트 관측 → (6) 결과 분류 후 메모리 기록 + 다음 단계 결정. 실패 신호 발견 즉시 롤백.

**Tech Stack:** AWS CLI (Lightsail), curl + Admin UI, MySQL/Prisma raw query, SSH + docker logs.

**전제 조건:**
- PR C(백엔드 #15 + 프론트 #3)가 main에 머지되어 있고 Lightsail 컨테이너에 배포 완료 (세션 11 핸드오프 §"30초 요약" 확인됨)
- 사용자가 명시적으로 Canary 활성화를 승인 (운영 risk가 있으므로 task 1 완료 후 사용자 확인 게이트 있음)

---

## 안전 원칙 (한 번 더 확인)

1. **maker bot live 활성화는 1개만** — 다중 활성화 시 손실 누적 + auto-killswitch trigger 위험 (단, MakerTakerSimBot에는 자동 손실 한도가 없으므로 사람의 모니터링이 유일한 방어선이라는 점 인지)
2. **destructive 쿼리 production 실행 금지** — `DROP/TRUNCATE/DELETE FROM` 전체. `SELECT`만 사용
3. **시크릿 채팅 출력 금지** — `.env`, `docker inspect`, SSH 명령은 항상 `sed -E 's|(mysql://)([^:]+):.*|\\1\\2:***|'` 마스킹
4. **롤백 < 5분 가능 상태 유지** — task 9에 즉시 롤백 절차 있음. 의심 신호 발견 시 분석보다 롤백 우선
5. **plan 외 추가 변경 금지** — 코드 수정/배포는 이번 plan 범위 밖. 발견된 버그는 메모하고 다음 PR로

---

## File Structure

코드 변경 없음. 본 plan에서 생성/수정되는 파일은 다음 2개:

- **수정**: 없음 (운영 plan)
- **생성**: 
  - `~/.claude/projects/D--ExpressProject-Grid-project/memory/project_pr_d_canary_observation_2026_04_27.md` (Task 8에서 관측 결과 영구 기록)
  - `~/.claude/projects/D--ExpressProject-Grid-project/memory/MEMORY.md` 인덱스에 위 파일 한 줄 추가 (Task 8)

---

## Task 1: 사전 헬스 검증 + 후보 봇 정보 수집

**목표:** PR C 배포가 정상 가동 중인지 확인 + Canary 후보 봇을 선정할 수 있는 데이터 수집.

**Files:** 변경 없음 (read-only).

- [ ] **Step 1: Backend 헬스 확인**

```bash
curl -s http://54.180.188.8:3010/api/health
```

기대: `{"status":"ok",...}` 류의 200 응답. 503/타임아웃이면 즉시 중단하고 사용자에게 보고.

- [ ] **Step 2: 6개 에이전트 상태 (errors=0 확인)**

```bash
curl -s http://54.180.188.8:3010/api/agents | python -c "import json,sys; r=json.load(sys.stdin); [print(f'{a[\"name\"]:30s} status={a[\"status\"]:10s} errors={a[\"metrics\"][\"errors\"]}') for a in r['data']]"
```

기대 출력 (6개 에이전트 모두 running, errors=0):
```
GridAgent                      status=running    errors=0
InfiniteBuyAgent               status=running    errors=0
VRAgent                        status=running    errors=0
StablecoinArbAgent             status=running    errors=0
CrossExchangeObserver          status=running    errors=0
MakerTakerSimulatorAgent       status=running    errors=0
```

errors > 0인 에이전트가 있으면 task 종료 — 사용자에게 보고하고 PR D 일정 재조정 권고.

- [ ] **Step 3: maker bot 5개 현재 상태 조회 (Admin API)**

먼저 Admin 토큰 확보가 필요. 브라우저로 `/admin/stablecoin` 접속 후 DevTools → Application → Cookies → 토큰 복사. 또는 기존 admin login curl 패턴 사용:

```bash
# 토큰을 환경변수로 export 후 사용 (history에 비번 남기지 말 것)
read -s -p "Admin JWT 토큰 입력: " ADMIN_TOKEN
echo

curl -s http://54.180.188.8:3010/api/admin/stablecoin/maker-bots \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | python -m json.tool
```

기대: 5개 봇이 JSON 배열로 반환. 각 봇의 다음 필드 확인:
- `id`, `userId`, `enabled`, `killSwitch`, `live` (현재 모두 false 기대)
- `makerCoin`, `takerCoin`, `bidOffsetKrw`, `quantity`, `maxPendingMs`, `minTakerBidKrw`
- `makerFeeBps`, `takerFeeBps`

- [ ] **Step 4: 시뮬레이터 누적 결과 (PR C 머지 전후 base rate)**

PR C 머지 전 시뮬레이터 데이터로 어떤 봇이 가장 안정적이었는지 확인.

```bash
curl -s http://54.180.188.8:3010/api/admin/stablecoin/sim/overview \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | python -m json.tool
```

기대: `bots[]`, `stats[]`, `recentTrades[]`. 각 봇의 다음 통계가 후보 선정 근거:
- `total_trades`, `filled_count`, `expired_count`, `avg_spread_bps`, `total_net_profit_krw`
- 시뮬레이터 trade가 0건인 봇은 후보에서 제외 (가설 검증 데이터 부족)
- avg_spread_bps가 음수인 봇도 제외 (실거래에서도 손실 가능성 큼)

- [ ] **Step 5: 후보 봇 1개 선정 + 임계값 결정 사용자 확인 게이트**

위 데이터를 한 줄 요약 + 봇 quantity 기반 절대 KRW 임계값 제안을 사용자에게 보고:

```
후보: bot id=N (USDT→USDC, bidOffset=-K, quantity=Q, sim 48h: filled F/total T, avg spread S bps, net profit P KRW)
근거: (a) 시뮬레이터 base rate 양호 (b) 0% 또는 낮은 수수료 페어 (c) quantity 작아 손실 시 영향 제한
대안: bot id=M (USD1 0% 수수료, ...)

판정 임계값 제안 (24h 기준 절대 KRW, qty=Q에서):
  - SUCCESS_FLOOR_KRW: -1000  (이 이상이면 SUCCESS 후보)
  - FAIL_CEILING_KRW:  -5000  (이 이하이면 즉시 FAIL/롤백)
  - 사이 구간(-5000 < net < -1000): MIXED
근거: qty=Q면 시뮬레이터 평균 trade당 손익이 ±X KRW이므로 24h N건 가정 시 합리적 손실 한도
```

**STOP — 사용자가 다음 4가지 모두 명시적으로 승인해야 다음 task 진행:**
1. 어느 봇 (`CANARY_BOT_ID`)
2. SUCCESS_FLOOR_KRW 값 (Task 7 success 판정용)
3. FAIL_CEILING_KRW 값 (Task 7 fail 판정용 + Task 5/6 조기 abort 판정용)
4. (선택) 사용자가 다른 임계값 체계를 원하면 그 값으로

승인된 값들은 환경변수로 export하여 task 4~7에서 일관 사용:
```bash
export CANARY_BOT_ID=<승인된 id>
export SUCCESS_FLOOR_KRW=<승인된 값>
export FAIL_CEILING_KRW=<승인된 값>
```

사용자 미승인 상태에서 절대 PATCH 금지.

---

## Task 2: AWS Lightsail RDS 수동 스냅샷 생성

**목표:** PR D 활성화 직전 시점의 DB 스냅샷을 확보. 실패 시 PITR + 스냅샷 복원으로 24시간 이내 데이터 손실 0건 복구 가능 상태.

**Files:** 변경 없음.

- [ ] **Step 1: 정확한 RDS instance 이름 확인**

세션 9~11 핸드오프와 secrets.local.md의 표기가 혼재함 (`Grid-bot-DB-v2` vs `grid-bot-DB-v2`). 실제 이름은 AWS에서 직접 조회:

```bash
aws lightsail get-relational-databases \
  --region ap-northeast-2 \
  --query 'relationalDatabases[].{name:name,state:state,engine:engine}' \
  --output table
```

기대: 정확한 instance name 1개 확인. 출력에 보이는 `name` 필드 값을 다음 step에서 그대로 사용.

- [ ] **Step 2: 스냅샷 이름 변수화 + 실행**

```bash
RDS_NAME="<step1에서 확인한 정확한 이름>"
SNAP_NAME="pre-pr-d-canary-$(date -u +%Y%m%d-%H%M%S)"

aws lightsail create-relational-database-snapshot \
  --region ap-northeast-2 \
  --relational-database-name "$RDS_NAME" \
  --relational-database-snapshot-name "$SNAP_NAME"
```

기대: `operations[]` JSON 응답. `status: "Started"` 확인.

- [ ] **Step 3: 스냅샷 진행 상태 폴링 (available까지)**

```bash
# 1~2분 대기 후 첫 확인
aws lightsail get-relational-database-snapshot \
  --region ap-northeast-2 \
  --relational-database-snapshot-name "$SNAP_NAME" \
  --query 'relationalDatabaseSnapshot.{name:name,state:state,createdAt:createdAt,sizeInGb:sizeInGb}'
```

state가 `pending` → `available`로 전환될 때까지 1분 간격 재조회. 보통 3~10분 소요.

`available` 확인되면 다음 task 진행. `failed`이면 task 종료, 사용자 보고.

- [ ] **Step 4: 스냅샷 메타정보 메모 저장**

```bash
echo "PR D Canary pre-snapshot: $SNAP_NAME (instance: $RDS_NAME)" \
  >> ~/.claude/projects/D--ExpressProject-Grid-project/memory/.tmp_pr_d_snapshot.txt
```

(임시 파일. Task 8에서 영구 메모리로 옮긴 후 삭제)

---

## Task 3: Canary 봇 1개 활성화 (live=true PATCH)

**목표:** Task 1 step 5에서 사용자가 승인한 봇 1개의 `live` 필드를 `true`로 변경.

**Files:** 변경 없음 (코드는 그대로, DB row만 업데이트).

- [ ] **Step 1: PATCH 직전 한 번 더 확인 — 다른 봇 live=false 보장**

```bash
curl -s http://54.180.188.8:3010/api/admin/stablecoin/maker-bots \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | python -c "import json,sys; bots=json.load(sys.stdin)['data']; [print(f'id={b[\"id\"]} live={b[\"live\"]} killSwitch={b[\"killSwitch\"]} enabled={b[\"enabled\"]}') for b in bots]"
```

기대: 모든 봇 `live=False`. 만약 하나라도 `live=True`인 봇이 있으면 — Canary가 이미 활성화되어 있다는 뜻이므로 즉시 task 종료, 사용자에게 보고.

- [ ] **Step 2: PATCH 실행 (curl)**

```bash
CANARY_BOT_ID="<task 1 step 5에서 사용자가 승인한 봇 id>"

curl -s -X PATCH "http://54.180.188.8:3010/api/admin/stablecoin/maker-bots/$CANARY_BOT_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"live": true}' \
  | python -m json.tool
```

기대: 200 응답. 반환된 봇 객체의 `live: true`, `id: $CANARY_BOT_ID`, 다른 필드는 변동 없음.

- [ ] **Step 3: PATCH 적용 검증 (다시 list 조회)**

```bash
curl -s http://54.180.188.8:3010/api/admin/stablecoin/maker-bots \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | python -c "import json,sys; bots=json.load(sys.stdin)['data']; live=[b for b in bots if b['live']]; print(f'live 봇 수={len(live)}'); [print(f'  id={b[\"id\"]} {b[\"makerCoin\"]}->{b[\"takerCoin\"]} offset={b[\"bidOffsetKrw\"]}') for b in live]"
```

기대: `live 봇 수=1`. 1보다 크면 즉시 다른 봇 PATCH `live=false` 롤백 후 재시도.

- [ ] **Step 4: 활성화 시각 기록**

```bash
ACTIVATION_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "Canary activated at $ACTIVATION_UTC, bot id=$CANARY_BOT_ID" \
  >> ~/.claude/projects/D--ExpressProject-Grid-project/memory/.tmp_pr_d_snapshot.txt

# T+4h, T+12h, T+24h 시각도 미리 계산
python3 -c "
from datetime import datetime, timedelta
t0 = datetime.utcnow()
print(f'T+4h:  {(t0+timedelta(hours=4)).strftime(\"%Y-%m-%d %H:%M UTC\")}')
print(f'T+12h: {(t0+timedelta(hours=12)).strftime(\"%Y-%m-%d %H:%M UTC\")}')
print(f'T+24h: {(t0+timedelta(hours=24)).strftime(\"%Y-%m-%d %H:%M UTC\")}')
"
```

체크포인트 시각을 사용자에게 알려주고 cron/calendar 등록을 권고.

---

## Task 4: T+5min 즉시 검증 (활성화 직후)

**목표:** PATCH 후 5분 이내에 첫 PENDING 주문이 정상 생성되는지, killSwitch 자동 발동 안 되는지 확인.

**Files:** 변경 없음.

- [ ] **Step 1: 5분 대기 (또는 즉시 다음 step — 시뮬레이터 cycle은 보통 30초~1분)**

`MakerTakerSimulatorAgent`의 evaluate 주기가 1분 미만이면 즉시 진행 가능. 보수적으로 5분 대기 권장.

- [ ] **Step 2: 백엔드 로그에서 live executor 동작 흔적 확인**

```bash
ssh -i C:/pem/54.180.188.8.pem ubuntu@54.180.188.8 \
  'docker logs grid-bot --since 10m 2>&1 | grep -E "MakerTakerSim|maker-taker-live|placed|expired|filled|partial_hold|rolled_back" | tail -50'
```

기대 신호 (정상):
- `MakerTakerSimulatorAgent` 관련 로그 라인 존재
- `live=true` 봇에 대해 `placed` 또는 `noop`(시장 조건 미충족) 로그
- error stack trace **없음**

비정상 신호 (즉시 task 9 롤백으로 jump):
- `Error|Exception|TypeError|undefined` 패턴
- `Upbit API 5xx`, `INSUFFICIENT_FUNDS`, `INVALID_ORDER` 류
- `AUTO KILL SWITCH` 로그 라인

- [ ] **Step 3: PENDING 주문 1건 이상 생성 확인 (DB 직접 조회)**

production 컨테이너에 ts-node 없으므로 일회성 JS 파일 패턴 사용 (세션 8에서 검증됨):

```bash
cat > /tmp/check_canary_pending.js <<'EOF'
const { stablecoinPrisma } = require('/app/dist/config/database');
(async () => {
  const botId = parseInt(process.env.CANARY_BOT_ID, 10);
  const sinceMin = parseInt(process.env.SINCE_MIN || '10', 10);
  const since = new Date(Date.now() - sinceMin * 60 * 1000);
  const trades = await stablecoinPrisma.makerTakerSimTrade.findMany({
    where: { botId, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, live: true, makerOrderUuid: true, createdAt: true, notes: true },
  });
  console.log(`Bot ${botId} trades since ${since.toISOString()} (${sinceMin}min):`);
  trades.forEach(t => console.log(`  id=${t.id} status=${t.status} live=${t.live} uuid=${t.makerOrderUuid || 'null'} at=${t.createdAt.toISOString()}`));
  console.log(`Total: ${trades.length}, live: ${trades.filter(t => t.live).length}`);
  await stablecoinPrisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
EOF

scp -i C:/pem/54.180.188.8.pem /tmp/check_canary_pending.js ubuntu@54.180.188.8:/tmp/

ssh -i C:/pem/54.180.188.8.pem ubuntu@54.180.188.8 \
  "docker cp /tmp/check_canary_pending.js grid-bot:/tmp/check_canary_pending.js && \
   docker exec -e CANARY_BOT_ID=$CANARY_BOT_ID -e SINCE_MIN=10 grid-bot node /tmp/check_canary_pending.js"
```

기대: live=true trade가 1건 이상 PENDING 상태로 보임. 또는 noop으로 trade 생성 안 됨(시장 조건 미충족 — 이건 정상).

- [ ] **Step 4: killSwitch 비활성 확인**

```bash
curl -s "http://54.180.188.8:3010/api/admin/stablecoin/maker-bots" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | python -c "import json,sys; bots=json.load(sys.stdin)['data']; b=[b for b in bots if b['id']==$CANARY_BOT_ID][0]; print(f'killSwitch={b[\"killSwitch\"]} live={b[\"live\"]} enabled={b[\"enabled\"]}')"
```

기대: `killSwitch=False live=True enabled=True`. killSwitch=True면 **즉시 task 9 롤백 + 원인 분석**.

- [ ] **Step 5: 정리 (임시 JS 파일 삭제)**

```bash
ssh -i C:/pem/54.180.188.8.pem ubuntu@54.180.188.8 \
  "docker exec grid-bot rm -f /tmp/check_canary_pending.js && rm -f /tmp/check_canary_pending.js"
rm /tmp/check_canary_pending.js
```

(컨테이너/호스트 임시 파일은 Task 8 끝에 한 번 더 청소하지만, 자주 비우는 게 안전)

---

## Task 5: T+4h 체크포인트

**목표:** 활성화 4시간 후 첫 결과 점검. 봇이 정상적으로 PENDING/FILLED/EXPIRED cycle을 도는지 확인.

**Files:** 변경 없음.

- [ ] **Step 1: T+4h 도달 대기**

Task 3 step 4의 T+4h 시각까지 대기. (다른 작업 가능 — 단 cron/타이머로 본 task 시작 시점을 놓치지 말 것)

- [ ] **Step 2: 4시간 분량 거래 통계**

Task 4 step 3의 패턴 재사용, `SINCE_MIN=240`:

```bash
ssh -i C:/pem/54.180.188.8.pem ubuntu@54.180.188.8 \
  "docker exec -e CANARY_BOT_ID=$CANARY_BOT_ID -e SINCE_MIN=240 grid-bot node /tmp/check_canary_pending.js"
```

또는 통계용 별도 스크립트 (위 파일이 삭제되었다면 task 4 step 3 다시 실행).

- [ ] **Step 3: status별 집계 + 손익 합산**

```bash
cat > /tmp/canary_4h_summary.js <<'EOF'
const { stablecoinPrisma } = require('/app/dist/config/database');
(async () => {
  const botId = parseInt(process.env.CANARY_BOT_ID, 10);
  const sinceMin = parseInt(process.env.SINCE_MIN || '240', 10);
  const since = new Date(Date.now() - sinceMin * 60 * 1000);
  const trades = await stablecoinPrisma.makerTakerSimTrade.findMany({
    where: { botId, live: true, createdAt: { gte: since } },
    select: { status: true, netProfitKrw: true, realizedSpreadBps: true, notes: true, createdAt: true },
  });
  const byStatus = {};
  let totalNet = 0, totalSpread = 0, spreadCount = 0;
  trades.forEach(t => {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    if (t.netProfitKrw !== null) totalNet += Number(t.netProfitKrw);
    if (t.realizedSpreadBps !== null) { totalSpread += t.realizedSpreadBps; spreadCount++; }
  });
  console.log(`Bot ${botId} live trades since ${since.toISOString()} (${sinceMin}min):`);
  console.log('  By status:', byStatus);
  console.log(`  Total net profit (KRW): ${totalNet.toFixed(2)}`);
  console.log(`  Avg realized spread (bps): ${spreadCount > 0 ? (totalSpread / spreadCount).toFixed(1) : 'n/a'}`);
  console.log(`  Total trades: ${trades.length}`);
  // rolled_back 또는 partial_hold notes 확인
  const flagged = trades.filter(t => t.notes && /rolled_back|partial_hold|fallback/.test(t.notes));
  if (flagged.length > 0) {
    console.log(`  ⚠️  Flagged trades (${flagged.length}):`);
    flagged.slice(0, 10).forEach(t => console.log(`    [${t.createdAt.toISOString()}] ${t.status}: ${t.notes}`));
  }
  await stablecoinPrisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
EOF

scp -i C:/pem/54.180.188.8.pem /tmp/canary_4h_summary.js ubuntu@54.180.188.8:/tmp/
ssh -i C:/pem/54.180.188.8.pem ubuntu@54.180.188.8 \
  "docker cp /tmp/canary_4h_summary.js grid-bot:/tmp/canary_4h_summary.js && \
   docker exec -e CANARY_BOT_ID=$CANARY_BOT_ID -e SINCE_MIN=240 grid-bot node /tmp/canary_4h_summary.js"
```

기대 (정상):
- `By status`에 `FILLED` 1건 이상 또는 `EXPIRED` 다수 (시장 조건 미충족)
- `Total net profit` 음수가 아니거나, 음수여도 시뮬레이터 base rate 대비 -50% 이내
- `Flagged trades` 0건 (rolled_back/partial_hold가 1~2건이면 정상 fallback, 5건 이상이면 경계)

판단:
- ✅ 정상 → Task 6 (T+12h)으로 진행
- ⚠️ 경계 (flagged ≥5 또는 큰 손실) → 사용자에게 보고 후 결정 (계속 vs 조기 롤백)
- ❌ 비정상 (errors, AUTO KILL SWITCH 발동, FILLED 0건이면서 PENDING 누적 다수) → Task 9 롤백

- [ ] **Step 4: 6 에이전트 errors 카운터 재확인**

```bash
curl -s http://54.180.188.8:3010/api/agents | python -c "import json,sys; r=json.load(sys.stdin); errs=[a for a in r['data'] if a['metrics']['errors']>0]; print('errors>0 agents:', [(a['name'],a['metrics']['errors']) for a in errs] or 'none')"
```

기대: `errors>0 agents: none`. 있으면 어떤 에이전트인지 사용자에게 보고 (PR D 직접 원인 아니면 계속 가능).

- [ ] **Step 5: 4h 체크포인트 결과 한 줄 메모**

```bash
echo "T+4h: status=$BY_STATUS, net=$TOTAL_NET KRW, spread=$AVG_SPREAD bps, flagged=$FLAGGED_COUNT, decision=continue|abort" \
  >> ~/.claude/projects/D--ExpressProject-Grid-project/memory/.tmp_pr_d_snapshot.txt
```

(값은 step 3 결과를 사람이 채워 넣음)

---

## Task 6: T+12h 체크포인트

**목표:** 절반 지점 점검. 4h 결과 대비 추세 확인.

**Files:** 변경 없음.

- [ ] **Step 1: T+12h 도달 대기**

- [ ] **Step 2: 12시간 분량 통계 (Task 5 step 3 패턴 재사용)**

```bash
ssh -i C:/pem/54.180.188.8.pem ubuntu@54.180.188.8 \
  "docker exec -e CANARY_BOT_ID=$CANARY_BOT_ID -e SINCE_MIN=720 grid-bot node /tmp/canary_4h_summary.js"
```

(스크립트 파일명은 4h용 그대로 재사용 가능. SINCE_MIN만 720으로 변경)

- [ ] **Step 3: 4h 결과 대비 추세 확인**

판단 기준:
- ✅ 정상 추세: FILLED 비율 4h와 유사 또는 증가, net profit 누적 양수 또는 small negative
- ⚠️ 추세 악화: 4h 대비 net profit이 더 음수, EXPIRED 비율 급증, flagged trade 증가
- ❌ 즉시 abort: 새로운 errors, AUTO KILL SWITCH 발동, 또는 4h 대비 손실 2배 이상

- [ ] **Step 4: 12h 체크포인트 결과 메모**

```bash
echo "T+12h: status=$BY_STATUS, net=$TOTAL_NET KRW, spread=$AVG_SPREAD bps, trend=$TREND, decision=continue|abort" \
  >> ~/.claude/projects/D--ExpressProject-Grid-project/memory/.tmp_pr_d_snapshot.txt
```

추세가 악화면 즉시 Task 9로 jump. 정상이면 Task 7로.

---

## Task 7: T+24h 체크포인트 + 결과 분류

**목표:** 24시간 관측 종료. 데이터로 PR D 성공/실패 판정.

**Files:** 변경 없음.

- [ ] **Step 1: T+24h 도달 대기**

- [ ] **Step 2: 24시간 전체 통계**

```bash
ssh -i C:/pem/54.180.188.8.pem ubuntu@54.180.188.8 \
  "docker exec -e CANARY_BOT_ID=$CANARY_BOT_ID -e SINCE_MIN=1440 grid-bot node /tmp/canary_4h_summary.js"
```

- [ ] **Step 3: 시뮬레이터 base rate 대비 비교**

같은 봇의 PR C 머지 전 시뮬레이터 결과와 비교:

```bash
cat > /tmp/canary_compare_sim.js <<'EOF'
const { stablecoinPrisma } = require('/app/dist/config/database');
(async () => {
  const botId = parseInt(process.env.CANARY_BOT_ID, 10);
  const liveSince = new Date(Date.now() - 1440 * 60 * 1000);
  const simWindow = 1440 * 60 * 1000; // 시뮬레이터 비교용 동일 윈도우

  // Live 24h
  const liveTrades = await stablecoinPrisma.makerTakerSimTrade.findMany({
    where: { botId, live: true, createdAt: { gte: liveSince } },
    select: { status: true, netProfitKrw: true, realizedSpreadBps: true },
  });

  // Sim 24h (live 시작 직전 24h)
  const simEnd = liveSince;
  const simStart = new Date(simEnd.getTime() - simWindow);
  const simTrades = await stablecoinPrisma.makerTakerSimTrade.findMany({
    where: { botId, live: false, createdAt: { gte: simStart, lt: simEnd } },
    select: { status: true, netProfitKrw: true, realizedSpreadBps: true },
  });

  function summarize(label, trades) {
    const filled = trades.filter(t => t.status === 'FILLED').length;
    const totalNet = trades.reduce((s, t) => s + (t.netProfitKrw ? Number(t.netProfitKrw) : 0), 0);
    const spreads = trades.filter(t => t.realizedSpreadBps !== null).map(t => t.realizedSpreadBps);
    const avgSpread = spreads.length > 0 ? spreads.reduce((s,x)=>s+x,0)/spreads.length : null;
    console.log(`${label}: total=${trades.length} filled=${filled} fillRate=${trades.length>0?(filled/trades.length*100).toFixed(1):'n/a'}% net=${totalNet.toFixed(2)} avgSpread=${avgSpread!==null?avgSpread.toFixed(1):'n/a'}`);
    return { count: trades.length, filled, totalNet, avgSpread };
  }
  const live = summarize('LIVE 24h', liveTrades);
  const sim = summarize('SIM  24h (직전)', simTrades);
  if (sim.filled > 0 && live.filled > 0) {
    console.log(`\nFill rate diff: live ${(live.filled/live.count*100).toFixed(1)}% vs sim ${(sim.filled/sim.count*100).toFixed(1)}%`);
    console.log(`Net profit diff: live ${live.totalNet.toFixed(2)} vs sim ${sim.totalNet.toFixed(2)} KRW`);
  }
  await stablecoinPrisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
EOF

scp -i C:/pem/54.180.188.8.pem /tmp/canary_compare_sim.js ubuntu@54.180.188.8:/tmp/
ssh -i C:/pem/54.180.188.8.pem ubuntu@54.180.188.8 \
  "docker cp /tmp/canary_compare_sim.js grid-bot:/tmp/canary_compare_sim.js && \
   docker exec -e CANARY_BOT_ID=$CANARY_BOT_ID grid-bot node /tmp/canary_compare_sim.js"
```

- [ ] **Step 4: 결과 분류 (Task 1 step 5에서 승인된 절대 KRW 임계값 사용)**

`SUCCESS_FLOOR_KRW`, `FAIL_CEILING_KRW`는 task 1에서 사용자가 결정한 값. 다음 분기로 분류:

**✅ SUCCESS** (다음 모두 충족):
- 24h FILLED ≥ 1건
- 24h net profit (KRW) ≥ `$SUCCESS_FLOOR_KRW`
- AUTO KILL SWITCH 미발동 (StablecoinArbAgent의 user-scope killswitch가 발동되지 않았는지 task 1 step 2의 errors=0 확인으로 간접 검증)
- 모든 6개 에이전트 errors = 0
- rolled_back / partial_hold flagged 비율 < 10%
- → 다음 단계: PR E 작성 (Stage 2 — 봇 2~3개 추가 활성화 또는 다른 페어 확장)

**⚠️ MIXED** (SUCCESS 임계 미달이나 FAIL은 아님):
- `$FAIL_CEILING_KRW` < net profit < `$SUCCESS_FLOOR_KRW`
- 또는 FILLED ≥ 1건이나 rolled_back/partial_hold flagged 비율 10~30%
- → 다음 단계: live=false 일시 롤백 후 분석. spread 추정 오차면 spec §"방식 D WS trade 채널 구독" 재검토. 부분 fix 후 재시도 가능.

**❌ FAIL** (다음 중 하나라도 해당):
- 24h net profit (KRW) ≤ `$FAIL_CEILING_KRW`
- 어떤 에이전트든 errors > 0 (PR D 직접 원인이든 아니든 보수적 판정)
- AUTO KILL SWITCH 발동 (이 봇 또는 같은 userId의 StablecoinArbBot)
- FILLED 0건이면서 PENDING 누적 다수 (시장 미스매치 또는 주문 placement 실패)
- rolled_back/partial_hold flagged 비율 ≥ 30%
- → Task 9 즉시 실행 + 메모리에 fail mode 상세 기록

**중간 시점 조기 abort 기준 (Task 5 T+4h, Task 6 T+12h에 적용):**
- net profit (KRW) ≤ `$FAIL_CEILING_KRW`이면 24h 끝까지 기다리지 말고 즉시 Task 9
- 사유: 4h에 한도 초과면 24h엔 거의 확실히 -2배 이상

- [ ] **Step 5: 24h 체크포인트 결과 메모**

```bash
echo "T+24h: status=$BY_STATUS, net=$TOTAL_NET KRW, vs sim base rate=$DELTA%, classification=SUCCESS|MIXED|FAIL" \
  >> ~/.claude/projects/D--ExpressProject-Grid-project/memory/.tmp_pr_d_snapshot.txt
```

---

## Task 8: 결과 영구 메모리 저장 + 다음 PR 결정

**목표:** Task 7의 결과를 영구 메모리(memory/)에 기록하고 다음 세션이 후속 작업을 자연스럽게 시작할 수 있도록 함.

**Files:**
- Create: `~/.claude/projects/D--ExpressProject-Grid-project/memory/project_pr_d_canary_observation_2026_04_27.md`
- Modify: `~/.claude/projects/D--ExpressProject-Grid-project/memory/MEMORY.md` (인덱스 한 줄 추가)

- [ ] **Step 1: 임시 메모(.tmp) 정리하여 영구 메모 작성**

`.tmp_pr_d_snapshot.txt`의 내용을 다음 구조로 정리해 새 메모리 파일 생성:

```bash
cat > ~/.claude/projects/D--ExpressProject-Grid-project/memory/project_pr_d_canary_observation_2026_04_27.md <<'EOF'
---
name: PR D Canary Stage 1 관측 결과 2026-04-27
description: 첫 maker-taker live=true 24시간 관측. 분류=SUCCESS|MIXED|FAIL — 다음 PR 방향 결정 근거.
type: project
---
# PR D Canary Stage 1 관측 결과

## 사전 조건
- pre-snapshot: <SNAP_NAME> (instance: <RDS_NAME>)
- 활성화 시각 (UTC): <ACTIVATION_UTC>
- Canary 봇: id=<CANARY_BOT_ID>, <makerCoin>→<takerCoin>, bidOffset=<K>, qty=<Q>
- 활성화 직전 maker bot live=true 봇 수: 0

## 체크포인트 결과
| 시점 | FILLED | EXPIRED | rolled_back | net profit (KRW) | avg spread (bps) | decision |
|---|---|---|---|---|---|---|
| T+5min | ... | ... | ... | ... | ... | continue |
| T+4h | ... | ... | ... | ... | ... | continue |
| T+12h | ... | ... | ... | ... | ... | continue |
| T+24h | ... | ... | ... | ... | ... | <SUCCESS|MIXED|FAIL> |

## 시뮬레이터 base rate 대비
- Live 24h: total=N, filled=F, net=P KRW, avg spread=S bps
- Sim 24h (직전): total=N', filled=F', net=P' KRW, avg spread=S' bps
- delta: fill rate <PCT>%, net profit <DELTA>%

## 발견된 트레이드오프 / 버그
(관측 중 발견된 이슈 — 다음 PR에서 해결할 것들)
- ...

## 다음 PR 방향 (분류별)
- SUCCESS → PR E: Stage 2 확장 (봇 2~3개 또는 다른 페어 추가)
- MIXED → PR E: spread 추정 정확도 개선 (spec §"방식 D WS trade 채널" 검토)
- FAIL → 메인 fail mode 상세 + 다음 시도 전 수정 사항 정리

## 롤백 여부
- live=false PATCH 시각: <UTC>  (FAIL/MIXED인 경우)
- 또는 live=true 유지 (SUCCESS이면 Stage 2 시작 시까지 가동 지속 — 단 사용자 승인 필요)

## 인프라 레퍼런스 (변경 없음)
- Backend host: 54.180.188.8:3010
- DB instance: <RDS_NAME>
EOF
```

(Step 7의 결과 데이터로 위 placeholder들을 실제 값으로 채움)

- [ ] **Step 2: MEMORY.md 인덱스에 한 줄 추가**

기존 인덱스 최상단(다음 세션 재개 가이드 다음, 세션 11 핸드오프 다음)에 PR D 관측 결과를 추가:

```markdown
- 🟦 **[PR D Canary Stage 1 관측 결과 2026-04-27](project_pr_d_canary_observation_2026_04_27.md)** — 첫 maker-taker live 24h. 분류=<SUCCESS|MIXED|FAIL>. **다음 세션: PR E (Stage 2 확장 / spread 정확도 개선 / fail mode 수정)**
```

- [ ] **Step 3: 임시 파일 청소**

```bash
rm ~/.claude/projects/D--ExpressProject-Grid-project/memory/.tmp_pr_d_snapshot.txt

# 컨테이너/호스트의 일회성 JS 파일 정리
ssh -i C:/pem/54.180.188.8.pem ubuntu@54.180.188.8 \
  "docker exec grid-bot rm -f /tmp/check_canary_pending.js /tmp/canary_4h_summary.js /tmp/canary_compare_sim.js && \
   rm -f /tmp/check_canary_pending.js /tmp/canary_4h_summary.js /tmp/canary_compare_sim.js"

rm -f /tmp/check_canary_pending.js /tmp/canary_4h_summary.js /tmp/canary_compare_sim.js
```

- [ ] **Step 4: 다음 PR 방향 사용자에게 한 줄 보고**

분류 결과에 따라:
- SUCCESS: "PR E 작성 시작 권장. Stage 2는 봇 2~3개 동시 활성화 또는 다른 페어 추가."
- MIXED: "PR E 방향: spread 추정 정확도 개선. spec §방식 D WS trade 채널 구독 재검토."
- FAIL: "롤백 완료. fail mode 상세 분석 후 수정 PR 작성 필요. 24~48h cooling period 권장."

---

## Task 9: 즉시 롤백 절차 (Canary 실패 시)

**목표:** Task 4~7 어디에서든 비정상 신호 감지 시 < 5분 내 봇 비활성화 + orphan PENDING rows 정리.

**Files:** 변경 없음 (DB row 상태만 update).

> **이 task는 다른 task의 일부로 jump-in되는 비상 절차다. 평소엔 실행 안 함.**

> **Critical 순서 주의:** `enabled: false` PATCH를 먼저 한다. 이유는 두 가지:
> 1. `MakerTakerSimulatorAgent.evaluate()`의 query는 `where: { enabled: true, killSwitch: false }` (line 82) — `enabled: false`면 봇 자체가 skip되어 시뮬레이터/live 분기 둘 다 호출 안 됨
> 2. **`live: false`만 PATCH하면 시뮬레이터 분기(line 123-126)가 `live` 필터 없이 PENDING을 잡아** EXPIRED/fill로 잘못 처리할 수 있음 → live=true 실거래 PENDING의 DB 상태가 실제 Upbit 주문과 무관하게 변경되는 race
> 후속 정상 재가동 시에는 PATCH `{enabled: true, live: false}`로 시뮬레이터 모드 복원

- [ ] **Step 1: enabled=false PATCH (시뮬레이터/live 분기 모두 차단 — 즉시 실행)**

```bash
curl -s -X PATCH "http://54.180.188.8:3010/api/admin/stablecoin/maker-bots/$CANARY_BOT_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false, "live": false}' \
  | python -m json.tool
```

기대: 200 응답, `enabled: false, live: false`. 실패하면 Admin UI(`/admin/stablecoin`)에서 직접 토글로 fallback.

- [ ] **Step 2: PATCH 적용 검증**

```bash
curl -s "http://54.180.188.8:3010/api/admin/stablecoin/maker-bots" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | python -c "import json,sys; bots=json.load(sys.stdin)['data']; b=[b for b in bots if b['id']==$CANARY_BOT_ID][0]; print(f'enabled={b[\"enabled\"]} live={b[\"live\"]} killSwitch={b[\"killSwitch\"]}')"
```

기대: `enabled=False live=False`. 어느 하나라도 True면 step 1 재시도.

- [ ] **Step 3: 진행 중 PENDING 주문 식별 (Upbit 수동 cancel 대상 추출)**

```bash
cat > /tmp/canary_pending_check.js <<'EOF'
const { stablecoinPrisma } = require('/app/dist/config/database');
(async () => {
  const botId = parseInt(process.env.CANARY_BOT_ID, 10);
  const pending = await stablecoinPrisma.makerTakerSimTrade.findMany({
    where: { botId, live: true, status: 'PENDING' },
    select: { id: true, makerOrderUuid: true, makerOrderPrice: true, quantity: true, createdAt: true },
  });
  console.log(`PENDING live trades: ${pending.length}`);
  pending.forEach(t => console.log(`  id=${t.id} uuid=${t.makerOrderUuid || 'null'} price=${t.makerOrderPrice} qty=${t.quantity} at=${t.createdAt.toISOString()}`));
  await stablecoinPrisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
EOF
scp -i C:/pem/54.180.188.8.pem /tmp/canary_pending_check.js ubuntu@54.180.188.8:/tmp/
ssh -i C:/pem/54.180.188.8.pem ubuntu@54.180.188.8 \
  "docker cp /tmp/canary_pending_check.js grid-bot:/tmp/canary_pending_check.js && \
   docker exec -e CANARY_BOT_ID=$CANARY_BOT_ID grid-bot node /tmp/canary_pending_check.js"
```

`makerOrderUuid`가 not null인 row가 있으면 → Upbit에 실제 주문이 살아 있을 가능성. **Upbit Web UI에 로그인하여 해당 uuid 주문을 수동 cancel** (자동화하지 말 것 — 잘못된 cancel scope 위험).

`makerOrderUuid`가 null인 row만 있으면 → 주문이 Upbit에 placement 안 됐거나 placement 실패한 row. step 4에서 DB만 정리하면 됨.

- [ ] **Step 4: Upbit cancel 완료 확인 (uuid가 있던 경우만)**

Upbit Web UI에서 수동 cancel을 모두 마쳤다고 사용자가 확인한 다음 진행. cancel이 누락된 상태로 step 5를 실행하면 — Upbit 주문은 살아 있는데 DB는 CANCELLED라는 거짓 상태가 됨.

```
사용자 확인 메시지: "Upbit Web UI에서 다음 uuid를 모두 cancel 완료했는가? <step 3에서 추출한 uuid 목록>"
```

사용자 "예" 응답 받기 전까지 step 5 절대 실행 금지. uuid가 없었으면 이 step skip.

- [ ] **Step 5: orphan PENDING DB rows를 CANCELLED로 마킹 (Issue 2 해결)**

```bash
cat > /tmp/canary_mark_orphan.js <<'EOF'
const { stablecoinPrisma } = require('/app/dist/config/database');
(async () => {
  const botId = parseInt(process.env.CANARY_BOT_ID, 10);
  const now = new Date();
  // Prisma updateMany로 CANCELLED 처리 + notes에 marker 추가
  const orphans = await stablecoinPrisma.makerTakerSimTrade.findMany({
    where: { botId, live: true, status: 'PENDING' },
    select: { id: true, notes: true },
  });
  console.log(`Found ${orphans.length} orphan PENDING rows to mark CANCELLED`);
  for (const o of orphans) {
    await stablecoinPrisma.makerTakerSimTrade.update({
      where: { id: o.id },
      data: {
        status: 'CANCELLED',
        notes: (o.notes ?? '') + ` | [pr-d-rollback-orphan ${now.toISOString()}]`,
      },
    });
    console.log(`  marked id=${o.id} CANCELLED`);
  }
  await stablecoinPrisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
EOF
scp -i C:/pem/54.180.188.8.pem /tmp/canary_mark_orphan.js ubuntu@54.180.188.8:/tmp/
ssh -i C:/pem/54.180.188.8.pem ubuntu@54.180.188.8 \
  "docker cp /tmp/canary_mark_orphan.js grid-bot:/tmp/canary_mark_orphan.js && \
   docker exec -e CANARY_BOT_ID=$CANARY_BOT_ID grid-bot node /tmp/canary_mark_orphan.js"
```

기대: `Found N orphan PENDING rows to mark CANCELLED` + 각 id에 대해 `marked id=X CANCELLED` 출력. 이후 step 3 query 재실행 시 `PENDING live trades: 0` 확인.

> **왜 필요한가:** PATCH `enabled=false`만 하면 future 처리는 차단되지만 기존 PENDING rows는 영원히 PENDING으로 남는다. 향후 분석 쿼리(Task 7의 fill rate 계산 등)에서 거짓 in-flight로 카운트되어 통계가 왜곡됨. 이 단계는 Upbit 실제 상태와 DB 상태를 일치시킨다.

- [ ] **Step 6: 로그 grep으로 fail mode 추출**

```bash
ssh -i C:/pem/54.180.188.8.pem ubuntu@54.180.188.8 \
  'docker logs grid-bot --since 30m 2>&1 | grep -E "MakerTaker|maker-taker-live|Error|Exception|AUTO|killSwitch" | tail -100' \
  > /tmp/pr_d_fail_logs.txt

echo "Fail logs saved to /tmp/pr_d_fail_logs.txt — 사용자와 함께 분석"
```

- [ ] **Step 7: 임시 JS 파일 청소**

```bash
ssh -i C:/pem/54.180.188.8.pem ubuntu@54.180.188.8 \
  "docker exec grid-bot rm -f /tmp/canary_pending_check.js /tmp/canary_mark_orphan.js && \
   rm -f /tmp/canary_pending_check.js /tmp/canary_mark_orphan.js"
rm -f /tmp/canary_pending_check.js /tmp/canary_mark_orphan.js
```

- [ ] **Step 8: 사용자 보고 + 결정**

다음을 한 메시지에:
- "Canary 롤백 완료 (enabled=false, live=false). bot id=$CANARY_BOT_ID."
- "Orphan PENDING DB rows 정리: <step 5 마킹 건수>"
- "Upbit 수동 cancel 대상 uuid 수: <step 3 결과>"
- "Fail mode 요약: <step 6 grep 결과 한 줄>"
- "다음 결정 필요: (a) 즉시 디버깅 (b) cooling period 24h 후 재시도 (c) 메모리 저장 후 세션 종료"

사용자가 결정하기 전까지 Task 8(영구 메모리)로 진행하되, 분류는 FAIL로 기록. 정상 재가동 시에는 PATCH `{enabled: true, live: false}`로 시뮬레이터 모드만 복원할 것.

---

## Self-Review (plan 작성 후 자체 검토)

### 1. Spec/요구사항 coverage
세션 11 핸드오프의 PR D 항목 4가지를 모두 task에 매핑:
| 핸드오프 항목 | 매핑된 task |
|---|---|
| RDS 스냅샷 | Task 2 |
| Canary 봇 1개 활성화 (USDT→USDC 또는 USD1) | Task 1 (선정) + Task 3 (PATCH) |
| 24시간 관측 (PENDING→FILLED, leg-2 fallback, killswitch, 일일 손실) | Task 4~7 + (일일 손실은 maker bot에 없음 — plan §안전 원칙 4번에 명시) |
| 실패 시 즉시 롤백 | Task 9 |

### 2. Placeholder scan
- "TBD/TODO": 0건 ✓
- "Add appropriate error handling" 류 모호 표현: 0건 ✓
- 실제 명령어/쿼리/판단 기준이 모든 step에 들어있음 ✓
- `<placeholder>` 표기는 사용자/관측 결과로 채워야 하는 값에만 사용 (e.g. `<CANARY_BOT_ID>`, `<RDS_NAME>`) — 의도된 바

### 3. 일관성
- `CANARY_BOT_ID` 환경변수가 task 3~9 일관 사용 ✓
- `ADMIN_TOKEN` 환경변수가 task 1~9 일관 사용 ✓
- PATCH endpoint `/api/admin/stablecoin/maker-bots/:id` 일관 사용 ✓
- `stablecoinPrisma` (별도 DB) 사용 — schema가 `prisma-stablecoin/`에 있다는 발견 반영 ✓
- 일회성 JS 파일 패턴: scp → docker cp → docker exec node + 청소 (세션 8에서 검증된 패턴) 일관 ✓

### 4. 발견된 보정 사항
- 핸드오프의 관측 항목 #4 "auto-killswitch" — 정확히는 **MakerTakerSimBot에는 자동 killswitch 없음** (Prisma 모델에 `dailyLossLimitKrw` 필드 없음, agent 코드에도 없음). PR C의 auto-killswitch는 `StablecoinArbAgent`(직접 아비트리지) 한정. plan §안전 원칙 4번과 task 4 step 4에서 사람이 수동 모니터링하는 것을 명시.
- 인프라 instance 이름 `Grid-bot-DB-v2` vs `grid-bot-DB-v2` 표기 혼재 → Task 2 step 1에서 AWS 직접 조회로 정확한 이름 확보 후 사용하는 step 추가.

### 5. Advisor 점검에서 추가된 fix (2026-04-27 plan v2)
- **임계값 수학적 안정성**: 초기 plan은 "시뮬레이터 base rate ±20%" 같은 비율 기준을 썼는데, sim base rate가 0이거나 음수일 때 무의미해짐 (예: sim=-10 KRW의 ±20%는 -12~-8). → Task 1 step 5에서 사용자가 절대 KRW 임계값 (`SUCCESS_FLOOR_KRW`, `FAIL_CEILING_KRW`) 결정하고 환경변수로 export, Task 7 step 4가 그 값으로 분류.
- **Orphan PENDING rows race**: 초기 plan은 Task 9에서 `live=false`만 PATCH했는데, 코드 검증(`maker-taker-simulator-agent.ts:111-126`) 결과 시뮬레이터 분기가 `live` 필터 없이 PENDING을 잡아서 EXPIRED/fill로 잘못 처리할 수 있음. → Task 9 step 1을 `enabled=false` (line 82의 query에서 봇 자체 skip)로 변경 + step 4~5에서 Upbit 수동 cancel 후 DB orphan rows를 CANCELLED로 강제 마킹하는 단계 추가. 이로써 Upbit/DB 상태 일치 보장 + 향후 통계 왜곡 방지.

---

## 운영 시간 추정

| Task | 사람 액티브 시간 | 대기 시간 |
|---|---|---|
| Task 1 (사전 검증) | 5~10분 | — |
| Task 2 (RDS 스냅샷) | 5분 | 3~10분 (스냅샷 available 대기) |
| Task 3 (PATCH) | 3분 | — |
| Task 4 (T+5min) | 5~10분 | 5분 |
| Task 5 (T+4h) | 10분 | 4시간 |
| Task 6 (T+12h) | 10분 | 8시간 |
| Task 7 (T+24h 분류) | 15분 | 12시간 |
| Task 8 (메모리 저장) | 10분 | — |
| Task 9 (롤백, 발생 시) | 5분 | — |
| **합계 (성공 시)** | **~70분** | **~24h** |
