# 거래소 BTC 보유량 모니터 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CoinMetrics 무료 API로 전 세계 거래소 BTC 보유량(SplyExNtv)을 매일 수집해 메인 대시보드 카드로 보여주고(1단계), 1년 최저 갱신 시 카톡 알림 + 관리자 페이지를 붙인다(2단계).

**Architecture:** 기존 `market-regime` 패턴(설정 상수 → 외부 클라이언트(zod) → 서비스(Prisma) → node-cron 스케줄러(UTC) → 컨트롤러/라우트)을 그대로 따른다. 계산 로직(요약·최저 판정·알림 판정·메시지)은 DB/네트워크 없는 **순수 함수 파일**로 분리해 jest로 고정한다. 프론트는 자체 fetch하는 독립 카드 컴포넌트를 `app/page.tsx`에 꽂기만 한다.

**Tech Stack:** Express 5 + TypeScript, Prisma 5.22 (MySQL), node-cron 4, zod 4, jest/ts-jest / Next.js 16 + React 19, Recharts, shadcn/ui

**스펙:** `docs/superpowers/specs/2026-10-11-exchange-reserve-monitor-design.md`

---

## 단계 구분 (왜 나누는가)

| 단계 | 배포 단위 | 결과 |
|---|---|---|
| **1단계** (Task 1~14) | 백엔드 PR① + 프론트 PR① | 대시보드에 "거래소 BTC 보유량" 카드 + 차트가 뜬다. 매일 자동 갱신. **알림 없음** |
| **2단계** (Task 15~25) | 백엔드 PR② + 프론트 PR② | 1년 최저 갱신 카톡 알림(7일 쿨다운) + `/admin/exchange-reserve` 관리자 페이지 |

1단계만으로 완결된 기능이다(2단계 테이블·코드에 의존하지 않음). 2단계는 1단계 위에 얹는다.

## 사전 확인된 사실 (2026-10-11 실측)

- `GET https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=SplyExNtv,FlowInExNtv,FlowOutExNtv&frequency=1d&start_time=...&page_size=10000&paging_from=start`
  - 숫자는 **문자열**로 온다 (`"SplyExNtv":"2672865.55765548"`). `-status`/`-status-time` 부가 키가 같이 온다(무시).
  - `time` 형식: `"2026-10-09T00:00:00.000000000Z"` → 앞 10자리가 일자.
  - **기본 페이징 방향은 최신→과거(`paging_from=end`)** 다. `paging_from=start`를 반드시 넣고, 그래도 결과를 일자순 정렬한다.
  - 2024-10-01부터 1회 조회 시 739행 단일 페이지. 마지막 페이지엔 `next_page_url` 키가 **없다**. 다음 페이지가 있으면 `next_page_url`(완성 URL)이 온다.
- 백엔드 스케줄러는 `src/index.ts`의 `config.nodeEnv === 'production'` 블록 안에서만 시작한다(로컬 dev에선 안 돈다).
- production 마이그레이션은 컨테이너 기동 시 `prisma migrate deploy`로 자동 실행된다(Dockerfile CMD). 컨테이너명 `grid-bot`.
- jest: `roots: ['<rootDir>/__tests__']`, `moduleNameMapper`가 `'../config/database'` → `__mocks__/database.ts`로 바꾼다. 따라서 **`src/services/*.ts`에서 `import prisma from '../config/database'`로 쓰면 테스트에서 자동으로 mock이 붙는다.** 새 모델을 쓰면 `__mocks__/database.ts`에 해당 키를 추가해야 한다.
- 프론트 저장소는 현재 `feat/stablecoin-bulk-stop` 브랜치에 **무관한 미커밋 변경**이 있다 → 프론트 작업은 반드시 별도 worktree에서 한다(Task 10).

## File Structure

### 1단계 — 백엔드 (`v0-grid-tranasction-backend/`)
| 파일 | 책임 |
|---|---|
| Create `src/config/exchange-reserve.ts` | 상수(API URL, metric, cron, 기간들) |
| Modify `prisma/schema.prisma` | `ExchangeReserveDaily` 모델 추가 |
| Create `prisma/migrations/20261011000000_add_exchange_reserve_daily/migration.sql` | 테이블 생성 SQL |
| Create `src/services/exchange-reserve-math.ts` | 순수: 일자 유틸, `ReservePoint` 타입, `isNewLowAt()` |
| Create `src/services/exchange-reserve-summary.ts` | 순수: `computeReserveSummary()` |
| Create `src/services/exchange-reserve.client.ts` | CoinMetrics 호출·zod 파싱·페이지네이션 |
| Create `src/services/exchange-reserve.service.ts` | 백필·일일 수집(upsert)·조회 |
| Create `src/services/exchange-reserve-scheduler.service.ts` | 부팅 백필 + cron 2개(UTC) |
| Create `src/controllers/exchange-reserve.controller.ts` | `GET /api/exchange-reserve` |
| Create `src/routes/exchange-reserve.ts` | 라우터 |
| Modify `src/routes/index.ts` | 마운트 |
| Modify `src/index.ts` | production 블록에서 스케줄러 시작 |
| Modify `__mocks__/database.ts` | `exchangeReserveDaily` mock |
| Tests `__tests__/services/exchange-reserve/*.test.ts`, `__tests__/controllers/exchange-reserve.controller.test.ts` | |

### 1단계 — 프론트 (`v0-grid-transaction-frontend/`, worktree)
| 파일 | 책임 |
|---|---|
| Modify `lib/api.ts` (끝에 추가) | 타입 + `getExchangeReserve()` |
| Create `components/exchange-reserve/exchange-reserve-chart.tsx` | 보유량 면적 차트 |
| Create `components/exchange-reserve/exchange-reserve-card.tsx` | 대시보드 카드(자체 fetch, 에러 격리) |
| Modify `app/page.tsx` | 카드 삽입 |

### 2단계 — 백엔드
| 파일 | 책임 |
|---|---|
| Modify `prisma/schema.prisma` + Create `prisma/migrations/20261012000000_add_exchange_reserve_alerts/migration.sql` | 알림 설정·이력 테이블 |
| Create `src/services/exchange-reserve-alert.ts` | 순수: `decideAlert()` |
| Create `src/services/exchange-reserve-message.ts` | 순수: `buildReserveAlertMessage()` |
| Create `src/services/exchange-reserve-alert.service.ts` | 설정 조회/수정, 이력 조회, `runAlertCheck()` (카톡 발송+기록) |
| Modify `src/services/exchange-reserve-scheduler.service.ts` | 신규 데이터 시 `runAlertCheck()` 호출 |
| Create `src/controllers/exchange-reserve-admin.controller.ts`, `src/routes/exchange-reserve-admin.ts` | 관리자 API |
| Modify `src/routes/index.ts`, `__mocks__/database.ts` | |

### 2단계 — 프론트
| 파일 | 책임 |
|---|---|
| Modify `lib/api.ts` | 관리자 API 함수 3개 |
| Create `components/exchange-reserve/exchange-reserve-flow-chart.tsx` | 일별 순유입/유출 막대 |
| Create `app/admin/exchange-reserve/page.tsx` | 관리자 페이지 |
| Modify `components/admin-nav.tsx` | 메뉴 항목 추가 |

---

# 1단계 — 백필 + 조회 API + 대시보드 카드

## Task 0: 브랜치 준비 (백엔드)

- [ ] **Step 1: 백엔드 브랜치 최신화**

```bash
cd /d/ExpressProject/Grid_project/v0-grid-tranasction-backend
git fetch origin
git checkout feat/exchange-reserve-monitor
git rebase origin/main
git log --oneline origin/main..HEAD
```
Expected: 설계 문서 커밋(`docs: 거래소 BTC 보유량 모니터 설계 문서 추가`)과 이 계획 문서 커밋만 보인다.

---

## Task 1: 설정 상수

**Files:**
- Create: `src/config/exchange-reserve.ts`

- [ ] **Step 1: 설정 파일 작성**

```ts
// 거래소 BTC 보유량(Exchange Reserve) 모니터 설정
// 데이터: CoinMetrics Community API (무료, 키 불필요) — SplyExNtv/FlowInExNtv/FlowOutExNtv

export const EXCHANGE_RESERVE_CONFIG = {
  coinmetricsBase: process.env.COINMETRICS_API_BASE ?? 'https://community-api.coinmetrics.io/v4',
  metrics: ['SplyExNtv', 'FlowInExNtv', 'FlowOutExNtv'] as const,
  // node-cron은 { timezone: 'UTC' }로 등록. 02:30 UTC = KST 11:30 (메인), 04:30 UTC = KST 13:30 (재시도)
  // CoinMetrics는 D일 값을 D+1일 UTC 01:15~01:45경 공개한다
  cronMain: process.env.EXCHANGE_RESERVE_CRON ?? '30 2 * * *',
  cronRetry: process.env.EXCHANGE_RESERVE_RETRY_CRON ?? '30 4 * * *',
  fetchTimeoutMs: 10_000,
  maxPages: 20,              // 페이지네이션 무한루프 방지
  backfillDays: 730,         // 부팅 백필 범위
  backfillMinRows: 400,      // 이 행 수 미만이면 백필 실행
  recollectDays: 7,          // 일일 수집 시 재조회 구간 (잠정치 수정 반영)
  staleDays: 2,              // 최신 일자가 오늘(UTC)보다 이만큼 초과 경과하면 지연
  viewLookbackDays: 400,     // 조회 API가 요약 계산용으로 읽는 범위
  lookbackDays: 365,         // 1년 최저/최고 기준
} as const

// 조회 API가 허용하는 기간(일)
export const ALLOWED_VIEW_DAYS = [90, 365] as const
```

- [ ] **Step 2: 커밋**

```bash
git add src/config/exchange-reserve.ts
git commit -m "feat: 거래소 BTC 보유량 모니터 설정 상수 추가"
```

---

## Task 2: Prisma 모델 + 마이그레이션 (일별 테이블)

**Files:**
- Modify: `prisma/schema.prisma` (파일 끝, `BtcDormantSnapshot` 모델 뒤 아무 곳)
- Create: `prisma/migrations/20261011000000_add_exchange_reserve_daily/migration.sql`

> ⚠️ 로컬 `.env`의 DB가 production일 수 있으므로 **`prisma migrate dev`를 쓰지 않는다.** DB 없이 동작하는 `prisma migrate diff`(스키마 파일 ↔ 스키마 파일)로 SQL을 생성한다.

- [ ] **Step 1: 변경 전 스키마를 임시 파일로 저장**

```bash
git show HEAD:prisma/schema.prisma > "$TEMP/schema.before.prisma"
```

- [ ] **Step 2: `prisma/schema.prisma` 끝에 모델 추가**

```prisma
// 거래소 BTC 보유량 일별 데이터 (CoinMetrics SplyExNtv/FlowInExNtv/FlowOutExNtv)
model ExchangeReserveDaily {
  id         Int      @id @default(autoincrement())
  date       DateTime @unique @db.Date        // UTC 기준 일자
  supplyBtc  Decimal  @db.Decimal(20, 8)      // 거래소 보유량
  inflowBtc  Decimal? @db.Decimal(20, 8)      // 입금량
  outflowBtc Decimal? @db.Decimal(20, 8)      // 출금량
  fetchedAt  DateTime @default(now()) @updatedAt

  @@map("exchange_reserve_daily")
}
```

- [ ] **Step 3: 마이그레이션 SQL 생성**

```bash
mkdir -p prisma/migrations/20261011000000_add_exchange_reserve_daily
npx prisma migrate diff \
  --from-schema-datamodel "$TEMP/schema.before.prisma" \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/20261011000000_add_exchange_reserve_daily/migration.sql
cat prisma/migrations/20261011000000_add_exchange_reserve_daily/migration.sql
```
Expected (내용):
```sql
-- CreateTable
CREATE TABLE `exchange_reserve_daily` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `date` DATE NOT NULL,
    `supplyBtc` DECIMAL(20, 8) NOT NULL,
    `inflowBtc` DECIMAL(20, 8) NULL,
    `outflowBtc` DECIMAL(20, 8) NULL,
    `fetchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `exchange_reserve_daily_date_key`(`date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```
`CREATE TABLE exchange_reserve_daily` 외의 문장(다른 테이블 ALTER/DROP)이 있으면 **중단하고 보고**한다(스키마 드리프트).

- [ ] **Step 4: 박스문자/비ASCII 혼입 검사 (Prisma CLI garbage 버그 대비)**

```bash
grep -nP '[^\x00-\x7F]' prisma/migrations/20261011000000_add_exchange_reserve_daily/migration.sql && echo "!! 비ASCII 발견" || echo "OK clean"
```
Expected: `OK clean`

- [ ] **Step 5: 스키마 검증 + 클라이언트 생성**

```bash
npx prisma validate && npx prisma generate
```
Expected: `The schema at prisma/schema.prisma is valid` / `Generated Prisma Client`

- [ ] **Step 6: mock에 모델 추가** — `__mocks__/database.ts`의 `const prisma = {` 바로 다음 줄(`// BTC LTH regime 스냅샷 테이블` 위)에 삽입

```ts
  // 거래소 BTC 보유량 일별 테이블
  exchangeReserveDaily: {
    count: jest.fn(),
    createMany: jest.fn(),
    upsert: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
```

- [ ] **Step 7: 커밋**

```bash
git add prisma/schema.prisma prisma/migrations/20261011000000_add_exchange_reserve_daily __mocks__/database.ts
git commit -m "feat: 거래소 BTC 보유량 일별 테이블 스키마 추가"
```

---

## Task 3: 순수 함수 — 일자 유틸 + 1년 최저 판정

**Files:**
- Create: `src/services/exchange-reserve-math.ts`
- Create: `__tests__/services/exchange-reserve/helpers.ts`
- Test: `__tests__/services/exchange-reserve/exchange-reserve-math.test.ts`

규칙: 일자 d가 **갱신일** ⇔ `supply(d) < min(supply of 직전 lookbackDays일)` (직전 = d−1 ~ d−(lookbackDays−1), 즉 요약 low1y 창과 동일 — 2026-10-11 리뷰 반영). 비교 구간 데이터가 `ceil(lookbackDays × 0.9)`개 미만이면 갱신 아님.

- [ ] **Step 1: 테스트 헬퍼 작성** (`__tests__/services/exchange-reserve/helpers.ts`, jest testMatch가 `*.test.ts`라 테스트로 실행되지 않음)

```ts
import type { ReservePoint } from '../../../src/services/exchange-reserve-math'

// startDay부터 하루씩 증가하는 시계열 생성 (inflow/outflow는 null)
export function makeSeries(startDay: string, supplies: number[]): ReservePoint[] {
  const start = Date.parse(`${startDay}T00:00:00Z`)
  return supplies.map((supply, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    supply,
    inflow: null,
    outflow: null,
  }))
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

```ts
import { addDays, daysBetween, isNewLowAt, toDay } from '../../../src/services/exchange-reserve-math'
import { makeSeries } from './helpers'

describe('일자 유틸', () => {
  it('toDay는 UTC 기준 YYYY-MM-DD', () => {
    expect(toDay(new Date('2026-10-09T23:59:59Z'))).toBe('2026-10-09')
  })
  it('addDays는 월/연 경계를 넘는다', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })
  it('daysBetween(from, to) = to - from', () => {
    expect(daysBetween('2026-10-01', '2026-10-08')).toBe(7)
    expect(daysBetween('2026-10-08', '2026-10-01')).toBe(-7)
  })
})

describe('isNewLowAt (lookback 10일, 최소 9개)', () => {
  it('직전 10일 최저보다 낮으면 갱신', () => {
    const s = makeSeries('2026-01-01', [...Array(10).fill(100), 99])
    expect(isNewLowAt(s, 10, 10)).toEqual({ isLow: true, prevLow: 100 })
  })
  it('같으면 갱신 아님', () => {
    const s = makeSeries('2026-01-01', [...Array(10).fill(100), 100])
    expect(isNewLowAt(s, 10, 10)).toEqual({ isLow: false, prevLow: 100 })
  })
  it('lookback 밖의 더 낮은 값은 무시', () => {
    // index0=50은 index11 기준 11일 전 → 비교 구간 밖
    const s = makeSeries('2026-01-01', [50, ...Array(10).fill(100), 99])
    expect(isNewLowAt(s, 11, 10)).toEqual({ isLow: true, prevLow: 100 })
  })
  it('비교 구간 데이터가 90% 미만이면 갱신 아님', () => {
    const s = makeSeries('2026-01-01', [100, 100, 100, 100, 90])
    expect(isNewLowAt(s, 4, 10)).toEqual({ isLow: false, prevLow: null })
  })
})
```

- [ ] **Step 3: 실패 확인**

Run: `npx jest __tests__/services/exchange-reserve/exchange-reserve-math.test.ts`
Expected: FAIL — `Cannot find module '../../../src/services/exchange-reserve-math'`

- [ ] **Step 4: 구현**

```ts
// 거래소 BTC 보유량 — 순수 계산 유틸 (DB/네트워크 없음)

export interface ReservePoint {
  date: string            // 'YYYY-MM-DD' (UTC)
  supply: number          // 거래소 보유량 BTC
  inflow: number | null   // 입금량 BTC
  outflow: number | null  // 출금량 BTC
}

const DAY_MS = 86_400_000
// 비교 구간 데이터가 이 비율 미만이면 최저 판정하지 않음 (데이터 부족 오탐 방지)
export const MIN_COVERAGE = 0.9

export function toDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function dayToDate(day: string): Date {
  return new Date(`${day}T00:00:00Z`)
}

export function addDays(day: string, n: number): string {
  return toDay(new Date(dayToDate(day).getTime() + n * DAY_MS))
}

// to - from (일)
export function daysBetween(from: string, to: string): number {
  return Math.round((dayToDate(to).getTime() - dayToDate(from).getTime()) / DAY_MS)
}

// series(일자 오름차순)[idx]가 직전 lookbackDays일 최저보다 낮은지 판정
export function isNewLowAt(
  series: ReservePoint[],
  idx: number,
  lookbackDays: number,
): { isLow: boolean; prevLow: number | null } {
  const target = series[idx]
  let min = Infinity
  let count = 0
  for (let i = idx - 1; i >= 0; i--) {
    const gap = daysBetween(series[i].date, target.date)
    if (gap >= lookbackDays) break
    if (gap < 1) continue
    count++
    if (series[i].supply < min) min = series[i].supply
  }
  if (count < Math.ceil(lookbackDays * MIN_COVERAGE)) return { isLow: false, prevLow: null }
  return { isLow: target.supply < min, prevLow: min }
}
```

- [ ] **Step 5: 통과 확인**

Run: `npx jest __tests__/services/exchange-reserve/exchange-reserve-math.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 6: 커밋**

```bash
git add src/services/exchange-reserve-math.ts __tests__/services/exchange-reserve/helpers.ts __tests__/services/exchange-reserve/exchange-reserve-math.test.ts
git commit -m "feat: 거래소 보유량 일자 유틸·1년 최저 판정 순수함수"
```

---

## Task 4: 순수 함수 — 요약 계산

**Files:**
- Create: `src/services/exchange-reserve-summary.ts`
- Test: `__tests__/services/exchange-reserve/exchange-reserve-summary.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
import { computeReserveSummary } from '../../../src/services/exchange-reserve-summary'
import { makeSeries } from './helpers'

const NOW = new Date('2026-01-31T05:00:00Z')

describe('computeReserveSummary', () => {
  it('데이터 0건 → backfilling', () => {
    const s = computeReserveSummary([], NOW, 10)
    expect(s.status).toBe('backfilling')
    expect(s.latestDate).toBeNull()
    expect(s.supply).toBeNull()
    expect(s.isNewLow1y).toBe(false)
  })

  it('1d/7d 변화와 비율', () => {
    // 01-01 ~ 01-30, 마지막 값만 다르게
    const series = makeSeries('2026-01-01', [...Array(29).fill(200), 190])
    const s = computeReserveSummary(series, NOW, 10)
    expect(s.latestDate).toBe('2026-01-30')
    expect(s.supply).toBe(190)
    expect(s.change1d).toEqual({ abs: -10, pct: -5 })
    expect(s.change7d).toEqual({ abs: -10, pct: -5 })
    expect(s.change30d).toBeNull() // 30일 전(12-31) 이하 데이터 없음
    expect(s.status).toBe('ok')
  })

  it('lookback 구간 최저/최고 + 최신이 신저점이면 isNewLow1y', () => {
    const series = makeSeries('2026-01-01', [300, ...Array(18).fill(200), 250, 190])
    // lookback 10일 → 01-11 초과 구간만 low/high 대상 (01-01의 300은 제외)
    const s = computeReserveSummary(series, NOW, 10)
    expect(s.low1y).toEqual({ date: '2026-01-21', supply: 190 })
    expect(s.high1y).toEqual({ date: '2026-01-20', supply: 250 })
    expect(s.isNewLow1y).toBe(true)
  })

  it('netFlow1d = inflow - outflow, 없으면 null', () => {
    const series = makeSeries('2026-01-29', [100, 100])
    series[1] = { ...series[1], inflow: 20, outflow: 35 }
    expect(computeReserveSummary(series, NOW, 10).netFlow1d).toBe(-15)
    const noFlow = makeSeries('2026-01-29', [100, 100])
    expect(computeReserveSummary(noFlow, NOW, 10).netFlow1d).toBeNull()
  })

  it('stale: 최신 일자가 오늘(UTC) 기준 2일 초과 경과', () => {
    expect(computeReserveSummary(makeSeries('2026-01-29', [1]), NOW, 10).stale).toBe(false) // 2일
    expect(computeReserveSummary(makeSeries('2026-01-28', [1]), NOW, 10).stale).toBe(true)  // 3일
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest __tests__/services/exchange-reserve/exchange-reserve-summary.test.ts`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: 구현**

```ts
// 거래소 BTC 보유량 — 요약 계산 (순수 함수)
import { EXCHANGE_RESERVE_CONFIG } from '../config/exchange-reserve'
import { addDays, daysBetween, isNewLowAt, toDay, type ReservePoint } from './exchange-reserve-math'

export interface ChangeStat {
  abs: number
  pct: number
}

export interface DatedSupply {
  date: string
  supply: number
}

export interface ReserveSummary {
  latestDate: string | null
  supply: number | null
  change1d: ChangeStat | null
  change7d: ChangeStat | null
  change30d: ChangeStat | null
  low1y: DatedSupply | null
  high1y: DatedSupply | null
  isNewLow1y: boolean
  netFlow1d: number | null
  stale: boolean
  status: 'ok' | 'backfilling'
}

const EMPTY_SUMMARY: ReserveSummary = {
  latestDate: null,
  supply: null,
  change1d: null,
  change7d: null,
  change30d: null,
  low1y: null,
  high1y: null,
  isNewLow1y: false,
  netFlow1d: null,
  stale: false,
  status: 'backfilling',
}

// 최신값과 N일 전(그 이하 가장 가까운 일자) 값의 차이
function changeOver(series: ReservePoint[], days: number): ChangeStat | null {
  const latest = series[series.length - 1]
  const target = addDays(latest.date, -days)
  for (let i = series.length - 2; i >= 0; i--) {
    if (series[i].date <= target) {
      const base = series[i].supply
      const abs = latest.supply - base
      return { abs, pct: base === 0 ? 0 : (abs / base) * 100 }
    }
  }
  return null
}

export function computeReserveSummary(
  series: ReservePoint[],
  now: Date,
  lookbackDays: number = EXCHANGE_RESERVE_CONFIG.lookbackDays,
): ReserveSummary {
  if (series.length === 0) return EMPTY_SUMMARY

  const latest = series[series.length - 1]
  const windowStart = addDays(latest.date, -lookbackDays)
  const window = series.filter((p) => p.date > windowStart)
  const low = window.reduce((a, b) => (b.supply < a.supply ? b : a))
  const high = window.reduce((a, b) => (b.supply > a.supply ? b : a))

  return {
    latestDate: latest.date,
    supply: latest.supply,
    change1d: changeOver(series, 1),
    change7d: changeOver(series, 7),
    change30d: changeOver(series, 30),
    low1y: { date: low.date, supply: low.supply },
    high1y: { date: high.date, supply: high.supply },
    isNewLow1y: isNewLowAt(series, series.length - 1, lookbackDays).isLow,
    netFlow1d:
      latest.inflow !== null && latest.outflow !== null ? latest.inflow - latest.outflow : null,
    stale: daysBetween(latest.date, toDay(now)) > EXCHANGE_RESERVE_CONFIG.staleDays,
    status: 'ok',
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest __tests__/services/exchange-reserve/exchange-reserve-summary.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/services/exchange-reserve-summary.ts __tests__/services/exchange-reserve/exchange-reserve-summary.test.ts
git commit -m "feat: 거래소 보유량 요약 계산 순수함수"
```

---

## Task 5: CoinMetrics 클라이언트

**Files:**
- Create: `src/services/exchange-reserve.client.ts`
- Test: `__tests__/services/exchange-reserve/exchange-reserve.client.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
import { fetchExchangeReserve } from '../../../src/services/exchange-reserve.client'

const originalFetch = global.fetch
afterEach(() => {
  global.fetch = originalFetch
})

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body }
}

const row = (day: string, sply: string, inflow?: string, outflow?: string) => ({
  asset: 'btc',
  time: `${day}T00:00:00.000000000Z`,
  SplyExNtv: sply,
  'SplyExNtv-status': 'flash',
  ...(inflow !== undefined ? { FlowInExNtv: inflow } : {}),
  ...(outflow !== undefined ? { FlowOutExNtv: outflow } : {}),
})

describe('fetchExchangeReserve', () => {
  it('문자열 숫자를 파싱하고 일자 오름차순으로 반환', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      okJson({
        data: [
          row('2026-10-09', '2672865.55765548', '27171.07', '22909.79'),
          row('2026-10-08', '2665392.03622638', '28184.93', '27937.59'),
        ],
      }),
    )
    global.fetch = fetchMock as any
    const out = await fetchExchangeReserve('2026-10-08')
    expect(out).toEqual([
      { date: '2026-10-08', supply: 2665392.03622638, inflow: 28184.93, outflow: 27937.59 },
      { date: '2026-10-09', supply: 2672865.55765548, inflow: 27171.07, outflow: 22909.79 },
    ])
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('metrics=SplyExNtv%2CFlowInExNtv%2CFlowOutExNtv')
    expect(url).toContain('paging_from=start')
    expect(url).toContain('start_time=2026-10-08')
  })

  it('next_page_url이 있으면 이어서 조회', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(okJson({ data: [row('2026-10-08', '100')], next_page_url: 'https://x/page2' }))
      .mockResolvedValueOnce(okJson({ data: [row('2026-10-09', '99')] }))
    global.fetch = fetchMock as any
    const out = await fetchExchangeReserve('2026-10-08')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe('https://x/page2')
    expect(out.map((p) => p.date)).toEqual(['2026-10-08', '2026-10-09'])
  })

  it('SplyExNtv가 없는 행은 버리고, 유입/유출 누락은 null', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      okJson({
        data: [
          { asset: 'btc', time: '2026-10-07T00:00:00.000000000Z', FlowInExNtv: '1' },
          row('2026-10-08', '100'),
        ],
      }),
    ) as any
    const out = await fetchExchangeReserve('2026-10-07')
    expect(out).toEqual([{ date: '2026-10-08', supply: 100, inflow: null, outflow: null }])
  })

  it('HTTP 오류면 throw', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }) as any
    await expect(fetchExchangeReserve('2026-10-08')).rejects.toThrow('CoinMetrics 503')
  })

  it('스키마 불일치면 throw', async () => {
    global.fetch = jest.fn().mockResolvedValue(okJson({ data: [{ asset: 'btc', time: '2026-10-08', SplyExNtv: 'abc' }] })) as any
    await expect(fetchExchangeReserve('2026-10-08')).rejects.toThrow()
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest __tests__/services/exchange-reserve/exchange-reserve.client.test.ts`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: 구현**

```ts
// CoinMetrics Community API — 거래소 BTC 보유량 조회 (외부 경계: zod 검증)
import { z } from 'zod'
import { EXCHANGE_RESERVE_CONFIG as CFG } from '../config/exchange-reserve'
import type { ReservePoint } from './exchange-reserve-math'

// CoinMetrics는 숫자를 문자열로 준다 → 숫자로 변환 (NaN이면 검증 실패)
const numericString = z.preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number())

const rowSchema = z.object({
  asset: z.string(),
  time: z.string(),
  SplyExNtv: numericString.optional(),
  FlowInExNtv: numericString.optional(),
  FlowOutExNtv: numericString.optional(),
})

const responseSchema = z.object({
  data: z.array(rowSchema),
  next_page_url: z.string().optional(),
})

async function getJson(url: string): Promise<unknown> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), CFG.fetchTimeoutMs)
  try {
    const res = await fetch(url, { signal: ctl.signal })
    if (!res.ok) throw new Error(`CoinMetrics ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

// start(YYYY-MM-DD)부터 최신까지 일별 데이터를 일자 오름차순으로 반환
export async function fetchExchangeReserve(start: string): Promise<ReservePoint[]> {
  const params = new URLSearchParams({
    assets: 'btc',
    metrics: CFG.metrics.join(','),
    frequency: '1d',
    start_time: start,
    page_size: '10000',
    paging_from: 'start', // 기본값(end)은 최신→과거 순
  })
  let url: string | undefined = `${CFG.coinmetricsBase}/timeseries/asset-metrics?${params}`
  const out: ReservePoint[] = []
  let pages = 0

  while (url) {
    pages += 1
    if (pages > CFG.maxPages) throw new Error('CoinMetrics 페이지 수 초과')
    const parsed = responseSchema.parse(await getJson(url))
    for (const r of parsed.data) {
      if (r.SplyExNtv === undefined) continue
      out.push({
        date: r.time.slice(0, 10),
        supply: r.SplyExNtv,
        inflow: r.FlowInExNtv ?? null,
        outflow: r.FlowOutExNtv ?? null,
      })
    }
    url = parsed.next_page_url
  }

  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest __tests__/services/exchange-reserve/exchange-reserve.client.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: 실제 API 스모크 (네트워크, 저장 없음)**

```bash
# ts-node는 bin 링크가 없으므로 모듈 경로로 직접 실행 (ts-node-dev 의존성으로 설치돼 있음)
node node_modules/ts-node/dist/bin.js -T -e "import('./src/services/exchange-reserve.client').then(async m => { const r = await m.fetchExchangeReserve('2026-10-01'); console.log(r.length, r[0], r[r.length-1]) })"
```
Expected: 8~10행, 각 행 `supply`가 2,6xx,xxx 범위 숫자

- [ ] **Step 6: 커밋**

```bash
git add src/services/exchange-reserve.client.ts __tests__/services/exchange-reserve/exchange-reserve.client.test.ts
git commit -m "feat: CoinMetrics 거래소 보유량 클라이언트 (zod·페이지네이션)"
```

---

## Task 6: 서비스 — 백필·일일 수집·조회

**Files:**
- Create: `src/services/exchange-reserve.service.ts`
- Test: `__tests__/services/exchange-reserve/exchange-reserve.service.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
import { prisma } from '../../../__mocks__/database'
import { fetchExchangeReserve } from '../../../src/services/exchange-reserve.client'
import {
  getReserveView,
  runBackfill,
  runDailyCollect,
} from '../../../src/services/exchange-reserve.service'

jest.mock('../../../src/services/exchange-reserve.client', () => ({
  fetchExchangeReserve: jest.fn(),
}))

const fetchMock = fetchExchangeReserve as jest.Mock
const db = prisma.exchangeReserveDaily as Record<string, jest.Mock>
const NOW = new Date('2026-10-11T03:00:00Z')
const p = (date: string, supply: number) => ({ date, supply, inflow: 10, outflow: 20 })

beforeEach(() => {
  jest.clearAllMocks()
})

describe('runBackfill', () => {
  it('행이 400개 이상이면 건너뜀', async () => {
    db.count.mockResolvedValue(400)
    expect(await runBackfill(NOW)).toEqual({ skipped: true, inserted: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('부족하면 730일 전부터 조회해 createMany(skipDuplicates)', async () => {
    db.count.mockResolvedValue(0)
    fetchMock.mockResolvedValue([p('2024-10-12', 100), p('2024-10-13', 99)])
    db.createMany.mockResolvedValue({ count: 2 })
    expect(await runBackfill(NOW)).toEqual({ skipped: false, inserted: 2 })
    expect(fetchMock).toHaveBeenCalledWith('2024-10-11')
    const arg = db.createMany.mock.calls[0][0]
    expect(arg.skipDuplicates).toBe(true)
    expect(arg.data[0]).toEqual({
      date: new Date('2024-10-12T00:00:00Z'),
      supplyBtc: 100,
      inflowBtc: 10,
      outflowBtc: 20,
    })
  })
})

describe('runDailyCollect', () => {
  it('최근 7일을 upsert하고 최신 일자가 늘면 newData=true', async () => {
    db.findFirst.mockResolvedValue({ date: new Date('2026-10-08T00:00:00Z') })
    fetchMock.mockResolvedValue([p('2026-10-08', 100), p('2026-10-09', 99)])
    db.upsert.mockResolvedValue({})
    const r = await runDailyCollect(NOW)
    expect(fetchMock).toHaveBeenCalledWith('2026-10-04')
    expect(db.upsert).toHaveBeenCalledTimes(2)
    expect(db.upsert.mock.calls[1][0].where).toEqual({ date: new Date('2026-10-09T00:00:00Z') })
    expect(r).toEqual({ status: 'ok', upserted: 2, prevLatest: '2026-10-08', latest: '2026-10-09', newData: true })
  })

  it('최신 일자가 그대로면 newData=false', async () => {
    db.findFirst.mockResolvedValue({ date: new Date('2026-10-09T00:00:00Z') })
    fetchMock.mockResolvedValue([p('2026-10-09', 99)])
    db.upsert.mockResolvedValue({})
    const r = await runDailyCollect(NOW)
    expect(r.newData).toBe(false)
    expect(r.latest).toBe('2026-10-09')
  })

  it('마지막 저장일이 7일보다 오래되면 그 날부터 조회해 빈 구간을 채움', async () => {
    db.findFirst.mockResolvedValue({ date: new Date('2026-09-20T00:00:00Z') })
    fetchMock.mockResolvedValue([])
    await runDailyCollect(NOW)
    expect(fetchMock).toHaveBeenCalledWith('2026-09-20')
  })
})

describe('getReserveView', () => {
  it('Decimal을 숫자로 바꾸고 days 구간만 series로 반환, summary는 전체로 계산', async () => {
    db.findMany.mockResolvedValue([
      { date: new Date('2026-06-01T00:00:00Z'), supplyBtc: '300', inflowBtc: null, outflowBtc: null },
      { date: new Date('2026-10-09T00:00:00Z'), supplyBtc: '2672865.5', inflowBtc: '27171', outflowBtc: '22909' },
    ])
    const v = await getReserveView(90, NOW)
    expect(v.series).toEqual([{ date: '2026-10-09', supply: 2672865.5, inflow: 27171, outflow: 22909 }])
    expect(v.summary.latestDate).toBe('2026-10-09')
    expect(v.summary.low1y).toEqual({ date: '2026-06-01', supply: 300 })
    expect(db.findMany.mock.calls[0][0].where.date.gte).toEqual(new Date('2025-09-06T00:00:00Z'))
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest __tests__/services/exchange-reserve/exchange-reserve.service.test.ts`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: 구현**

```ts
// 거래소 BTC 보유량 — 백필·일일 수집·조회 서비스
import prisma from '../config/database'
import { EXCHANGE_RESERVE_CONFIG as CFG } from '../config/exchange-reserve'
import { fetchExchangeReserve } from './exchange-reserve.client'
import { addDays, dayToDate, toDay, type ReservePoint } from './exchange-reserve-math'
import { computeReserveSummary, type ReserveSummary } from './exchange-reserve-summary'

// 동시 실행 방지 (메인/재시도 cron 겹침)
let collecting = false

function toRow(p: ReservePoint) {
  return {
    date: dayToDate(p.date),
    supplyBtc: p.supply,
    inflowBtc: p.inflow,
    outflowBtc: p.outflow,
  }
}

interface DailyRow {
  date: Date
  supplyBtc: unknown
  inflowBtc: unknown
  outflowBtc: unknown
}

function fromRow(r: DailyRow): ReservePoint {
  return {
    date: toDay(r.date),
    supply: Number(r.supplyBtc),
    inflow: r.inflowBtc === null ? null : Number(r.inflowBtc),
    outflow: r.outflowBtc === null ? null : Number(r.outflowBtc),
  }
}

async function getLatestDay(): Promise<string | null> {
  const latest = await prisma.exchangeReserveDaily.findFirst({
    orderBy: { date: 'desc' },
    select: { date: true },
  })
  return latest ? toDay(latest.date) : null
}

export interface BackfillResult {
  skipped: boolean
  inserted: number
}

// 데이터가 부족하면 최근 730일 일괄 적재 (알림 판정 없음)
export async function runBackfill(now: Date = new Date()): Promise<BackfillResult> {
  const count = await prisma.exchangeReserveDaily.count()
  if (count >= CFG.backfillMinRows) return { skipped: true, inserted: 0 }
  const points = await fetchExchangeReserve(addDays(toDay(now), -CFG.backfillDays))
  if (points.length === 0) return { skipped: false, inserted: 0 }
  const result = await prisma.exchangeReserveDaily.createMany({
    data: points.map(toRow),
    skipDuplicates: true,
  })
  return { skipped: false, inserted: result.count }
}

export interface CollectResult {
  status: 'ok' | 'busy'
  upserted: number
  prevLatest: string | null
  latest: string | null
  newData: boolean
}

// 최근 7일(또는 마지막 저장일 이후)을 재조회해 upsert — 잠정치(flash) 수정 반영
export async function runDailyCollect(now: Date = new Date()): Promise<CollectResult> {
  if (collecting) return { status: 'busy', upserted: 0, prevLatest: null, latest: null, newData: false }
  collecting = true
  try {
    const prevLatest = await getLatestDay()
    const recentStart = addDays(toDay(now), -CFG.recollectDays)
    const start = prevLatest !== null && prevLatest < recentStart ? prevLatest : recentStart
    const points = await fetchExchangeReserve(start)
    for (const p of points) {
      const row = toRow(p)
      await prisma.exchangeReserveDaily.upsert({
        where: { date: row.date },
        create: row,
        update: { supplyBtc: row.supplyBtc, inflowBtc: row.inflowBtc, outflowBtc: row.outflowBtc },
      })
    }
    const latest = points.length > 0 ? points[points.length - 1].date : prevLatest
    const newData = latest !== null && (prevLatest === null || latest > prevLatest)
    return { status: 'ok', upserted: points.length, prevLatest, latest, newData }
  } finally {
    collecting = false
  }
}

// fromDay(포함) 이후 시계열, 일자 오름차순
export async function loadSeries(fromDay: string): Promise<ReservePoint[]> {
  const rows = await prisma.exchangeReserveDaily.findMany({
    where: { date: { gte: dayToDate(fromDay) } },
    orderBy: { date: 'asc' },
  })
  return rows.map(fromRow)
}

export interface ReserveView {
  series: ReservePoint[]
  summary: ReserveSummary
}

// 조회 API용: 요약은 400일 데이터로 계산, series는 최근 days일만
export async function getReserveView(days: number, now: Date = new Date()): Promise<ReserveView> {
  const today = toDay(now)
  const all = await loadSeries(addDays(today, -CFG.viewLookbackDays))
  const cutoff = addDays(today, -days)
  return {
    series: all.filter((p) => p.date > cutoff),
    summary: computeReserveSummary(all, now),
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest __tests__/services/exchange-reserve/exchange-reserve.service.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/services/exchange-reserve.service.ts __tests__/services/exchange-reserve/exchange-reserve.service.test.ts
git commit -m "feat: 거래소 보유량 백필·일일 수집·조회 서비스"
```

---

## Task 7: 스케줄러

**Files:**
- Create: `src/services/exchange-reserve-scheduler.service.ts`
- Test: `__tests__/services/exchange-reserve/exchange-reserve-scheduler.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
import { runCycle } from '../../../src/services/exchange-reserve-scheduler.service'
import { runBackfill, runDailyCollect } from '../../../src/services/exchange-reserve.service'

jest.mock('../../../src/services/exchange-reserve.service', () => ({
  runBackfill: jest.fn(),
  runDailyCollect: jest.fn(),
}))

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
})

describe('runCycle', () => {
  it('백필 확인 후 일일 수집 실행', async () => {
    ;(runBackfill as jest.Mock).mockResolvedValue({ skipped: true, inserted: 0 })
    ;(runDailyCollect as jest.Mock).mockResolvedValue({ status: 'ok', newData: false })
    await runCycle('main')
    expect(runBackfill).toHaveBeenCalled()
    expect(runDailyCollect).toHaveBeenCalled()
  })

  it('오류가 나도 throw하지 않음 (cron 보호)', async () => {
    ;(runBackfill as jest.Mock).mockRejectedValue(new Error('CoinMetrics 503'))
    await expect(runCycle('main')).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest __tests__/services/exchange-reserve/exchange-reserve-scheduler.test.ts`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: 구현**

```ts
// 거래소 BTC 보유량 스케줄러 — 부팅 백필 + 매일 수집 (UTC 기준 cron)
import * as cron from 'node-cron'
import type { ScheduledTask } from 'node-cron'
import { EXCHANGE_RESERVE_CONFIG as CFG } from '../config/exchange-reserve'
import { runBackfill, runDailyCollect } from './exchange-reserve.service'

let tasks: ScheduledTask[] = []

// 1회 수집 사이클: 빈 DB면 백필(이전 실패 재시도) → 최근 구간 수집
export async function runCycle(label: string): Promise<void> {
  try {
    const backfill = await runBackfill()
    if (!backfill.skipped) console.log(`[exchange-reserve] ${label} backfill`, backfill)
    const collect = await runDailyCollect()
    console.log(`[exchange-reserve] ${label} collect`, collect)
  } catch (e) {
    console.error(`[exchange-reserve] ${label} 실패`, e)
  }
}

export function startExchangeReserveScheduler(): void {
  if (tasks.length > 0) return
  // 부팅 시 백필 (비동기, 서버 시작 차단하지 않음)
  runBackfill()
    .then((r) => console.log('[exchange-reserve] boot backfill', r))
    .catch((e) => console.error('[exchange-reserve] boot backfill 실패', e))

  tasks = [
    cron.schedule(CFG.cronMain, () => runCycle('main'), { timezone: 'UTC' }),
    cron.schedule(CFG.cronRetry, () => runCycle('retry'), { timezone: 'UTC' }),
  ]
}

export function stopExchangeReserveScheduler(): void {
  tasks.forEach((t) => t.stop())
  tasks = []
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest __tests__/services/exchange-reserve/exchange-reserve-scheduler.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/services/exchange-reserve-scheduler.service.ts __tests__/services/exchange-reserve/exchange-reserve-scheduler.test.ts
git commit -m "feat: 거래소 보유량 수집 스케줄러 (KST 11:30/13:30)"
```

---

## Task 8: 조회 API (컨트롤러 + 라우트 + 마운트 + 부팅)

**Files:**
- Create: `src/controllers/exchange-reserve.controller.ts`
- Create: `src/routes/exchange-reserve.ts`
- Modify: `src/routes/index.ts` (import 블록 + `router.use('/reclaim', reclaimRoutes);` 다음 줄)
- Modify: `src/index.ts` (import 블록 + market-regime 스케줄러 시작 바로 다음)
- Test: `__tests__/controllers/exchange-reserve.controller.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
import type { Request, Response } from 'express'
import { getExchangeReserve } from '../../src/controllers/exchange-reserve.controller'
import { getReserveView } from '../../src/services/exchange-reserve.service'

jest.mock('../../src/services/exchange-reserve.service', () => ({
  getReserveView: jest.fn(),
}))

describe('GET /api/exchange-reserve', () => {
  let json: jest.Mock
  let status: jest.Mock
  let res: Partial<Response>
  let next: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    json = jest.fn()
    status = jest.fn().mockReturnValue({ json })
    res = { json, status }
    next = jest.fn()
  })

  it('days 미지정이면 365로 조회', async () => {
    ;(getReserveView as jest.Mock).mockResolvedValue({ series: [], summary: {} })
    await getExchangeReserve({ query: {} } as Request, res as Response, next)
    expect(getReserveView).toHaveBeenCalledWith(365)
    expect(json).toHaveBeenCalledWith({ series: [], summary: {} })
  })

  it('days=90 허용', async () => {
    ;(getReserveView as jest.Mock).mockResolvedValue({ series: [], summary: {} })
    await getExchangeReserve({ query: { days: '90' } } as unknown as Request, res as Response, next)
    expect(getReserveView).toHaveBeenCalledWith(90)
  })

  it('허용되지 않은 days는 400', async () => {
    await getExchangeReserve({ query: { days: '30' } } as unknown as Request, res as Response, next)
    expect(status).toHaveBeenCalledWith(400)
    expect(getReserveView).not.toHaveBeenCalled()
  })

  it('서비스 오류는 next로 전달', async () => {
    const err = new Error('db down')
    ;(getReserveView as jest.Mock).mockRejectedValue(err)
    await getExchangeReserve({ query: {} } as Request, res as Response, next)
    expect(next).toHaveBeenCalledWith(err)
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest __tests__/controllers/exchange-reserve.controller.test.ts`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: 컨트롤러 구현** (`src/controllers/exchange-reserve.controller.ts`)

```ts
import type { Request, Response, NextFunction } from 'express'
import { ALLOWED_VIEW_DAYS } from '../config/exchange-reserve'
import { getReserveView } from '../services/exchange-reserve.service'

// GET /api/exchange-reserve?days=90|365 — 거래소 BTC 보유량 시계열 + 요약
export async function getExchangeReserve(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const days = Number(req.query.days ?? 365)
    if (!(ALLOWED_VIEW_DAYS as readonly number[]).includes(days)) {
      res.status(400).json({ error: 'invalid days (use 90|365)' })
      return
    }
    res.json(await getReserveView(days))
  } catch (e) {
    next(e)
  }
}
```

- [ ] **Step 4: 라우트 작성** (`src/routes/exchange-reserve.ts`)

```ts
import { Router } from 'express'
import { authenticate } from '../middlewares/auth'
import { getExchangeReserve } from '../controllers/exchange-reserve.controller'

const router = Router()

router.get('/', authenticate, getExchangeReserve)

export default router
```

- [ ] **Step 5: 마운트** — `src/routes/index.ts`

import 블록 끝(`reclaimRoutes` import 다음)에:
```ts
import exchangeReserveRoutes from './exchange-reserve';
```
`router.use('/reclaim', reclaimRoutes);` 다음 줄에:
```ts
router.use('/exchange-reserve', exchangeReserveRoutes);
```

- [ ] **Step 6: 부팅 연결** — `src/index.ts`

import 블록의 `import { startMarketRegimeScheduler } ...` 다음 줄에:
```ts
import { startExchangeReserveScheduler } from './services/exchange-reserve-scheduler.service';
```
production 블록의 `console.log('[market-regime] scheduler started');` 다음에:
```ts

        // 거래소 BTC 보유량 스케줄러 시작 (백필 + 매일 KST 11:30/13:30 수집)
        startExchangeReserveScheduler();
        console.log('[exchange-reserve] scheduler started');
```

- [ ] **Step 7: 통과 확인**

Run: `npx jest __tests__/controllers/exchange-reserve.controller.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 8: 커밋**

```bash
git add src/controllers/exchange-reserve.controller.ts src/routes/exchange-reserve.ts src/routes/index.ts src/index.ts __tests__/controllers/exchange-reserve.controller.test.ts
git commit -m "feat: 거래소 BTC 보유량 조회 API + 스케줄러 부팅 연결"
```

---

## Task 9: 백엔드 1단계 검증 → PR → 배포

- [ ] **Step 1: 전체 검증 (백그라운드 병렬 가능)**

```bash
npx jest __tests__/services/exchange-reserve __tests__/controllers/exchange-reserve.controller.test.ts
npx jest
npx tsc --noEmit
npm run build
```
Expected: 신규 테스트 29개 PASS, 전체 jest에서 **기존 대비 새 실패 0**(기존 실패가 있으면 `git stash` 없이 main 기준 실패 목록과 비교해 보고), tsc 0 errors, build 성공.

- [ ] **Step 2: push + PR**

```bash
git push -u origin feat/exchange-reserve-monitor
gh pr create --base main --title "feat: 거래소 BTC 보유량 수집 + 조회 API (1단계)" --body "$(cat <<'EOF'
## 요약
- CoinMetrics 무료 API(SplyExNtv/FlowInExNtv/FlowOutExNtv)로 거래소 BTC 보유량 일별 수집
- 부팅 시 730일 백필, 매일 KST 11:30(메인)/13:30(재시도) 최근 7일 upsert
- `GET /api/exchange-reserve?days=90|365` — 시계열 + 요약(1/7/30일 변화, 1년 최저/최고, 신저점 여부, 순유출, stale)
- 새 테이블 `exchange_reserve_daily` 1개 (기존 테이블 무변경)
- 알림/관리자 페이지는 2단계 PR

## 테스트
- [x] jest 신규 29개 통과
- [x] tsc / build 성공
- [ ] 배포 후 백필 로그·API 응답 확인

스펙: docs/superpowers/specs/2026-10-11-exchange-reserve-monitor-design.md
계획: docs/superpowers/plans/2026-10-11-exchange-reserve-monitor.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: 머지 전 안전 체크 + RDS 스냅샷** (프로젝트 자동 진행 정책 — 승인 불필요)

```bash
gh pr view --json mergeable,mergeStateStatus
NEW_SNAP="pre-exchange-reserve-$(date -u +%Y%m%d-%H%M%S)"
aws lightsail create-relational-database-snapshot --relational-database-name Grid-bot-DB-v2 \
  --relational-database-snapshot-name "$NEW_SNAP" --region ap-northeast-2 --profile route53
```
`mergeable: MERGEABLE` 확인. 스냅샷 `available` 확인 후 같은 DB의 이전 스냅샷 삭제(글로벌 CLAUDE.md 패턴).

- [ ] **Step 4: 머지 + 배포 대기**

```bash
gh pr merge --squash
gh run list --limit 1
gh run watch <run-id>
```
Expected: 워크플로우 success

- [ ] **Step 5: 배포 후 확인** (SSH 정보는 `secrets.local.md`)

```bash
ssh <host> 'docker logs grid-bot --since 15m 2>&1 | grep -E "exchange-reserve|migrat" | tail -20'
```
Expected: `Applying migration 20261011000000_add_exchange_reserve_daily`(또는 migrate deploy 성공), `[exchange-reserve] scheduler started`, `[exchange-reserve] boot backfill { skipped: false, inserted: 7xx }`

```bash
ssh <host> 'docker exec -i grid-bot node' <<'NODE'
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const n = await p.exchangeReserveDaily.count();
  const last = await p.exchangeReserveDaily.findFirst({ orderBy: { date: 'desc' } });
  console.log({ n, lastDate: last && last.date.toISOString().slice(0,10), supply: last && String(last.supplyBtc) });
  await p.$disconnect();
})();
NODE
curl -s -o /dev/null -w '%{http_code}\n' https://<backend-host>/api/health
```
Expected: `n` ≥ 700, `lastDate` = 어제 또는 그제, health 200

---

## Task 10: 프론트 worktree 준비

> 기존 프론트 작업 디렉토리(`feat/stablecoin-bulk-stop`, 미커밋 변경 있음)는 **건드리지 않는다.**

- [ ] **Step 1: worktree 생성**

```bash
cd /d/ExpressProject/Grid_project/v0-grid-transaction-frontend
git fetch origin
git worktree add ../v0-grid-transaction-frontend-reserve -b feat/exchange-reserve-card origin/main
cd ../v0-grid-transaction-frontend-reserve
```

- [ ] **Step 2: 의존성 설치** (기존 package-lock 그대로 — 새 패키지 없음, 백그라운드)

```bash
npm ci
```

---

## Task 11: 프론트 API 함수

**Files:**
- Modify: `lib/api.ts` (파일 맨 끝에 추가)

- [ ] **Step 1: 타입 + 함수 추가**

```ts

// ============================================================================
// 거래소 BTC 보유량 (Exchange Reserve)
// ============================================================================

export type ExchangeReserveDays = 90 | 365;

export interface ExchangeReservePoint {
  date: string;
  supply: number;
  inflow: number | null;
  outflow: number | null;
}

export interface ExchangeReserveChange {
  abs: number;
  pct: number;
}

export interface ExchangeReserveSummary {
  latestDate: string | null;
  supply: number | null;
  change1d: ExchangeReserveChange | null;
  change7d: ExchangeReserveChange | null;
  change30d: ExchangeReserveChange | null;
  low1y: { date: string; supply: number } | null;
  high1y: { date: string; supply: number } | null;
  isNewLow1y: boolean;
  netFlow1d: number | null;
  stale: boolean;
  status: 'ok' | 'backfilling';
}

export interface ExchangeReserveView {
  series: ExchangeReservePoint[];
  summary: ExchangeReserveSummary;
}

export async function getExchangeReserve(
  days: ExchangeReserveDays = 365,
): Promise<ExchangeReserveView> {
  const res = await fetchWithTimeout(`${API_BASE_URL}/api/exchange-reserve?days=${days}`, {
    headers: getAuthHeaders(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? data.message ?? '거래소 BTC 보유량 조회 실패');
  return data;
}
```

- [ ] **Step 2: 커밋**

```bash
git add lib/api.ts
git commit -m "feat: 거래소 BTC 보유량 조회 API 함수 추가"
```

---

## Task 12: 차트 컴포넌트

**Files:**
- Create: `components/exchange-reserve/exchange-reserve-chart.tsx`

- [ ] **Step 1: 작성**

```tsx
'use client';

import { useId } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ExchangeReservePoint } from '@/lib/api';

interface Props {
  data: ExchangeReservePoint[];
  height?: number;
}

const fmtBtc = (v: number) => `${Math.round(v).toLocaleString()} BTC`;
const fmtAxis = (v: number) => `${(v / 1_000_000).toFixed(2)}M`;

// 거래소 BTC 보유량 면적 차트
export function ExchangeReserveChart({ data, height = 220 }: Props) {
  // useId는 ':r0:' 형태 — SVG url(#id) 참조가 깨지지 않도록 콜론 제거
  const gradientId = `reserveFill${useId().replace(/:/g, '')}`;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} />
        <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d: string) => d.slice(5)} minTickGap={24} />
        <YAxis domain={['auto', 'auto']} tickFormatter={fmtAxis} tick={{ fontSize: 11 }} width={48} />
        <Tooltip formatter={(v: number) => [fmtBtc(v), '보유량']} />
        <Area type="monotone" dataKey="supply" stroke="#f59e0b" strokeWidth={2} fill={`url(#${gradientId})`} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 2: 커밋**

```bash
git add components/exchange-reserve/exchange-reserve-chart.tsx
git commit -m "feat: 거래소 BTC 보유량 면적 차트 컴포넌트"
```

---

## Task 13: 대시보드 카드 + 페이지 삽입

**Files:**
- Create: `components/exchange-reserve/exchange-reserve-card.tsx`
- Modify: `app/page.tsx` (import 1줄 + `{/* 안내 */}` 카드 바로 위에 1줄)

- [ ] **Step 1: 카드 작성**

```tsx
'use client';

import { useEffect, useState } from 'react';
import { Bitcoin } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getExchangeReserve, type ExchangeReserveDays, type ExchangeReserveView } from '@/lib/api';
import { ExchangeReserveChart } from './exchange-reserve-chart';

const fmtInt = (v: number) => Math.round(v).toLocaleString();

// 대시보드 카드 — 자체 fetch, 실패해도 대시보드 나머지는 영향 없음
export function ExchangeReserveCard() {
  const [days, setDays] = useState<ExchangeReserveDays>(365);
  const [view, setView] = useState<ExchangeReserveView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getExchangeReserve(days)
      .then((v) => {
        if (cancelled) return;
        setView(v);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '조회 실패');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const s = view?.summary;
  const change7d = s?.change7d ?? null;

  return (
    <Card className="border-orange-500/20">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Bitcoin className="h-4 w-4 text-orange-500" />
            <CardTitle className="text-sm font-medium">거래소 BTC 보유량</CardTitle>
            {s?.latestDate && <span className="text-xs text-muted-foreground">기준 {s.latestDate} (UTC)</span>}
          </div>
          <div className="flex gap-1">
            {([90, 365] as const).map((d) => (
              <Button key={d} size="sm" variant={days === d ? 'default' : 'outline'} className="h-7 px-2 text-xs" onClick={() => setDays(d)}>
                {d === 90 ? '90일' : '1년'}
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : loading && !view ? (
          <p className="text-sm text-muted-foreground">불러오는 중…</p>
        ) : !s || s.status === 'backfilling' || s.supply === null ? (
          <p className="text-sm text-muted-foreground">데이터 준비 중입니다 (최초 수집 진행 중)</p>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-2xl font-bold">{fmtInt(s.supply)} BTC</span>
              {change7d && (
                <Badge
                  variant="outline"
                  className={
                    change7d.abs < 0
                      ? 'bg-red-500/10 text-red-600 border-red-500/30'
                      : 'bg-green-500/10 text-green-600 border-green-500/30'
                  }
                >
                  {change7d.abs < 0 ? '▼' : '▲'} 7일 {fmtInt(Math.abs(change7d.abs))} ({change7d.pct.toFixed(2)}%)
                </Badge>
              )}
              {s.isNewLow1y && (
                <Badge variant="outline" className="bg-orange-500/10 text-orange-600 border-orange-500/30">
                  1년 최저
                </Badge>
              )}
              {s.stale && (
                <Badge variant="outline" className="bg-gray-500/10 text-gray-500 border-gray-500/30">
                  데이터 지연
                </Badge>
              )}
            </div>
            {s.low1y && s.high1y && (
              <p className="text-xs text-muted-foreground">
                1년 최저 {fmtInt(s.low1y.supply)} ({s.low1y.date}) · 최고 {fmtInt(s.high1y.supply)} ({s.high1y.date})
              </p>
            )}
            <ExchangeReserveChart data={view?.series ?? []} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: 대시보드에 삽입** — `app/page.tsx`

import 블록 끝(`import { useRouter } from "next/navigation"` 근처)에 추가:
```tsx
import { ExchangeReserveCard } from "@/components/exchange-reserve/exchange-reserve-card"
```
`{/* 안내 */}` 주석 바로 위(하단 정보 카드 grid의 닫는 `</div>` 다음)에 추가:
```tsx
        {/* 거래소 BTC 보유량 */}
        <ExchangeReserveCard />

```

- [ ] **Step 3: 빌드 확인 (백그라운드)**

Run: `npm run build`
Expected: `✓ Compiled successfully`, 타입 에러 0

- [ ] **Step 4: 커밋**

```bash
git add components/exchange-reserve/exchange-reserve-card.tsx app/page.tsx
git commit -m "feat: 대시보드에 거래소 BTC 보유량 카드 추가"
```

---

## Task 14: 프론트 1단계 PR → 배포 → 확인

- [ ] **Step 1: push + PR + 머지**

```bash
git push -u origin feat/exchange-reserve-card
gh pr create --base main --title "feat: 대시보드 거래소 BTC 보유량 카드 (1단계)" --body "$(cat <<'EOF'
## 요약
- 메인 대시보드에 거래소 BTC 보유량 카드: 현재 보유량, 7일 변화, 1년 최저 배지, 90일/1년 면적 차트
- 백엔드 `GET /api/exchange-reserve` 사용 (백엔드 1단계 PR 배포 완료 후)
- 카드 단위 에러 격리 — API 실패해도 대시보드 나머지는 정상

## 테스트
- [x] npm run build 성공
- [ ] 배포 후 grid.koco.me 대시보드에서 카드 표시 확인

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh pr view --json mergeable
gh pr merge --squash
gh run list --limit 1
gh run watch <run-id>
```

- [ ] **Step 2: 화면 확인** — 사용자에게 "브라우저 테스트 필요한지" 확인 후, 필요하면 `/pw-tester`로 `https://grid.koco.me/` 로그인 상태에서 카드 표시·90일/1년 토글·다크모드 확인.

- [ ] **Step 3: worktree 정리는 사용자 확인 후** (`git worktree remove ../v0-grid-transaction-frontend-reserve`)

---

# 2단계 — 1년 최저 카톡 알림 + 관리자 페이지

> 1단계 배포 완료 후 시작. 백엔드는 main에서 새 브랜치 `feat/exchange-reserve-alert`, 프론트는 worktree에서 `feat/exchange-reserve-admin` (origin/main 기준).

## Task 15: 알림 테이블 스키마 + 마이그레이션

**Files:**
- Modify: `prisma/schema.prisma` (`ExchangeReserveDaily` 다음)
- Create: `prisma/migrations/20261012000000_add_exchange_reserve_alerts/migration.sql`
- Modify: `__mocks__/database.ts`

- [ ] **Step 1: 브랜치 + 변경 전 스키마 저장**

```bash
cd /d/ExpressProject/Grid_project/v0-grid-tranasction-backend
git fetch origin && git checkout -b feat/exchange-reserve-alert origin/main
git show HEAD:prisma/schema.prisma > "$TEMP/schema.before.prisma"
```

- [ ] **Step 2: 모델 추가**

```prisma
// 거래소 보유량 알림 설정 (단일 행 id=1)
model ExchangeReserveAlertConfig {
  id           Int      @id @default(1)
  enabled      Boolean  @default(true)
  cooldownDays Int      @default(7)
  lookbackDays Int      @default(365)
  updatedAt    DateTime @updatedAt

  @@map("exchange_reserve_alert_config")
}

// 거래소 보유량 발송 알림 이력 (쿨다운 판정 기준)
model ExchangeReserveAlert {
  id          Int      @id @default(autoincrement())
  dataDate    DateTime @db.Date               // 알림 근거 데이터 일자
  supplyBtc   Decimal  @db.Decimal(20, 8)
  prevLowBtc  Decimal  @db.Decimal(20, 8)     // 직전 lookback 최저치
  newLowCount Int                             // 지난 알림 이후 갱신 횟수(묶음)
  message     String   @db.Text
  sentAt      DateTime @default(now())

  @@index([sentAt])
  @@map("exchange_reserve_alerts")
}
```

- [ ] **Step 3: SQL 생성 + 검사 + generate**

```bash
mkdir -p prisma/migrations/20261012000000_add_exchange_reserve_alerts
npx prisma migrate diff --from-schema-datamodel "$TEMP/schema.before.prisma" \
  --to-schema-datamodel prisma/schema.prisma --script \
  > prisma/migrations/20261012000000_add_exchange_reserve_alerts/migration.sql
cat prisma/migrations/20261012000000_add_exchange_reserve_alerts/migration.sql
grep -nP '[^\x00-\x7F]' prisma/migrations/20261012000000_add_exchange_reserve_alerts/migration.sql && echo "!! 비ASCII" || echo "OK clean"
npx prisma validate && npx prisma generate
```
Expected: `CREATE TABLE exchange_reserve_alert_config` + `CREATE TABLE exchange_reserve_alerts`(+ `sentAt` 인덱스)만 존재, `OK clean`, valid.

- [ ] **Step 4: mock 추가** — `__mocks__/database.ts`의 `exchangeReserveDaily: {...},` 블록 다음에

```ts
  exchangeReserveAlertConfig: {
    upsert: jest.fn(),
  },
  exchangeReserveAlert: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
  },
```

- [ ] **Step 5: 커밋**

```bash
git add prisma/schema.prisma prisma/migrations/20261012000000_add_exchange_reserve_alerts __mocks__/database.ts
git commit -m "feat: 거래소 보유량 알림 설정·이력 테이블 추가"
```

---

## Task 16: 순수 함수 — 알림 판정 `decideAlert`

**Files:**
- Create: `src/services/exchange-reserve-alert.ts`
- Test: `__tests__/services/exchange-reserve/exchange-reserve-alert.test.ts`

규칙(스펙 5.3): disabled면 미발송 → 쿨다운(`latestDate − lastAlertDataDate < cooldownDays`)이면 미발송 → `pending` = (`lastAlertDataDate` 또는 최초면 `latestDate − cooldownDays`) 초과 ~ `latestDate` 사이 갱신일 → 비어 있으면 미발송, 있으면 발송(count = pending 수, prevLow = 첫 갱신일의 직전 최저).

- [ ] **Step 1: 실패하는 테스트 작성** (lookback 10일·쿨다운 7일로 축소해 검증)

```ts
import { decideAlert } from '../../../src/services/exchange-reserve-alert'
import { makeSeries } from './helpers'

const base = { cooldownDays: 7, lookbackDays: 10, enabled: true }
const flat = (n: number) => Array(n).fill(100)

describe('decideAlert', () => {
  it('갱신 없음 → 미발송', () => {
    const series = makeSeries('2026-01-01', flat(25))
    const d = decideAlert({ ...base, series, latestDate: '2026-01-25', lastAlertDataDate: null })
    expect(d).toMatchObject({ send: false, reason: 'no_new_low' })
  })

  it('첫 가동 + 오늘 갱신 → 발송, count=1', () => {
    const series = makeSeries('2026-01-01', [...flat(20), 99])
    const d = decideAlert({ ...base, series, latestDate: '2026-01-21', lastAlertDataDate: null })
    expect(d).toEqual({ send: true, reason: 'new_low', newLowCount: 1, prevLow: 100, lowDates: ['2026-01-21'] })
  })

  it('첫 가동 시 쿨다운 이전의 과거 갱신만 있으면 미발송', () => {
    // 01-21=90(갱신) 후 01-22~01-30 = 95 → 최근 7일(01-24~01-30) 안에는 갱신 없음
    const series = makeSeries('2026-01-01', [...flat(20), 90, ...Array(9).fill(95)])
    const d = decideAlert({ ...base, series, latestDate: '2026-01-30', lastAlertDataDate: null })
    expect(d).toMatchObject({ send: false, reason: 'no_new_low' })
  })

  it('쿨다운 중 갱신 → 미발송', () => {
    const series = makeSeries('2026-01-01', [...flat(20), 99])
    const d = decideAlert({ ...base, series, latestDate: '2026-01-21', lastAlertDataDate: '2026-01-18' })
    expect(d).toMatchObject({ send: false, reason: 'cooldown' })
  })

  it('쿨다운 만료 + 오늘 비갱신 + 묶인 갱신 3건 → 발송, count=3', () => {
    // 01-21=99, 01-22=98, 01-23=97 (갱신), 01-24~01-27=97.5 (비갱신)
    const series = makeSeries('2026-01-01', [...flat(20), 99, 98, 97, 97.5, 97.5, 97.5, 97.5])
    const d = decideAlert({ ...base, series, latestDate: '2026-01-27', lastAlertDataDate: '2026-01-20' })
    expect(d).toEqual({
      send: true,
      reason: 'new_low',
      newLowCount: 3,
      prevLow: 100,
      lowDates: ['2026-01-21', '2026-01-22', '2026-01-23'],
    })
  })

  it('쿨다운 만료 + 오늘 갱신 + 묶인 2건 → count=3', () => {
    // 01-21=99, 01-22=98 (갱신), 01-23~01-26=98.5, 01-27=97 (갱신)
    const series = makeSeries('2026-01-01', [...flat(20), 99, 98, 98.5, 98.5, 98.5, 98.5, 97])
    const d = decideAlert({ ...base, series, latestDate: '2026-01-27', lastAlertDataDate: '2026-01-20' })
    expect(d.send).toBe(true)
    expect(d.newLowCount).toBe(3)
    expect(d.lowDates).toEqual(['2026-01-21', '2026-01-22', '2026-01-27'])
  })

  it('lookback 데이터 부족 → 갱신 아님', () => {
    const series = makeSeries('2026-01-01', [100, 100, 100, 100, 50])
    const d = decideAlert({ ...base, series, latestDate: '2026-01-05', lastAlertDataDate: null })
    expect(d).toMatchObject({ send: false, reason: 'no_new_low' })
  })

  it('enabled=false → 미발송', () => {
    const series = makeSeries('2026-01-01', [...flat(20), 99])
    const d = decideAlert({ ...base, enabled: false, series, latestDate: '2026-01-21', lastAlertDataDate: null })
    expect(d).toMatchObject({ send: false, reason: 'disabled' })
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest __tests__/services/exchange-reserve/exchange-reserve-alert.test.ts`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: 구현**

```ts
// 거래소 보유량 1년 최저 알림 판정 (순수 함수)
// 쿨다운 기준은 발송 시각이 아닌 "데이터 일자" — 재시도·재시작 시각 차이에 영향받지 않음
import { addDays, daysBetween, isNewLowAt, type ReservePoint } from './exchange-reserve-math'

export interface AlertInput {
  series: ReservePoint[]          // 일자 오름차순
  latestDate: string              // 이번에 새로 들어온 최신 일자
  lastAlertDataDate: string | null
  cooldownDays: number
  lookbackDays: number
  enabled: boolean
}

export type AlertReason = 'disabled' | 'cooldown' | 'no_new_low' | 'new_low'

export interface AlertDecision {
  send: boolean
  reason: AlertReason
  newLowCount: number
  prevLow: number | null
  lowDates: string[]
}

function skip(reason: AlertReason): AlertDecision {
  return { send: false, reason, newLowCount: 0, prevLow: null, lowDates: [] }
}

export function decideAlert(input: AlertInput): AlertDecision {
  const { series, latestDate, lastAlertDataDate, cooldownDays, lookbackDays, enabled } = input
  if (!enabled) return skip('disabled')
  if (lastAlertDataDate !== null && daysBetween(lastAlertDataDate, latestDate) < cooldownDays) {
    return skip('cooldown')
  }

  // 최초 가동이면 최근 cooldownDays일 안의 갱신만 (과거 갱신 몰아서 보내지 않기)
  const fromExclusive = lastAlertDataDate ?? addDays(latestDate, -cooldownDays)
  const lowIdx: number[] = []
  series.forEach((p, i) => {
    if (p.date > fromExclusive && p.date <= latestDate && isNewLowAt(series, i, lookbackDays).isLow) {
      lowIdx.push(i)
    }
  })
  if (lowIdx.length === 0) return skip('no_new_low')

  return {
    send: true,
    reason: 'new_low',
    newLowCount: lowIdx.length,
    prevLow: isNewLowAt(series, lowIdx[0], lookbackDays).prevLow,
    lowDates: lowIdx.map((i) => series[i].date),
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest __tests__/services/exchange-reserve/exchange-reserve-alert.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/services/exchange-reserve-alert.ts __tests__/services/exchange-reserve/exchange-reserve-alert.test.ts
git commit -m "feat: 거래소 보유량 1년 최저 알림 판정 순수함수"
```

---

## Task 17: 순수 함수 — 알림 메시지

**Files:**
- Create: `src/services/exchange-reserve-message.ts`
- Test: `__tests__/services/exchange-reserve/exchange-reserve-message.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
import { buildReserveAlertMessage } from '../../../src/services/exchange-reserve-message'

describe('buildReserveAlertMessage', () => {
  it('순유출 + 누적 감소', () => {
    const msg = buildReserveAlertMessage({
      latest: { date: '2026-10-08', supply: 2665392.04, inflow: 27171.07, outflow: 31432.2 },
      prevLow: 2683632.1,
      newLowCount: 4,
    })
    expect(msg).toBe(
      [
        '📉 거래소 BTC 1년 최저 갱신',
        '현재 2,665,392 BTC (이전 최저 2,683,632)',
        '지난 알림 이후 4회 갱신, 누적 -18,240 BTC',
        '전일 순유출 4,261 BTC (입금 27,171 / 출금 31,432)',
        '기준일 2026-10-08 (UTC)',
      ].join('\n'),
    )
  })

  it('유입/유출 없으면 해당 줄 생략', () => {
    const msg = buildReserveAlertMessage({
      latest: { date: '2026-10-08', supply: 100, inflow: null, outflow: null },
      prevLow: 110,
      newLowCount: 1,
    })
    expect(msg).not.toContain('전일')
    expect(msg.split('\n')).toHaveLength(4)
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest __tests__/services/exchange-reserve/exchange-reserve-message.test.ts`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: 구현**

```ts
// 거래소 보유량 알림 카톡 메시지 (순수 함수)
import type { ReservePoint } from './exchange-reserve-math'

const fmt = (n: number) => Math.round(n).toLocaleString('en-US')
const signed = (n: number) => `${n < 0 ? '-' : '+'}${fmt(Math.abs(n))}`

export function buildReserveAlertMessage(p: {
  latest: ReservePoint
  prevLow: number
  newLowCount: number
}): string {
  const { latest, prevLow, newLowCount } = p
  const lines = [
    '📉 거래소 BTC 1년 최저 갱신',
    `현재 ${fmt(latest.supply)} BTC (이전 최저 ${fmt(prevLow)})`,
    `지난 알림 이후 ${newLowCount}회 갱신, 누적 ${signed(latest.supply - prevLow)} BTC`,
  ]
  if (latest.inflow !== null && latest.outflow !== null) {
    const net = latest.inflow - latest.outflow
    const label = net < 0 ? '순유출' : '순유입'
    lines.push(`전일 ${label} ${fmt(Math.abs(net))} BTC (입금 ${fmt(latest.inflow)} / 출금 ${fmt(latest.outflow)})`)
  }
  lines.push(`기준일 ${latest.date} (UTC)`)
  return lines.join('\n')
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest __tests__/services/exchange-reserve/exchange-reserve-message.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/services/exchange-reserve-message.ts __tests__/services/exchange-reserve/exchange-reserve-message.test.ts
git commit -m "feat: 거래소 보유량 알림 메시지 빌더"
```

---

## Task 18: 알림 서비스 (설정·이력·발송)

**Files:**
- Create: `src/services/exchange-reserve-alert.service.ts`
- Test: `__tests__/services/exchange-reserve/exchange-reserve-alert.service.test.ts`

> ⚠️ 카톡 링크 도메인: 현재 백엔드의 어떤 `sendToMe` 호출도 `grid.koco.me` 링크를 쓰지 않는다(기본값은 옛 Vercel 도메인). 카카오 메시지 링크는 **카카오 앱의 Web 플랫폼에 등록된 도메인만** 동작한다. 구현 전 카카오 개발자 콘솔에서 `https://grid.koco.me` 등록 여부를 사용자에게 확인하고, 미등록이면 등록을 요청한다(등록 전에는 메시지는 가도 링크 클릭이 안 될 수 있음).

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
import { prisma } from '../../../__mocks__/database'
import { kakaoNotifyService } from '../../../src/services/kakao-notify.service'
import { runAlertCheck, getAlertConfig } from '../../../src/services/exchange-reserve-alert.service'

jest.mock('../../../src/services/kakao-notify.service', () => ({
  kakaoNotifyService: { sendToMe: jest.fn() },
}))

const cfg = prisma.exchangeReserveAlertConfig as Record<string, jest.Mock>
const alerts = prisma.exchangeReserveAlert as Record<string, jest.Mock>
const daily = prisma.exchangeReserveDaily as Record<string, jest.Mock>
const send = kakaoNotifyService.sendToMe as jest.Mock

// 01-01~01-20 = 100, 01-21 = 99 (lookback 10일이면 갱신)
function dailyRows() {
  const rows = []
  for (let i = 0; i < 21; i++) {
    const date = new Date(Date.UTC(2026, 0, 1 + i))
    rows.push({ date, supplyBtc: i === 20 ? '99' : '100', inflowBtc: null, outflowBtc: null })
  }
  return rows
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(console, 'error').mockImplementation(() => {})
  cfg.upsert.mockResolvedValue({ id: 1, enabled: true, cooldownDays: 7, lookbackDays: 10 })
  daily.findMany.mockResolvedValue(dailyRows())
})

describe('getAlertConfig', () => {
  it('행이 없어도 기본값으로 upsert', async () => {
    await getAlertConfig()
    expect(cfg.upsert).toHaveBeenCalledWith({
      where: { id: 1 },
      create: { id: 1, enabled: true, cooldownDays: 7, lookbackDays: 365 },
      update: {},
    })
  })
})

describe('runAlertCheck', () => {
  it('신저점이면 카톡 발송 후 이력 기록', async () => {
    alerts.findFirst.mockResolvedValue(null)
    send.mockResolvedValue(undefined)
    const r = await runAlertCheck('2026-01-21')
    expect(r).toEqual({ sent: true, reason: 'new_low', newLowCount: 1 })
    expect(send).toHaveBeenCalledWith(expect.stringContaining('1년 최저 갱신'), 'https://grid.koco.me/admin/exchange-reserve')
    expect(alerts.create.mock.calls[0][0].data).toMatchObject({
      dataDate: new Date('2026-01-21T00:00:00Z'),
      supplyBtc: 99,
      prevLowBtc: 100,
      newLowCount: 1,
    })
  })

  it('카톡 실패 시 이력 기록 안 함 (다음 실행 재시도)', async () => {
    alerts.findFirst.mockResolvedValue(null)
    send.mockRejectedValue(new Error('token expired'))
    const r = await runAlertCheck('2026-01-21')
    expect(r).toEqual({ sent: false, reason: 'send_failed', newLowCount: 1 })
    expect(alerts.create).not.toHaveBeenCalled()
  })

  it('쿨다운 중이면 발송 안 함', async () => {
    alerts.findFirst.mockResolvedValue({ dataDate: new Date('2026-01-18T00:00:00Z') })
    const r = await runAlertCheck('2026-01-21')
    expect(r).toEqual({ sent: false, reason: 'cooldown', newLowCount: 0 })
    expect(send).not.toHaveBeenCalled()
  })

  it('해당 일자 데이터가 없으면 no_data', async () => {
    const r = await runAlertCheck('2026-02-01')
    expect(r).toEqual({ sent: false, reason: 'no_data', newLowCount: 0 })
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest __tests__/services/exchange-reserve/exchange-reserve-alert.service.test.ts`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: 구현**

```ts
// 거래소 보유량 알림 — 설정·이력 조회, 1년 최저 판정 후 카톡 발송
import prisma from '../config/database'
import { kakaoNotifyService } from './kakao-notify.service'
import { decideAlert, type AlertReason } from './exchange-reserve-alert'
import { buildReserveAlertMessage } from './exchange-reserve-message'
import { addDays, dayToDate, toDay } from './exchange-reserve-math'
import { loadSeries } from './exchange-reserve.service'

export const ALERT_LINK = 'https://grid.koco.me/admin/exchange-reserve'
const DEFAULT_CONFIG = { enabled: true, cooldownDays: 7, lookbackDays: 365 }
// lookback 비교 구간 외 여유분 (결측일 대비)
const SERIES_MARGIN_DAYS = 40

export interface AlertConfigPatch {
  enabled?: boolean
  cooldownDays?: number
  lookbackDays?: number
}

// 설정 행이 없으면 기본값으로 생성 (시드 누락 방지)
export async function getAlertConfig() {
  return prisma.exchangeReserveAlertConfig.upsert({
    where: { id: 1 },
    create: { id: 1, ...DEFAULT_CONFIG },
    update: {},
  })
}

export async function updateAlertConfig(patch: AlertConfigPatch) {
  return prisma.exchangeReserveAlertConfig.upsert({
    where: { id: 1 },
    create: { id: 1, ...DEFAULT_CONFIG, ...patch },
    update: patch,
  })
}

export async function listAlerts(limit: number) {
  return prisma.exchangeReserveAlert.findMany({ orderBy: { sentAt: 'desc' }, take: limit })
}

export interface AlertCheckResult {
  sent: boolean
  reason: AlertReason | 'send_failed' | 'no_data'
  newLowCount: number
}

// 새 최신 일자가 들어왔을 때 호출. 발송 성공 후에만 이력 기록
export async function runAlertCheck(latestDate: string): Promise<AlertCheckResult> {
  const config = await getAlertConfig()
  const last = await prisma.exchangeReserveAlert.findFirst({ orderBy: { dataDate: 'desc' } })
  const series = await loadSeries(addDays(latestDate, -(config.lookbackDays + SERIES_MARGIN_DAYS)))
  const latest = series.find((p) => p.date === latestDate)
  if (!latest) return { sent: false, reason: 'no_data', newLowCount: 0 }

  const decision = decideAlert({
    series,
    latestDate,
    lastAlertDataDate: last ? toDay(last.dataDate) : null,
    cooldownDays: config.cooldownDays,
    lookbackDays: config.lookbackDays,
    enabled: config.enabled,
  })
  if (!decision.send || decision.prevLow === null) {
    return { sent: false, reason: decision.reason, newLowCount: decision.newLowCount }
  }

  const message = buildReserveAlertMessage({
    latest,
    prevLow: decision.prevLow,
    newLowCount: decision.newLowCount,
  })
  try {
    await kakaoNotifyService.sendToMe(message, ALERT_LINK)
  } catch (e) {
    console.error('[exchange-reserve] 카톡 발송 실패', e)
    return { sent: false, reason: 'send_failed', newLowCount: decision.newLowCount }
  }

  await prisma.exchangeReserveAlert.create({
    data: {
      dataDate: dayToDate(latestDate),
      supplyBtc: latest.supply,
      prevLowBtc: decision.prevLow,
      newLowCount: decision.newLowCount,
      message,
    },
  })
  return { sent: true, reason: 'new_low', newLowCount: decision.newLowCount }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest __tests__/services/exchange-reserve/exchange-reserve-alert.service.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/services/exchange-reserve-alert.service.ts __tests__/services/exchange-reserve/exchange-reserve-alert.service.test.ts
git commit -m "feat: 거래소 보유량 알림 서비스 (설정·이력·카톡 발송)"
```

---

## Task 19: 스케줄러에 알림 연결

**Files:**
- Modify: `src/services/exchange-reserve-scheduler.service.ts`
- Modify: `__tests__/services/exchange-reserve/exchange-reserve-scheduler.test.ts`

- [ ] **Step 1: 테스트에 케이스 추가** — 파일 상단 import/mock에 추가:

```ts
import { runAlertCheck } from '../../../src/services/exchange-reserve-alert.service'

jest.mock('../../../src/services/exchange-reserve-alert.service', () => ({
  runAlertCheck: jest.fn(),
}))
```
`describe('runCycle', ...)` 안에 추가:

```ts
  it('새 최신 일자가 들어오면 알림 판정 실행', async () => {
    ;(runBackfill as jest.Mock).mockResolvedValue({ skipped: true, inserted: 0 })
    ;(runDailyCollect as jest.Mock).mockResolvedValue({ status: 'ok', newData: true, latest: '2026-10-10' })
    ;(runAlertCheck as jest.Mock).mockResolvedValue({ sent: false, reason: 'cooldown', newLowCount: 0 })
    await runCycle('main')
    expect(runAlertCheck).toHaveBeenCalledWith('2026-10-10')
  })

  it('새 데이터가 없으면 알림 판정 생략 (재시도 실행 중복 방지)', async () => {
    ;(runBackfill as jest.Mock).mockResolvedValue({ skipped: true, inserted: 0 })
    ;(runDailyCollect as jest.Mock).mockResolvedValue({ status: 'ok', newData: false, latest: '2026-10-10' })
    await runCycle('retry')
    expect(runAlertCheck).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest __tests__/services/exchange-reserve/exchange-reserve-scheduler.test.ts`
Expected: FAIL — `runAlertCheck` 호출 기대 실패 (1 failed)

- [ ] **Step 3: 구현** — import 추가 및 `runCycle` 교체

```ts
import { runAlertCheck } from './exchange-reserve-alert.service'
```
```ts
// 1회 수집 사이클: 빈 DB면 백필(이전 실패 재시도) → 최근 구간 수집 → 새 일자면 알림 판정
export async function runCycle(label: string): Promise<void> {
  try {
    const backfill = await runBackfill()
    if (!backfill.skipped) console.log(`[exchange-reserve] ${label} backfill`, backfill)
    const collect = await runDailyCollect()
    console.log(`[exchange-reserve] ${label} collect`, collect)
    if (collect.status === 'ok' && collect.newData && collect.latest) {
      const alert = await runAlertCheck(collect.latest)
      console.log(`[exchange-reserve] ${label} alert`, alert)
    }
  } catch (e) {
    console.error(`[exchange-reserve] ${label} 실패`, e)
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest __tests__/services/exchange-reserve/exchange-reserve-scheduler.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/services/exchange-reserve-scheduler.service.ts __tests__/services/exchange-reserve/exchange-reserve-scheduler.test.ts
git commit -m "feat: 거래소 보유량 신규 일자 수집 시 알림 판정 연결"
```

---

## Task 20: 관리자 API

**Files:**
- Create: `src/controllers/exchange-reserve-admin.controller.ts`
- Create: `src/routes/exchange-reserve-admin.ts`
- Modify: `src/routes/index.ts`
- Test: `__tests__/controllers/exchange-reserve-admin.controller.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
import type { Request, Response } from 'express'
import { getAlerts, putConfig } from '../../src/controllers/exchange-reserve-admin.controller'
import { listAlerts, updateAlertConfig } from '../../src/services/exchange-reserve-alert.service'

jest.mock('../../src/services/exchange-reserve-alert.service', () => ({
  getAlertConfig: jest.fn(),
  updateAlertConfig: jest.fn(),
  listAlerts: jest.fn(),
}))

describe('exchange-reserve admin controller', () => {
  let json: jest.Mock
  let status: jest.Mock
  let res: Partial<Response>
  let next: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    json = jest.fn()
    status = jest.fn().mockReturnValue({ json })
    res = { json, status }
    next = jest.fn()
  })

  it('PUT config: 범위 밖 cooldownDays는 400', async () => {
    await putConfig({ body: { cooldownDays: 0 } } as Request, res as Response, next)
    expect(status).toHaveBeenCalledWith(400)
    expect(updateAlertConfig).not.toHaveBeenCalled()
  })

  it('PUT config: 정상 값은 서비스로 전달', async () => {
    ;(updateAlertConfig as jest.Mock).mockResolvedValue({ id: 1, enabled: false, cooldownDays: 3, lookbackDays: 365 })
    await putConfig({ body: { enabled: false, cooldownDays: 3 } } as Request, res as Response, next)
    expect(updateAlertConfig).toHaveBeenCalledWith({ enabled: false, cooldownDays: 3 })
    expect(json).toHaveBeenCalledWith({ id: 1, enabled: false, cooldownDays: 3, lookbackDays: 365 })
  })

  it('GET alerts: Decimal/Date 직렬화, limit 기본 50', async () => {
    ;(listAlerts as jest.Mock).mockResolvedValue([
      {
        id: 1,
        dataDate: new Date('2026-10-08T00:00:00Z'),
        supplyBtc: '2665392.04',
        prevLowBtc: '2672865.56',
        newLowCount: 2,
        message: 'm',
        sentAt: new Date('2026-10-09T02:30:05Z'),
      },
    ])
    await getAlerts({ query: {} } as unknown as Request, res as Response, next)
    expect(listAlerts).toHaveBeenCalledWith(50)
    expect(json).toHaveBeenCalledWith({
      alerts: [
        {
          id: 1,
          dataDate: '2026-10-08',
          supplyBtc: 2665392.04,
          prevLowBtc: 2672865.56,
          newLowCount: 2,
          message: 'm',
          sentAt: '2026-10-09T02:30:05.000Z',
        },
      ],
    })
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest __tests__/controllers/exchange-reserve-admin.controller.test.ts`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: 컨트롤러 구현**

```ts
// 거래소 보유량 알림 관리자 API (authenticate + requireAdmin 뒤에 마운트)
import type { Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { getAlertConfig, listAlerts, updateAlertConfig } from '../services/exchange-reserve-alert.service'

const configSchema = z.object({
  enabled: z.boolean().optional(),
  cooldownDays: z.number().int().min(1).max(30).optional(),
  lookbackDays: z.number().int().min(30).max(730).optional(),
})

export async function getConfig(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await getAlertConfig())
  } catch (e) {
    next(e)
  }
}

export async function putConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = configSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid config', issues: parsed.error.issues })
      return
    }
    res.json(await updateAlertConfig(parsed.data))
  } catch (e) {
    next(e)
  }
}

export async function getAlerts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const raw = Number(req.query.limit ?? 50)
    const limit = Number.isInteger(raw) && raw >= 1 && raw <= 200 ? raw : 50
    const rows = await listAlerts(limit)
    res.json({
      alerts: rows.map((r) => ({
        id: r.id,
        dataDate: r.dataDate.toISOString().slice(0, 10),
        supplyBtc: Number(r.supplyBtc),
        prevLowBtc: Number(r.prevLowBtc),
        newLowCount: r.newLowCount,
        message: r.message,
        sentAt: r.sentAt.toISOString(),
      })),
    })
  } catch (e) {
    next(e)
  }
}
```

- [ ] **Step 4: 라우트 작성** (`src/routes/exchange-reserve-admin.ts`)

```ts
// 거래소 보유량 알림 관리자 라우트 — Base path: /admin/exchange-reserve
import { Router } from 'express'
import { authenticate } from '../middlewares/auth'
import { requireAdmin } from '../middlewares/requireAdmin'
import { getAlerts, getConfig, putConfig } from '../controllers/exchange-reserve-admin.controller'

const router = Router()

router.use(authenticate)
router.use(requireAdmin)

router.get('/config', getConfig)
router.put('/config', putConfig)
router.get('/alerts', getAlerts)

export default router
```

- [ ] **Step 5: 마운트** — `src/routes/index.ts`

import 추가(`exchangeReserveRoutes` import 다음):
```ts
import exchangeReserveAdminRoutes from './exchange-reserve-admin';
```
`router.use('/exchange-reserve', exchangeReserveRoutes);` 다음 줄:
```ts
router.use('/admin/exchange-reserve', exchangeReserveAdminRoutes);
```

- [ ] **Step 6: 통과 확인**

Run: `npx jest __tests__/controllers/exchange-reserve-admin.controller.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 7: 커밋**

```bash
git add src/controllers/exchange-reserve-admin.controller.ts src/routes/exchange-reserve-admin.ts src/routes/index.ts __tests__/controllers/exchange-reserve-admin.controller.test.ts
git commit -m "feat: 거래소 보유량 알림 관리자 API (설정·이력)"
```

---

## Task 21: 백엔드 2단계 검증 → PR → 배포

- [ ] **Step 1: 전체 검증**

```bash
npx jest __tests__/services/exchange-reserve __tests__/controllers/exchange-reserve.controller.test.ts __tests__/controllers/exchange-reserve-admin.controller.test.ts
npx jest
npx tsc --noEmit
npm run build
```
Expected: exchange-reserve 관련 49개 PASS, 기존 대비 새 실패 0, tsc 0 errors, build 성공

- [ ] **Step 2: push + PR** (Task 9 Step 2와 같은 형식, 제목 `feat: 거래소 BTC 보유량 1년 최저 카톡 알림 + 관리자 API (2단계)`, 본문에 "새 테이블 2개, 알림 기본 ON, 첫 판정은 다음 KST 11:30" 명시)

```bash
git push -u origin feat/exchange-reserve-alert
gh pr create --base main --title "feat: 거래소 BTC 보유량 1년 최저 카톡 알림 + 관리자 API (2단계)" --body "$(cat <<'EOF'
## 요약
- 1년(365일) 최저 갱신 시 카톡 알림, 7일 쿨다운(데이터 일자 기준), 쿨다운 중 갱신은 다음 알림에 묶어 요약
- 최초 가동 시 과거 갱신을 몰아 보내지 않음 (최근 7일 안의 갱신만)
- 카톡 발송 성공 후에만 이력 기록 → 실패 시 다음 실행에서 재시도
- 관리자 API: `GET/PUT /api/admin/exchange-reserve/config`, `GET /api/admin/exchange-reserve/alerts`
- 새 테이블 2개(`exchange_reserve_alert_config`, `exchange_reserve_alerts`), 알림 기본 ON
- 첫 판정은 배포 후 다음 KST 11:30 cron

## 테스트
- [x] jest exchange-reserve 49개 통과
- [x] tsc / build 성공
- [ ] 배포 후 migrate 성공·다음 cron 판정 로그 확인

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: 스냅샷 → 머지 → 배포 대기** (Task 9 Step 3~4와 동일 명령, 스냅샷 이름 `pre-exchange-reserve-alert-$(date -u +%Y%m%d-%H%M%S)`)

- [ ] **Step 4: 배포 후 확인**

```bash
ssh <host> 'docker logs grid-bot --since 15m 2>&1 | grep -E "exchange-reserve|migrat" | tail -20'
```
Expected: `20261012000000_add_exchange_reserve_alerts` 적용, `[exchange-reserve] scheduler started`

- [ ] **Step 5: 다음 날 KST 11:30 이후 판정 로그 확인**

```bash
ssh <host> 'docker logs grid-bot --since 3h 2>&1 | grep "exchange-reserve" | tail -10'
```
Expected: `main collect { ..., newData: true }` 다음 `main alert { sent: ..., reason: ... }` 1줄. `retry collect`는 `newData: false`이고 alert 줄 없음.

---

## Task 22: 프론트 관리자 API 함수

**Files:**
- Modify: `lib/api.ts` (Task 11에서 추가한 `getExchangeReserve` 아래)

- [ ] **Step 1: worktree 준비**

```bash
cd /d/ExpressProject/Grid_project/v0-grid-transaction-frontend
git fetch origin
git worktree add ../v0-grid-transaction-frontend-reserve-admin -b feat/exchange-reserve-admin origin/main
cd ../v0-grid-transaction-frontend-reserve-admin && npm ci
```

- [ ] **Step 2: 함수 추가**

```ts

export interface ExchangeReserveAlertConfig {
  id: number;
  enabled: boolean;
  cooldownDays: number;
  lookbackDays: number;
  updatedAt: string;
}

export interface ExchangeReserveAlertRow {
  id: number;
  dataDate: string;
  supplyBtc: number;
  prevLowBtc: number;
  newLowCount: number;
  message: string;
  sentAt: string;
}

export async function getExchangeReserveConfig(): Promise<ExchangeReserveAlertConfig> {
  const res = await fetchWithTimeout(`${API_BASE_URL}/api/admin/exchange-reserve/config`, {
    headers: getAuthHeaders(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? data.message ?? '알림 설정 조회 실패');
  return data;
}

export async function updateExchangeReserveConfig(
  patch: Partial<Pick<ExchangeReserveAlertConfig, 'enabled' | 'cooldownDays' | 'lookbackDays'>>,
): Promise<ExchangeReserveAlertConfig> {
  const res = await fetchWithTimeout(`${API_BASE_URL}/api/admin/exchange-reserve/config`, {
    method: 'PUT',
    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? data.message ?? '알림 설정 저장 실패');
  return data;
}

export async function getExchangeReserveAlerts(limit = 50): Promise<{ alerts: ExchangeReserveAlertRow[] }> {
  const res = await fetchWithTimeout(`${API_BASE_URL}/api/admin/exchange-reserve/alerts?limit=${limit}`, {
    headers: getAuthHeaders(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? data.message ?? '알림 이력 조회 실패');
  return data;
}
```

- [ ] **Step 3: 커밋**

```bash
git add lib/api.ts
git commit -m "feat: 거래소 보유량 알림 관리자 API 함수 추가"
```

---

## Task 23: 순유입/유출 막대 차트

**Files:**
- Create: `components/exchange-reserve/exchange-reserve-flow-chart.tsx`

- [ ] **Step 1: 작성**

```tsx
'use client';

import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ExchangeReservePoint } from '@/lib/api';

// 일별 순유입(+)/순유출(−) 막대 — 유출(보유량 감소)은 빨강
export function ExchangeReserveFlowChart({ data, height = 180 }: { data: ExchangeReservePoint[]; height?: number }) {
  const rows = data
    .filter((p) => p.inflow !== null && p.outflow !== null)
    .map((p) => ({ date: p.date, net: (p.inflow as number) - (p.outflow as number) }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} />
        <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d: string) => d.slice(5)} minTickGap={24} />
        <YAxis tickFormatter={(v: number) => `${Math.round(v / 1000)}k`} tick={{ fontSize: 11 }} width={40} />
        <Tooltip formatter={(v: number) => [`${Math.round(v).toLocaleString()} BTC`, '순유입(+) / 순유출(−)']} />
        <ReferenceLine y={0} strokeOpacity={0.5} />
        <Bar dataKey="net">
          {rows.map((r) => (
            <Cell key={r.date} fill={r.net < 0 ? '#ef4444' : '#22c55e'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 2: 커밋**

```bash
git add components/exchange-reserve/exchange-reserve-flow-chart.tsx
git commit -m "feat: 거래소 BTC 순유입/유출 막대 차트"
```

---

## Task 24: 관리자 페이지 + 메뉴

**Files:**
- Create: `app/admin/exchange-reserve/page.tsx`
- Modify: `components/admin-nav.tsx`

- [ ] **Step 1: 페이지 작성** (관리자 체크는 기존 `app/admin/btc-rsi/page.tsx`와 동일 방식)

```tsx
"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { AdminNav } from "@/components/admin-nav"
import { ExchangeReserveChart } from "@/components/exchange-reserve/exchange-reserve-chart"
import { ExchangeReserveFlowChart } from "@/components/exchange-reserve/exchange-reserve-flow-chart"
import {
  getExchangeReserve,
  getExchangeReserveAlerts,
  getExchangeReserveConfig,
  updateExchangeReserveConfig,
  type ExchangeReserveAlertRow,
  type ExchangeReserveView,
} from "@/lib/api"

const ADMIN_EMAIL = "ok4192@hanmail.net"

export default function ExchangeReserveAdminPage() {
  const router = useRouter()
  const [view, setView] = useState<ExchangeReserveView | null>(null)
  const [alerts, setAlerts] = useState<ExchangeReserveAlertRow[]>([])
  const [enabled, setEnabled] = useState(true)
  const [cooldownDays, setCooldownDays] = useState("7")
  const [lookbackDays, setLookbackDays] = useState("365")
  const [saving, setSaving] = useState(false)

  const loadData = useCallback(async () => {
    try {
      const [v, cfg, hist] = await Promise.all([
        getExchangeReserve(365),
        getExchangeReserveConfig(),
        getExchangeReserveAlerts(),
      ])
      setView(v)
      setEnabled(cfg.enabled)
      setCooldownDays(String(cfg.cooldownDays))
      setLookbackDays(String(cfg.lookbackDays))
      setAlerts(hist.alerts)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "데이터 로딩 실패")
    }
  }, [])

  useEffect(() => {
    const user = JSON.parse(localStorage.getItem("user") || "{}")
    if (user.email !== ADMIN_EMAIL) {
      router.push("/")
      return
    }
    loadData()
  }, [router, loadData])

  const handleSave = async () => {
    setSaving(true)
    try {
      const cfg = await updateExchangeReserveConfig({
        enabled,
        cooldownDays: Number(cooldownDays),
        lookbackDays: Number(lookbackDays),
      })
      setCooldownDays(String(cfg.cooldownDays))
      setLookbackDays(String(cfg.lookbackDays))
      toast.success("알림 설정 저장됨")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "저장 실패 (쿨다운 1~30일, 비교 기간 30~730일)")
    } finally {
      setSaving(false)
    }
  }

  const s = view?.summary

  return (
    <div className="container mx-auto p-4 md:p-6 max-w-6xl">
      <AdminNav />
      <h1 className="text-2xl font-bold mb-4">거래소 BTC 보유량</h1>

      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              보유량 추이 (1년){s?.latestDate ? ` · 기준 ${s.latestDate} (UTC)` : ""}
              {s?.supply != null ? ` · ${Math.round(s.supply).toLocaleString()} BTC` : ""}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ExchangeReserveChart data={view?.series ?? []} height={280} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">일별 순유입(+) / 순유출(−)</CardTitle>
          </CardHeader>
          <CardContent>
            <ExchangeReserveFlowChart data={view?.series ?? []} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">1년 최저 갱신 카톡 알림</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <Switch id="reserve-alert-enabled" checked={enabled} onCheckedChange={setEnabled} />
              <Label htmlFor="reserve-alert-enabled">{enabled ? "알림 켜짐" : "알림 꺼짐"}</Label>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-md">
              <div className="space-y-1">
                <Label htmlFor="reserve-cooldown">쿨다운 (일, 1~30)</Label>
                <Input id="reserve-cooldown" type="number" min={1} max={30} value={cooldownDays} onChange={(e) => setCooldownDays(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="reserve-lookback">비교 기간 (일, 30~730)</Label>
                <Input id="reserve-lookback" type="number" min={30} max={730} value={lookbackDays} onChange={(e) => setLookbackDays(e.target.value)} />
              </div>
            </div>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "저장 중…" : "저장"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">알림 이력</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {alerts.length === 0 ? (
              <p className="text-sm text-muted-foreground">발송된 알림이 없습니다</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>발송 시각</TableHead>
                    <TableHead>기준일</TableHead>
                    <TableHead className="text-right">보유량</TableHead>
                    <TableHead className="text-right">갱신 횟수</TableHead>
                    <TableHead>메시지</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {alerts.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="whitespace-nowrap">{new Date(a.sentAt).toLocaleString("ko-KR")}</TableCell>
                      <TableCell>{a.dataDate}</TableCell>
                      <TableCell className="text-right font-mono">{Math.round(a.supplyBtc).toLocaleString()}</TableCell>
                      <TableCell className="text-right">{a.newLowCount}</TableCell>
                      <TableCell className="whitespace-pre-line text-xs">{a.message}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 메뉴 추가** — `components/admin-nav.tsx`

lucide import 목록 끝(`RotateCcw,` 다음)에 `Bitcoin,` 추가. `ITEMS` 배열 마지막(`재고 되돌림` 다음)에:
```tsx
  { href: "/admin/exchange-reserve", label: "거래소 BTC 보유량", Icon: Bitcoin },
```

- [ ] **Step 3: 빌드 확인 (백그라운드)**

Run: `npm run build`
Expected: `✓ Compiled successfully`, `/admin/exchange-reserve` 라우트 생성

- [ ] **Step 4: 커밋**

```bash
git add app/admin/exchange-reserve/page.tsx components/admin-nav.tsx
git commit -m "feat: 거래소 BTC 보유량 관리자 페이지 + 메뉴"
```

---

## Task 25: 프론트 2단계 PR → 배포 → 확인

- [ ] **Step 1: push + PR + 머지** (Task 14 Step 1과 같은 흐름, 브랜치 `feat/exchange-reserve-admin`, 제목 `feat: 거래소 BTC 보유량 관리자 페이지 (2단계)`)

```bash
git push -u origin feat/exchange-reserve-admin
gh pr create --base main --title "feat: 거래소 BTC 보유량 관리자 페이지 (2단계)" --body "$(cat <<'EOF'
## 요약
- `/admin/exchange-reserve`: 1년 보유량 차트, 일별 순유입/유출 막대, 알림 설정(ON/OFF·쿨다운·비교 기간), 알림 이력
- 관리자 네비에 메뉴 추가

## 테스트
- [x] npm run build 성공
- [ ] 배포 후 설정 저장·이력 표시 확인

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh pr view --json mergeable
gh pr merge --squash
gh run list --limit 1
gh run watch <run-id>
```

- [ ] **Step 2: 화면 확인** — 사용자에게 브라우저 테스트 여부 확인 후 `/pw-tester`로 `https://grid.koco.me/admin/exchange-reserve`에서 차트 2개, 설정 저장(쿨다운 7 → 7 그대로 저장해 토스트 확인), 이력 테이블 확인.

- [ ] **Step 3: worktree 정리는 사용자 확인 후**

---

## 롤백

- 알림만 끄기: 관리자 페이지 OFF (또는 `UPDATE exchange_reserve_alert_config SET enabled=0 WHERE id=1`)
- 기능 전체: 해당 PR revert 배포 (스케줄러 미기동). 새 테이블은 기존 기능과 독립이라 남겨둬도 무해 — **DROP 금지**(production destructive 규칙)
