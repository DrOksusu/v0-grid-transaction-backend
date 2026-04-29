# PR G — Canary Stage 2 사전조건 (계획)

> 작성일: 2026-04-29 KST
> 관련: PR E2 머지 후 spec § 2 정합 live executor 검증 단계
> 선행 PR: PR F(Path C 자동 스냅샷 CI)

## 목적

PR D 사고의 교훈을 반영하여 봇 #1 live=true 재가동(canary stage 2) 전에 다음을 확정한다:

1. minTakerBalance(USDT) 자동 일시정지 임계값 설정
2. canary 임계값 정정 (netProfitKrw 단독 사용 금지, MTM/PARTIAL_HOLD count 추가)
3. 사전 RDS 스냅샷 (콘솔, 사용자 직접)
4. 가동 시작 시점에 USDT 잔고 11-20 범위 + 봇 #1 enabled=true + live=true 한 번에 적용

## 1. minTakerBalance 임계값 결정

### 메커니즘 복습 (`maker-taker-min-balance-guard.ts`)

봇이 evaluate 사이클 시작 시 USDT 잔고 < minTakerBalance면 자동 enabled=false. PR E1에서 추가된 안전장치.

### 자산 흐름 (한 사이클당)

spec § 2 cross-coin direct swap의 자산 변화:
- maker: USDS +10, KRW -1480×10 = -14770~-14850
- taker: USDT -10, KRW +1480~1490×10 = +14820~+14920
- net: USDS +10, USDT -10, KRW +30~+90 (수수료 후)

→ **USDT 잔고는 매 FILLED마다 -10 감소**. minTakerBalance가 USDT 인벤토리 하한을 결정.

### 권장값 — 가드 비교 연산자 주의 (advisor 지적)

가드 코드는 `if (takerBalance < minTakerBalance)` **strict less-than**. 즉 balance == min이면 통과(거래 진행)된다.

| minTakerBalance | 시작 USDT = N일 때 동작 | 의도 |
|---|---|---|
| 10 (= quantity) | N=10 → 10<10 false 통과 → leg-2가 10 USDT 매도 성공 → USDT=0 → 다음 사이클 0<10 정지. **이론상 OK이나 float precision/partial leg-1 edge case 위험** | 마지노선 (안전 여유 0) |
| **11** (권장) | N=15 → 15<11 false 통과 → leg-1 후 USDT=5 → 5<11 정지. **정확히 1회 FILLED 후 자동 정지** + 1 USDT 안전 여유 | canary 보수적, 1 fill semantics |
| 5 (이전 권장) | N=15 → 첫 사이클 5<10 시도 시 strict less-than에서 5<5 false 통과 → leg-2 매도 시 잔고 부족 가능 (advisor 지적) | **사용 금지** |
| null (현재) | 무한 | 인벤토리 누적 위험 |

권장값: **11** (= quantity 10 + 1 KRW 안전 여유). canary stage 2 가동 시 USDT 잔고 **11-20** 범위 확보 후 시작 → 정확히 1번의 FILLED row까지만 허용 → 그 후 자동 정지 → 검증 신호 확보 + 폭주 차단.

USDT 잔고가 21 이상이면 2회 이상 fill 가능 → canary 1-fill 의도 위반 → 시작 전 잔고 trim 필요.

### 적용 SQL (사용자 컨펌 후 실행)

`maker_taker_sim_bots` 테이블의 봇 #1만 대상:

```sql
UPDATE maker_taker_sim_bots
SET minTakerBalance = 11
WHERE id = 1;
```

봇 #2/#3은 sim 모드 전용이므로 minTakerBalance 적용 의미 없음(시뮬은 잔고 차감 안 됨). 단 Admin UI 일관성 위해 같은 값 적용 가능 — 선택 사항.

스크립트: `scripts/canary-prep-set-min-taker-balance.js` (실행 절차는 § 4 참고)

## 2. Canary 임계값 정정 (4가지 abort 조건)

PR D 임계값 `SUM(netProfitKrw) ≤ -1000`은 null 합산 = 0으로 무력화됐음. 이번 canary는 **여러 게이트를 OR 조건**으로 사용한다.

### Abort 조건 (모두 ‘하나라도 충족’ → 즉시 가동 중지)

#### G1. FILLED 누적 net 임계값
```sql
SELECT COALESCE(SUM(netProfitKrw), 0) AS sum_net
FROM maker_taker_sim_trades
WHERE botId = 1
  AND live = true
  AND status = 'FILLED'
  AND createdAt > '<T_start UTC>';
```
**Abort if `sum_net ≤ -200 KRW`**.

PR D 대비 강화 사유: minTakerBalance=11(strict less-than)로 인해 정확히 1회 FILLED만 허용됨. 임계값을 -1000에서 -200으로 낮춰 1-fill 손실 시 빠른 인지.

#### G2. PARTIAL_HOLD 누적 카운트
```sql
SELECT COUNT(*) AS partial_count
FROM maker_taker_sim_trades
WHERE botId = 1
  AND live = true
  AND status = 'PARTIAL_HOLD'
  AND createdAt > '<T_start UTC>';
```
**Abort if `partial_count ≥ 2`**.

PR D는 1회 partial 후에도 가동 지속 → 2회째 발생. 즉시 차단 위해 1회만 허용하고 2회째 abort.

#### G3. MTM (Mark-to-Market) 임계값

PARTIAL_HOLD로 보유 중인 USDS의 unrealized loss 평가:
```js
// PARTIAL_HOLD 거래의 매수 KRW
const partialBuyKrw = SUM(makerOrderPrice * quantity)
  WHERE botId=1, live=true, status='PARTIAL_HOLD', createdAt > T_start;

// 현재 USDS bid (Upbit GET /v1/orderbook)
const currentUsdsBid = orderbook.bid.price;

// 보유 USDS 수량
const heldUsds = SUM(quantity)
  WHERE same conditions;

// MTM
const mtmKrw = currentUsdsBid * heldUsds - partialBuyKrw;
// 음수가 클수록 손실
```
**Abort if `mtmKrw ≤ -500 KRW`**.

매수 후 USDS bid가 50 KRW 이상 떨어지면 abort. 페그 코인이라 통상 0~20 KRW 변동 → -500은 매우 보수적 한계.

#### G4. 시간 기반 fast-fail

```
if (T+4h && FILLED count == 0 && PARTIAL_HOLD count == 0):
  → 가동 종료 검토 (abort 아닌 wind-down)
```

PR D 임계값과 동일 — 의미 없는 가동 지속 차단.

### 모니터링 절차 (T+1h, T+4h, T+24h)

각 시점에 다음 1-shot 스크립트 실행:
```js
// scripts/canary-monitor.js (PR G에 포함)
// G1, G2, G3 SQL + Upbit orderbook 조회 + MTM 계산
// 콘솔 출력 + abort 조건 충족 시 stderr 강조
```

## 3. 사전 RDS 스냅샷

### 옵션 A — Path C(PR F) 머지 + 다음 푸시로 자동 생성 (권장)
PR F가 머지되면 어떤 푸시든 자동으로 사전 스냅샷 생성. 이번 PR G의 plan 문서/스크립트만 main에 푸시되면 자동 발생.

### 옵션 B — 콘솔에서 수동 (PR F 미적용 시)
1. AWS Console → Lightsail → Databases → `Grid-bot-DB-v2`
2. Snapshots & restore 탭 → Create snapshot
3. 이름: `pre-pr-g-canary-stage-2-20260429-<HHMM>`
4. Available 상태 확인 (3-5분)

이 스냅샷은 **봇 #1 enabled=true + live=true 변경 직전에 반드시 존재**해야 한다.

## 4. 봇 #1 가동 절차 (체크리스트)

> 다음 항목을 한 번에 확인 후 실행

### 사전조건 체크리스트
- [ ] PR F (deploy snapshot) 머지 + IAM 정책 적용 완료, 또는 § 3 옵션 B 수동 스냅샷 완료
- [ ] PR G (이 PR) 머지: 임계값 정정 plan + 모니터 스크립트 + minTakerBalance 설정 스크립트
- [ ] Upbit USDT 잔고 **11-20** 범위 확보 (`scripts/check-upbit-balance.js` 등으로 검증). 21+ 이면 trim 필요 (1-fill semantics 위반)
- [ ] 봇 #1 minTakerBalance = 11 설정 완료 (`scripts/canary-prep-set-min-taker-balance.js` 또는 Admin UI)
- [ ] killSwitch 초기 OFF 확인
- [ ] T_start 시각 기록

### 가동 (사용자 결정)
1. Admin UI 또는 SQL로 봇 #1: enabled=true, live=true 동시 설정
2. T_start 기록 (UTC)
3. 30분 이내 첫 PENDING row 생성 확인 (`SELECT * FROM maker_taker_sim_trades WHERE botId=1 AND live=true ORDER BY id DESC LIMIT 5`)

### 모니터링 일정
- T+30m: 첫 PENDING 생성 + 첫 evaluate 사이클 정상 확인
- T+1h: G1/G2/G3 점검
- T+4h: G1/G2/G3/G4 점검 + 결과 메모리 저장
- T+24h: 최종 평가

## 5. 파일 목록 (이번 PR에 포함)

```
docs/superpowers/plans/2026-04-29-pr-g-canary-stage-2-prep.md  (본 문서)
scripts/canary-prep-set-min-taker-balance.js                     (봇 #1 minTakerBalance=11 설정, idempotent)
scripts/canary-monitor.js                                        (T+1h/4h/24h 모니터링; Upbit fetch 실패 시 G3 N/A degrade)
```

> 스크립트는 NODE_ENV=production 컨테이너에서 실행 가능하도록 `/app/dist/config/database`의 `stablecoinPrisma` import 사용. 호스트에서 직접 실행은 STABLECOIN_DATABASE_URL 환경변수 필요.

## 6. PARTIAL_HOLD 발생 시 unwind 절차 (abort 시나리오)

### 발생 정의
PARTIAL_HOLD = leg-1(USDS 매수)는 체결, leg-2(USDT 매도) 부분만 미체결 상태. USDS 인벤토리 누적 + KRW 손실 위험.

### G2 Abort 트리거 (partial_count ≥ 2) — 즉시 조치
1. Admin UI 또는 SQL로 봇 #1: `enabled=false`, `live=false` 동시 적용
2. 진행 중 evaluate 사이클이 끝날 때까지 60초 대기 (race 방지)
3. PARTIAL_HOLD row 조회:
   ```sql
   SELECT id, makerOrderPrice, quantity, makerOrderUuid, takerExecutedAt
   FROM maker_taker_sim_trades
   WHERE botId = 1 AND live = true AND status = 'PARTIAL_HOLD'
   ORDER BY id DESC;
   ```
4. 보유 USDS 수동 매도 (Upbit 앱):
   - Market: KRW-USDS
   - 수량: SUM(quantity) — PARTIAL_HOLD row 합계
   - 시장가 IOC 매도
   - 실현 손익 기록

### G3 Abort 트리거 (mtmKrw ≤ -500) — MTM 기반 즉시 청산
1. G2와 동일하게 봇 정지
2. 즉시 시장가 매도 — MTM 추가 악화 차단
3. 매도 실현가 기록 → 메모리에 incident 저장

### 자산 정리 검증 (PR D 사례 참고)
PR D 시 USDS 매수 20 = 매도 20으로 수기 정리됨 (`project_pr_d_canary_observation_2026_04_28.md` § "자산 정리 검증" 참조). 동일 절차 적용.

### Post-mortem 메모리 저장
- 파일명: `project_pr_g_canary_stage_2_<result>_2026_04_29.md`
- 포함: T_start, abort 트리거(G1/G2/G3/G4), 실현 손익, 원인 가설, 다음 단계

## 관련 메모리

- `project_pr_d_canary_observation_2026_04_28.md` — PR D abort 사례 + 임계값 무력화 원인 + USDS 자산 정리 절차
- `project_pr_e1_complete_2026_04_29.md` — minTakerBalance 안전장치 도입
- `project_pr_e2_complete_2026_04_29.md` — live executor spec 정합 + 사전조건 목록
