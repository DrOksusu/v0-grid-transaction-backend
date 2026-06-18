# BTC Long-Term Holder Regime 지표 PoC — 설계 문서

| 항목 | 값 |
|------|----|
| 작성일 | 2026-06-18 |
| 상태 | DRAFT (사용자 리뷰 대기) |
| 작업 디렉터리 | `v0-grid-tranasction-backend/`, `v0-grid-transaction-frontend/` |
| 관련 메모리 | (없음 — 신규 영역) |

---

## 1. 개요

### 목표

비트코인의 "장기 보유자 비율"(2년 이상 미이동 공급량 비율)을 일별로 수집·저장하고,
`/whale` 페이지에 시계열 차트로 표시하여 시장 사이클 바닥 신호의 시각적 검증을 가능케 한다.

### 비목표 (Non-Goals)

- 봇 자동 매매 로직과의 연동 (별도 PR로 분리)
- 알림(Socket.IO/이메일/텔레그램) 발송
- BTC 외 자산(ETH/알트)
- 백테스트나 과거 시그널 정확도 평가
- 관리자 전용 health 페이지 (별도 PR)

### 가설 — 시각 검증의 대상

"비트코인 장기 보유자(2년 이상 미이동) 비율이 높아질수록 시장 바닥에 가까울 가능성이 크다"
는 통설을 본 프로젝트 데이터로 시각 확인한다. **이 지표 단독으로 매매 의사결정을 자동화하지 않는다.**

### 한계 인식

- 사이클 샘플 수 적음 (n = 3~4)
- 지연 지표 (timing tool 아님)
- 반사성 (널리 알려질수록 alpha 소실)
- 거시 환경 무시 (금리·유동성 등)

---

## 2. 결정 사항 요약 (브레인스토밍 결과)

| # | 결정 | 값 |
|---|------|----|
| 1 | 1차 목표 | 시각화만 (봇 연동·알림 없음) |
| 2 | 추적 자산 | BTC 단독 |
| 3 | 데이터 소스 | CoinMetrics Community API (메인) + bitcoin-data.com (폴백/검증) |
| 4 | 보유 기간 컷오프 | 1년+, 2년+, 3년+ 멀티 시리즈 |
| 5 | regime 표시 방식 | 고정 컷오프 + raw 토글 |
| 6 | UI 위치 | `/whale` 페이지 상단 섹션 추가, 로그인 유저 누구나 접근 |
| 7 | 폴링 / 백필 | 매일 UTC 01:00 일 1회, 첫 가동 시 10년 백필 |

---

## 3. 아키텍처

```
                  [매일 UTC 01:00 cron]
                          ↓
       ┌──────────────────────────────────────┐
       │ MarketRegimeSchedulerService         │
       │   - 어제 날짜 1행 fetch & 저장        │
       │   - 백필 시작 시 10년 일괄            │
       └──────────────────────────────────────┘
                          ↓ 호출
       ┌──────────────────────────────────────┐
       │ MarketRegimeService                  │
       │   - fetchFromCoinMetrics()           │
       │   - fetchFromBitcoinData() [fallback]│
       │   - reconcile() → 5%p 차이 경고      │
       │   - 1y/2y/3y dormant ratio 계산      │
       └──────────────────────────────────────┘
                          ↓ Prisma
       ┌──────────────────────────────────────┐
       │ DB: btc_dormant_snapshots (일 1행)    │
       └──────────────────────────────────────┘
                          ↑ 조회
       ┌──────────────────────────────────────┐
       │ MarketRegimeController                │
       │  GET /api/market-regime/btc/current   │
       │  GET /api/market-regime/btc/timeseries│
       │       ?range=10y                      │
       │  - regime 분류 (응답 시 계산)         │
       └──────────────────────────────────────┘
                          ↑ HTTP
       ┌──────────────────────────────────────┐
       │ Frontend: /whale 페이지 새 섹션       │
       │  - <BtcDormantChart> 컴포넌트         │
       │  - 1y/2y/3y 라인 + 컷오프 가로선      │
       │  - raw 토글, range 선택 (1y/3y/5y/10y)│
       └──────────────────────────────────────┘
```

### 파일 추가/수정 목록

**백엔드 신규** (`v0-grid-tranasction-backend/`):

- `prisma/schema.prisma` — `BtcDormantSnapshot` 모델 추가
- `prisma/migrations/<timestamp>_add_btc_dormant_snapshot/migration.sql`
- `src/services/market-regime.service.ts` — fetch + reconcile + 계산
- `src/services/market-regime-scheduler.service.ts` — 일 1회 cron + 백필
- `src/controllers/market-regime.controller.ts` — 2개 엔드포인트
- `src/routes/market-regime.routes.ts` — 라우트 등록
- `src/config/market-regime.ts` — 컷오프 임계값 + API URL
- `src/index.ts` — 부팅 시 스케줄러 시작 (1줄 추가)
- `src/app.ts` — 라우트 마운트 (1줄 추가)

**프론트엔드 신규** (`v0-grid-transaction-frontend/`):

- `lib/api.ts` — `getBtcRegimeCurrent`, `getBtcRegimeTimeseries` 함수
- `components/market-regime/btc-dormant-chart.tsx`
- `components/market-regime/regime-badge.tsx`
- `components/market-regime/btc-regime-section.tsx`
- `app/whale/page.tsx` — 상단에 `<BtcRegimeSection />` 추가

### 핵심 결정 — regime 분류는 DB에 저장하지 않음

raw ratio만 저장하고 regime(BOTTOM/NEUTRAL/TOP)은 controller 응답 시 계산한다.

- 이유: 컷오프 튜닝 시 백필 재계산 불필요. PoC 단계라 임계값이 자주 바뀔 수 있음
- 컷오프는 `src/config/market-regime.ts`에 두고 env 변수로 override 가능

---

## 4. 데이터 모델

```prisma
model BtcDormantSnapshot {
  // UTC 자정 기준 일자 — 일별 1행이므로 PK
  date              DateTime @id @db.Date

  // 메인 메트릭: 1 - (SplyActNyr / SplyCur)
  // 0.00000 ~ 1.00000
  dormant1yRatio    Decimal  @db.Decimal(6, 5)
  dormant2yRatio    Decimal  @db.Decimal(6, 5)
  dormant3yRatio    Decimal  @db.Decimal(6, 5)

  // 동일 일자 BTC 가격 (regime 시각화에서 가격 오버레이용)
  // CoinMetrics PriceUSD 사용
  btcPriceUsd       Decimal  @db.Decimal(20, 8)

  // 검증/디버깅용 raw 응답 보관 (nullable)
  // 예: { "splyAct1yr": 12345678.9, "splyAct2yr": ..., "splyCur": ... }
  rawCoinmetrics    Json?
  // 예: { "1y": 0.12, "2y": 0.08, "3y": 0.05, ... }
  rawBitcoinData    Json?

  // 두 소스의 2y dormant ratio가 5%p 이상 차이나면 true
  reconcileWarning  Boolean  @default(false)

  // 어느 소스에서 가져왔는지: PRIMARY | FALLBACK | BOTH | NONE
  dataSource        String   @db.VarChar(16)

  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@index([date])
  @@map("btc_dormant_snapshots")
}
```

### 결정 사항 및 이유

| 결정 | 이유 |
|------|------|
| PK = `date` | 일별 1행 보장, 중복 insert 시 P2002 → upsert 가능 |
| `Decimal(6, 5)` | ratio 정밀도 5자리, 부동소수점 오류 방지 |
| `rawCoinmetrics`, `rawBitcoinData` JSON 보관 | 디버깅·재가공·reconcile 로직 변경 시 재계산 가능. 용량 부담 작음 (~700KB) |
| `reconcileWarning`, `dataSource` 컬럼 | "어느 날 어느 소스 실패했나" 즉시 조회 가능 |
| `regime` 컬럼 없음 | 컷오프 튜닝 시 백필 재계산 불필요 |

### 예상 데이터 크기

- 10년 백필: ~3,650행
- 한 행당 ~250바이트 (raw JSON 포함) → 전체 ~1MB

### 마이그레이션

```bash
# v0-grid-tranasction-backend/ 에서
npx prisma migrate dev --name add_btc_dormant_snapshot
```

---

## 5. 데이터 흐름

### 5.1 백필 (첫 가동 시 1회)

```
서버 부팅 시 MarketRegimeSchedulerService 시작
  ↓
DB에서 SELECT COUNT(*) FROM btc_dormant_snapshots
  ↓
0행이면 → 백필 모드 진입
  ↓
오늘 - 10년 ~ 어제까지 날짜 범위 생성
  ↓
CoinMetrics: GET /timeseries/asset-metrics
  ?assets=btc
  &metrics=SplyAct1yr,SplyAct2yr,SplyAct3yr,SplyCur,PriceUSD
  &start_time=2016-06-18
  &end_time=2026-06-17
  &frequency=1d
  &page_size=10000
  ↓ (응답 ~3650행 일괄)
bitcoin-data.com: GET /api/v1/hodl-waves
  (단일 호출로 전체 히스토리 반환)
  ↓
두 소스 데이터를 date 기준 join → reconcile 검사 → 일괄 prisma.createMany
  (skipDuplicates: true 로 멱등성 보장)
  ↓
백필 완료 INFO 로그
```

**API 호출 횟수**: 백필 시 각 소스 1~2번. CoinMetrics community rate limit (10 req/6sec) 여유.

**원자성**: `prisma.createMany`는 단일 트랜잭션. 도중 프로세스 종료 시 전체 롤백 → 다음 부팅에 처음부터 재시도 (멱등). `skipDuplicates`는 다음 부팅 재시도가 이미 들어간 row를 만나도 깨지지 않게 하는 안전망.

**스키마 검증**: 두 외부 API 응답은 zod 스키마로 검증한다. 실제 응답 필드명은 구현 첫 단계에서 한 번 fetch 떠서 확인하고 스키마에 반영한다 (CoinMetrics는 문서화가 명확하지만 bitcoin-data.com은 비공식 자료가 많음).

### 5.2 일 1회 폴링 (UTC 01:00 cron)

```
node-cron으로 매일 UTC 01:00 트리거
  ↓
어제 UTC 자정 일자 fetchDate 계산
  ↓
이미 DB에 fetchDate row 있으면 skip
  ↓
fetchFromCoinMetrics(fetchDate) → primary
fetchFromBitcoinData(fetchDate) → secondary (실패해도 진행)
  ↓
둘 다 실패 → 지수 백오프 3회 (10s, 30s, 90s)
  → 마지막 실패 시 ERROR 로그 + 다음 cron까지 holdoff
  ↓
prisma.upsert (date 기준)
  ↓
reconcile check + 5%p 이상 차이 시 reconcileWarning=true + WARN 로그
```

### 5.3 reconcile 로직

두 소스의 "2y 미이동 비율" 정의 차이를 명시한다.

- **CoinMetrics**: `SplyAct2yr` = 최근 730일 안에 한 번이라도 활성화된 supply (사토시)
  → `dormant2y_cm = 1 - SplyAct2yr / SplyCur`
- **bitcoin-data.com**: hodl-waves의 각 버킷은 "마지막 활성 시점이 해당 기간 사이"인 supply 비율
  → `dormant2y_bd = waves['2y'] + waves['3y'] + waves['5y'] + waves['7y'] + waves['10y']`

```typescript
const cmDormant2y = 1 - (cm.splyAct2yr / cm.splyCur)

// bitcoin-data.com hodl-waves 버킷 라벨은 실제 응답 schema 기준으로 매핑.
// 통념상 "2년+ 미이동" = 2~3년, 3~5년, 5~7년, 7~10년, 10년+ 버킷의 합.
// 구현 첫 단계에서 응답 한 번 fetch하여 실제 키 이름 확정 후 상수로 분리한다.
const longTermBuckets = ['2y', '3y', '5y', '7y', '10y'] as const  // 실제 키로 교체
const bdDormant2y = longTermBuckets.reduce((sum, k) => sum + bd.waves[k], 0)

if (Math.abs(cmDormant2y - bdDormant2y) > 0.05) {
  reconcileWarning = true
  logger.warn({ date, cmDormant2y, bdDormant2y }, 'reconcile diff > 5pt')
}

// 메인 값은 CoinMetrics 사용 (primary)
// CoinMetrics 실패 시에만 bitcoin-data.com 값으로 fallback
```

### 5.4 regime 분류 (controller 응답 시)

`src/config/market-regime.ts`:

```typescript
export const REGIME_THRESHOLDS = {
  '1y': { bottom: 0.70, top: 0.60 },   // 2y 대비 +5pt offset
  '2y': { bottom: 0.65, top: 0.55 },   // 메인 시리즈
  '3y': { bottom: 0.60, top: 0.50 },   // 2y 대비 -5pt offset
} as const

export type Regime = 'BOTTOM' | 'NEUTRAL' | 'TOP'

export function classifyRegime(
  ratio: number,
  series: '1y' | '2y' | '3y'
): Regime {
  const t = REGIME_THRESHOLDS[series]
  if (ratio >= t.bottom) return 'BOTTOM'
  if (ratio <= t.top) return 'TOP'
  return 'NEUTRAL'
}
```

GET `/api/market-regime/btc/current` 응답:

```json
{
  "date": "2026-06-17",
  "ratios": { "1y": 0.6754, "2y": 0.6234, "3y": 0.5612 },
  "regimes": { "1y": "NEUTRAL", "2y": "NEUTRAL", "3y": "NEUTRAL" },
  "btcPriceUsd": 91234.56,
  "thresholds": {
    "1y": { "bottom": 0.70, "top": 0.60 },
    "2y": { "bottom": 0.65, "top": 0.55 },
    "3y": { "bottom": 0.60, "top": 0.50 }
  },
  "lastFetched": "2026-06-18T01:00:23Z",
  "warnings": { "reconcileWarning": false, "dataSource": "BOTH" }
}
```

GET `/api/market-regime/btc/timeseries?range=10y` 응답:

```json
[
  { "date": "2016-06-18", "dormant1y": 0.7234, "dormant2y": 0.6543, "dormant3y": 0.5821, "btcPriceUsd": 763.45 },
  { "date": "2016-06-19", ... },
  ...
]
```

---

## 6. UI 설계

### /whale 페이지 변경

상단에 신규 섹션 추가. 기존 whale alert 섹션은 그대로 유지.

```
┌─────────────────────────────────────────────────────────┐
│ /whale 페이지                                            │
├─────────────────────────────────────────────────────────┤
│  ┌─ BTC Long-Term Holder Regime (신규) ────────────┐    │
│  │                                                  │    │
│  │  Current Regime: [NEUTRAL]    1y/2y/3y 토글     │    │
│  │  Last Updated: 2026-06-18 01:00 UTC             │    │
│  │  ⚠ reconcile warning (있을 때만)                 │    │
│  │                                                  │    │
│  │  ┌──── ComposedChart ────────────────────────┐  │    │
│  │  │  Y축 좌: dormant ratio (0~100%)          │  │    │
│  │  │  Y축 우: BTC price (USD, log scale)      │  │    │
│  │  │  ━━━ 1y dormant (옅은 색)                │  │    │
│  │  │  ━━━ 2y dormant (메인, 진한 색)          │  │    │
│  │  │  ━━━ 3y dormant (옅은 색)                │  │    │
│  │  │  ╌╌╌ BOTTOM cutoff 가로선 (65%)          │  │    │
│  │  │  ╌╌╌ TOP cutoff 가로선 (55%)             │  │    │
│  │  │  ──── BTC 가격 (점선, 우측 축)           │  │    │
│  │  └────────────────────────────────────────────┘  │    │
│  │                                                  │    │
│  │  [Range: 1Y | 3Y | 5Y | 10Y]  [컷오프 표시 토글]│    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  ─── (기존) Whale Alert 거래량 섹션 ───                  │
└─────────────────────────────────────────────────────────┘
```

### 컴포넌트 구조

```
components/market-regime/
├── btc-dormant-chart.tsx     # Recharts ComposedChart
├── regime-badge.tsx          # shadcn Badge wrapper
└── btc-regime-section.tsx    # wrapper: API 호출 + 상태 관리
```

`btc-regime-section.tsx` 책임:
1. mount 시 `getBtcRegimeCurrent()` + `getBtcRegimeTimeseries('5y')` 호출
2. 로딩/에러 상태 처리
3. range 변경 시 timeseries 재호출
4. `<RegimeBadge>` + `<BtcDormantChart>` 렌더

### API 함수 (`lib/api.ts`)

```typescript
export type Regime = 'BOTTOM' | 'NEUTRAL' | 'TOP'

export interface BtcRegimeCurrent {
  date: string
  ratios: { '1y': number; '2y': number; '3y': number }
  regimes: { '1y': Regime; '2y': Regime; '3y': Regime }
  btcPriceUsd: number
  thresholds: {
    '1y': { bottom: number; top: number }
    '2y': { bottom: number; top: number }
    '3y': { bottom: number; top: number }
  }
  lastFetched: string
  warnings: { reconcileWarning: boolean; dataSource: string }
}

export interface BtcRegimeTimeseriesPoint {
  date: string
  dormant1y: number
  dormant2y: number
  dormant3y: number
  btcPriceUsd: number
}

export async function getBtcRegimeCurrent(): Promise<BtcRegimeCurrent>
export async function getBtcRegimeTimeseries(
  range: '1y' | '3y' | '5y' | '10y'
): Promise<BtcRegimeTimeseriesPoint[]>
```

### 시각적 디자인

| 요소 | 값 |
|------|----|
| 차트 라이브러리 | Recharts (기존 프로젝트 의존성) |
| 차트 타입 | `ComposedChart` — 라인 3개 + 가격 라인 + `ReferenceLine` |
| 2y 라인 색 | 진한 보라색 (강조) |
| 1y, 3y 라인 색 | 옅은 회색 톤 |
| BTC 가격 라인 | 점선, 우측 Y축 (log scale) |
| BOTTOM cutoff | 초록 dashed `ReferenceLine` |
| TOP cutoff | 빨강 dashed `ReferenceLine` |
| Regime 배지 | shadcn `<Badge>` — BOTTOM: green, TOP: red, NEUTRAL: gray |
| Range 토글 | shadcn `<ToggleGroup>` |
| 컷오프 표시 토글 | shadcn `<Switch>` (해제 시 ReferenceLine 숨김 = raw 모드) |

### 모바일 반응형

- 차트 높이: 데스크탑 400px, 모바일 280px
- Range 토글: 모바일에서 가로 스크롤 허용
- regime 배지 + last updated: 모바일에서 2줄로 wrap

### 권한

- 모든 로그인 유저 (whale 페이지 권한과 동일)
- API 엔드포인트: 기존 `authMiddleware` 적용

---

## 7. 에러 처리

| 레이어 | 시나리오 | 처리 |
|--------|---------|------|
| fetch | CoinMetrics 4xx/5xx | 지수 백오프 3회 (10s/30s/90s) → 실패 시 bitcoin-data.com fallback |
| fetch | CoinMetrics 응답 schema 변경 | zod 스키마 검증 실패 → throw → 위와 동일 |
| fetch | 둘 다 실패 | ERROR 로그 + 다음 cron 대기. DB row 생성 안 함 |
| fetch | 네트워크 timeout | `AbortController` 30초 컷 |
| reconcile | 5%p 이상 차이 | `reconcileWarning=true` + WARN 로그. 처리는 계속 |
| DB | upsert 실패 | errorHandler 위임, ERROR 로그 |
| 백필 | 도중 중단 | 다음 부팅에 `MAX(date)+1` 부터 재개. `createMany skipDuplicates`로 멱등 |
| API | DB row 0건 | 200 + `{ status: 'backfilling', progress: 532/3650 }` |
| API | 가장 최근 row 7일+ 오래됨 | 200 + `warnings.stale: true` |
| frontend | API 503/네트워크 실패 | shadcn `<Alert>` + 재시도 버튼 |
| frontend | timeseries 빈 배열 | "데이터 백필 중 (xx%)" 안내 + 폴링 |

---

## 8. 환경 변수

`.env` (백엔드):

```
# CoinMetrics community API (인증 불필요)
COINMETRICS_API_BASE=https://community-api.coinmetrics.io/v4
COINMETRICS_API_KEY=                       # 비워두면 community tier

BITCOIN_DATA_API_BASE=https://bitcoin-data.com/api/v1

# Regime cutoff override (없으면 config 기본값)
REGIME_2Y_BOTTOM_CUTOFF=0.65
REGIME_2Y_TOP_CUTOFF=0.55

# 폴링 시각 (UTC)
MARKET_REGIME_CRON=0 1 * * *               # 매일 UTC 01:00

# 백필 범위 (년)
MARKET_REGIME_BACKFILL_YEARS=10
```

GitHub Secrets에는 secret 없음 (둘 다 무료 공개 API).
향후 Glassnode 유료 전환 시에만 API key secret 추가.

---

## 9. 운영 모니터링

`metrics.service.ts`에 카운터 4개 추가:

- `market_regime_fetch_success_total{source}`
- `market_regime_fetch_failure_total{source}`
- `market_regime_reconcile_warning_total`
- `market_regime_backfill_progress` (게이지, 0~1)

관리자 페이지 health 카드는 후속 PR로 분리.

---

## 10. 테스트 전략 (TDD)

### 유닛 (Jest)

`src/services/__tests__/market-regime.service.test.ts`:

| 케이스 | 검증 |
|--------|------|
| CoinMetrics 정상 응답 파싱 | `splyAct2yr / splyCur` → dormant ratio 정확 계산 |
| bitcoin-data.com hodl-waves 합산 | `2y+3y+5y+7y+10y` 합 == dormant2y |
| reconcile 5%p 미만 | `reconcileWarning=false` |
| reconcile 5.1%p 차이 | `reconcileWarning=true` |
| CoinMetrics 실패 → bitcoin-data fallback | dataSource=`FALLBACK` 저장 |
| 둘 다 실패 | throw + DB 미저장 |
| 백필 부분 진행 | `getBackfillProgress()` 정확한 비율 |
| `classifyRegime` boundary | 0.65 → BOTTOM, 0.649 → NEUTRAL, 0.55 → TOP |

### 통합

`src/services/__tests__/market-regime.integration.test.ts`:

- 실제 CoinMetrics에 1개 요청 — 응답 schema 검증
- bitcoin-data.com 동일
- CI에서 매 PR마다 실행 (무료 + 빠름)

### 프론트엔드 (Vitest + RTL)

`components/market-regime/__tests__/`:

- 로딩 상태 렌더링
- 정상 데이터 렌더링 (차트 snapshot)
- API 에러 시 Alert 표시
- range 변경 시 fetch 호출
- 컷오프 토글 시 `ReferenceLine` 숨김

### E2E (Playwright)

후속 PR로 분리. 첫 PR 범위 밖.

---

## 11. PR 분할

| PR | 범위 | 비고 |
|----|------|------|
| **PR #A (백엔드)** | schema + service + controller + 백필 + cron + 유닛/통합 테스트 | 먼저 머지·배포. 백필이 끝난 뒤 PR #B 작업 |
| **PR #B (프론트)** | /whale 페이지 섹션 + chart 컴포넌트 + api.ts | PR #A 머지 후 시작 권장 |
| **PR #C (옵션)** | 메트릭 카운터 + 관리자 health 카드 | 후속 작업, 본 spec 범위 밖 |

---

## 12. YAGNI — 일부러 빠진 것

- 봇 자동 연동 (브레인스토밍 Q1에서 옵션 1 선택)
- 알림 (Q1 옵션 1)
- 멀티 코인 (Q2 BTC만)
- 백분위 동적 zone (Q5 고정 컷오프 결정)
- HODL waves 풀세트 11개 시리즈 (Q4 3개 결정)
- 관리자 health 페이지 (별도 PR로 분리)
- 백테스트·과거 시그널 정확도 평가 (PoC 범위 밖)

---

## 13. 추후 고려 사항 (다음 PoC 라운드)

- PoC 결과 가설 검증되면:
  - 알림 채널 추가 (Socket.IO 푸시 / 텔레그램 / 이메일)
  - 봇 자금 배분에 regime을 가중치로 반영 (백테스트 후)
- 데이터 소스 안정성 검증 후:
  - 유료 Glassnode로 이전 (정확도/SLA 차이 비교)
  - ETH, SOL 등 멀티 자산 확장
- UI:
  - 전용 `/market-regime` 페이지로 분리 (whale 페이지 비대화 방지)
  - 다른 사이클 지표(MVRV, NUPL, Pi Cycle Top 등)와 함께 묶기

---

## 14. 변경 이력

| 일자 | 변경 |
|------|------|
| 2026-06-18 | 최초 작성 (브레인스토밍 7개 질문 답변 반영) |

---

## 15. PoC 구현 후속 조치 (2026-06-18 발견)

bitcoin-data.com fallback이 spec 가정과 실제 API가 달라 PoC에서는 실효성 없음으로 deferred:
- spec 가정: `https://bitcoin-data.com/api/v1/hodl-waves` + `{ d, '1y', '2y', ...}` schema
- 실제: `https://api.bitcoin-data.com/hodl-waves-supplies` (Spring HATEOAS) + `{ unixTs, age_2y_3y, age_3y_4y, ... }`
- PR #A 머지 후 후속 PR에서 정상화 예정 (10 req/hour rate limit 고려한 재구현)
- 그동안 CoinMetrics primary가 100% 동작 (community API 인증 불필요 확인)
