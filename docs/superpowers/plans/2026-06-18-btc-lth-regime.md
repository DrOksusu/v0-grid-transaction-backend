# BTC Long-Term Holder Regime PoC — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 비트코인 1y/2y/3y 미이동 공급량 비율을 일별 수집·저장하고 `/whale` 페이지에 시계열 차트로 시각화하여 시장 사이클 바닥 신호의 시각적 검증을 가능케 한다.

**Architecture:** Express(Prisma+MySQL) 백엔드가 CoinMetrics Community API(메인) + bitcoin-data.com(폴백) 두 무료 소스에서 매일 UTC 01:00에 일 1행을 폴링하고, Next.js 프론트가 `/api/market-regime/*` 엔드포인트로 시계열을 조회해 Recharts ComposedChart에 표시한다. regime 분류(BOTTOM/NEUTRAL/TOP)는 컷오프 튜닝을 위해 DB에 저장하지 않고 응답 시 계산한다.

**Tech Stack:** Express 5 / TypeScript / Prisma (MySQL) / node-cron / zod / Jest (백엔드) — Next.js 16 / React 19 / Recharts / shadcn/ui / Vitest + RTL (프론트엔드)

**Spec:** `docs/superpowers/specs/2026-06-18-btc-lth-regime-design.md`

---

## File Structure

### Phase 1 — 백엔드 (`v0-grid-tranasction-backend/`)

| 파일 | 책임 |
|------|------|
| `prisma/schema.prisma` (수정) | `BtcDormantSnapshot` 모델 추가 |
| `prisma/migrations/<ts>_add_btc_dormant_snapshot/` | 마이그레이션 |
| `src/config/market-regime.ts` (신규) | 컷오프 상수, `classifyRegime()`, env 로딩 |
| `src/services/market-regime.schemas.ts` (신규) | CoinMetrics / bitcoin-data 응답 zod 스키마 |
| `src/services/market-regime.service.ts` (신규) | fetch / reconcile / 계산 / 백필 / 일별 폴링 |
| `src/services/market-regime-scheduler.service.ts` (신규) | node-cron 트리거 + 부팅 시 백필 진입 |
| `src/controllers/market-regime.controller.ts` (신규) | 2개 엔드포인트 |
| `src/routes/market-regime.routes.ts` (신규) | `/api/market-regime/*` 라우트 |
| `src/app.ts` (수정) | 라우트 마운트 (1줄) |
| `src/index.ts` (수정) | 스케줄러 부팅 시 시작 (1줄) |
| `.env.example` (수정) | 신규 env 변수 추가 |
| `src/services/__tests__/market-regime.service.test.ts` | 유닛 |
| `src/services/__tests__/market-regime.integration.test.ts` | 통합 (실제 API 1회) |

### Phase 2 — 프론트엔드 (`v0-grid-transaction-frontend/`)

| 파일 | 책임 |
|------|------|
| `lib/api.ts` (수정) | 타입 + `getBtcRegimeCurrent` / `getBtcRegimeTimeseries` |
| `components/market-regime/regime-badge.tsx` (신규) | BOTTOM/NEUTRAL/TOP 배지 |
| `components/market-regime/btc-dormant-chart.tsx` (신규) | Recharts ComposedChart |
| `components/market-regime/btc-regime-section.tsx` (신규) | API 호출 + 상태 wrapper |
| `app/whale/page.tsx` (수정) | 섹션 삽입 (5줄) |
| `components/market-regime/__tests__/*.test.tsx` | Vitest + RTL |

---

# Phase 1 — 백엔드 (PR #A)

작업 디렉터리는 모두 `v0-grid-tranasction-backend/`. 모든 명령은 그 안에서 실행.

---

### Task 1: 환경 변수 + config 모듈

**Files:**
- Create: `src/config/market-regime.ts`
- Modify: `.env.example`

- [ ] **Step 1: `.env.example`에 변수 추가**

`.env.example` 끝에 추가:
```
# Market Regime PoC (BTC long-term holder ratio)
COINMETRICS_API_BASE=https://community-api.coinmetrics.io/v4
COINMETRICS_API_KEY=
BITCOIN_DATA_API_BASE=https://bitcoin-data.com/api/v1
REGIME_2Y_BOTTOM_CUTOFF=0.65
REGIME_2Y_TOP_CUTOFF=0.55
MARKET_REGIME_CRON=0 1 * * *
MARKET_REGIME_BACKFILL_YEARS=10
```

- [ ] **Step 2: config 모듈 생성**

`src/config/market-regime.ts`:
```typescript
export type Regime = 'BOTTOM' | 'NEUTRAL' | 'TOP'
export type Series = '1y' | '2y' | '3y'

const env2y = {
  bottom: Number(process.env.REGIME_2Y_BOTTOM_CUTOFF ?? '0.65'),
  top: Number(process.env.REGIME_2Y_TOP_CUTOFF ?? '0.55'),
}

// 2y 기준 ±5pt offset
export const REGIME_THRESHOLDS: Record<Series, { bottom: number; top: number }> = {
  '1y': { bottom: env2y.bottom + 0.05, top: env2y.top + 0.05 },
  '2y': { bottom: env2y.bottom, top: env2y.top },
  '3y': { bottom: env2y.bottom - 0.05, top: env2y.top - 0.05 },
}

export const MARKET_REGIME_CONFIG = {
  coinmetricsBase: process.env.COINMETRICS_API_BASE ?? 'https://community-api.coinmetrics.io/v4',
  coinmetricsApiKey: process.env.COINMETRICS_API_KEY ?? '',
  bitcoinDataBase: process.env.BITCOIN_DATA_API_BASE ?? 'https://bitcoin-data.com/api/v1',
  cron: process.env.MARKET_REGIME_CRON ?? '0 1 * * *',
  backfillYears: Number(process.env.MARKET_REGIME_BACKFILL_YEARS ?? '10'),
  reconcileThreshold: 0.05,
  fetchTimeoutMs: 30_000,
  retryDelaysMs: [10_000, 30_000, 90_000] as const,
} as const

export function classifyRegime(ratio: number, series: Series): Regime {
  const t = REGIME_THRESHOLDS[series]
  if (ratio >= t.bottom) return 'BOTTOM'
  if (ratio <= t.top) return 'TOP'
  return 'NEUTRAL'
}
```

- [ ] **Step 3: 타입 체크**

```bash
npx tsc --noEmit
```
Expected: 에러 0개.

- [ ] **Step 4: 커밋**

```bash
git add src/config/market-regime.ts .env.example
git commit -m "feat: BTC regime config 모듈 및 env 변수 추가"
```

---

### Task 2: Prisma 스키마 + 마이그레이션

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_btc_dormant_snapshot/migration.sql`

- [ ] **Step 1: schema.prisma에 모델 추가**

`prisma/schema.prisma` 마지막에 추가:
```prisma
model BtcDormantSnapshot {
  date              DateTime @id @db.Date

  dormant1yRatio    Decimal  @db.Decimal(6, 5)
  dormant2yRatio    Decimal  @db.Decimal(6, 5)
  dormant3yRatio    Decimal  @db.Decimal(6, 5)

  btcPriceUsd       Decimal  @db.Decimal(20, 8)

  rawCoinmetrics    Json?
  rawBitcoinData    Json?

  reconcileWarning  Boolean  @default(false)
  dataSource        String   @db.VarChar(16)

  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@index([date])
  @@map("btc_dormant_snapshots")
}
```

- [ ] **Step 2: 마이그레이션 생성 (create-only로 확인 후 적용)**

```bash
npx prisma migrate dev --name add_btc_dormant_snapshot --create-only
```

생성된 `migration.sql`을 열어 박스 문자나 이상한 문자가 들어가지 않았는지 검사 (Prisma 5.x CLI garbage 버그 회피).

```bash
tail -50 prisma/migrations/*_add_btc_dormant_snapshot/migration.sql
```

- [ ] **Step 3: 마이그레이션 적용**

```bash
npx prisma migrate dev
```
Expected: `Database now in sync with your schema.`

- [ ] **Step 4: Prisma 클라이언트 재생성 확인**

```bash
npx prisma generate
```

- [ ] **Step 5: 커밋**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: BtcDormantSnapshot 모델 및 마이그레이션 추가"
```

---

### Task 3: 외부 API 응답 zod 스키마

**Files:**
- Create: `src/services/market-regime.schemas.ts`
- Create: `src/services/__tests__/market-regime.schemas.test.ts`

- [ ] **Step 1: failing test 작성**

`src/services/__tests__/market-regime.schemas.test.ts`:
```typescript
import {
  coinmetricsResponseSchema,
  bitcoinDataHodlWavesSchema,
} from '../market-regime.schemas'

describe('coinmetricsResponseSchema', () => {
  it('일별 BTC supply 응답을 파싱한다', () => {
    const raw = {
      data: [
        {
          asset: 'btc',
          time: '2026-06-17T00:00:00Z',
          SplyAct1yr: '5000000',
          SplyAct2yr: '4500000',
          SplyAct3yr: '4200000',
          SplyCur: '19700000',
          PriceUSD: '91234.56',
        },
      ],
    }
    const parsed = coinmetricsResponseSchema.parse(raw)
    expect(parsed.data[0].SplyAct2yr).toBe(4500000)
  })

  it('필드 누락 시 throw', () => {
    expect(() =>
      coinmetricsResponseSchema.parse({ data: [{ asset: 'btc' }] }),
    ).toThrow()
  })
})

describe('bitcoinDataHodlWavesSchema', () => {
  it('hodl waves 응답을 파싱한다', () => {
    const raw = [
      { d: '2026-06-17', '1y': 0.12, '2y': 0.08, '3y': 0.07, '5y': 0.05, '7y': 0.04, '10y': 0.03 },
    ]
    const parsed = bitcoinDataHodlWavesSchema.parse(raw)
    expect(parsed[0]['2y']).toBe(0.08)
  })
})
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

```bash
npx jest src/services/__tests__/market-regime.schemas.test.ts
```
Expected: FAIL (module not found).

- [ ] **Step 3: 스키마 모듈 생성**

`src/services/market-regime.schemas.ts`:
```typescript
import { z } from 'zod'

// CoinMetrics: 숫자가 문자열로 옴 → coerce
const numericString = z.preprocess(
  (v) => (typeof v === 'string' ? Number(v) : v),
  z.number(),
)

export const coinmetricsRowSchema = z.object({
  asset: z.string(),
  time: z.string(),
  SplyAct1yr: numericString,
  SplyAct2yr: numericString,
  SplyAct3yr: numericString,
  SplyCur: numericString,
  PriceUSD: numericString,
})

export const coinmetricsResponseSchema = z.object({
  data: z.array(coinmetricsRowSchema),
})

export type CoinmetricsRow = z.infer<typeof coinmetricsRowSchema>

// bitcoin-data.com hodl-waves — 실제 응답 schema는 구현 첫 fetch로 확인 후 조정.
// 가정: 배열 of { d: date, '<bucket>': number, ... }
// 버킷 라벨은 실제 응답 기준으로 매핑.
export const bitcoinDataHodlWavesRowSchema = z
  .object({
    d: z.string(),
  })
  .catchall(z.number())

export const bitcoinDataHodlWavesSchema = z.array(bitcoinDataHodlWavesRowSchema)

export type BitcoinDataHodlWavesRow = z.infer<typeof bitcoinDataHodlWavesRowSchema>

// 2년+ dormant 산정에 합산할 버킷 키.
// 실제 응답 schema 확인 후 조정 가능.
export const BD_LONG_TERM_BUCKETS = ['2y', '3y', '5y', '7y', '10y'] as const
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
npx jest src/services/__tests__/market-regime.schemas.test.ts
```
Expected: PASS, 2 tests.

- [ ] **Step 5: 커밋**

```bash
git add src/services/market-regime.schemas.ts src/services/__tests__/market-regime.schemas.test.ts
git commit -m "feat: market regime 외부 API 응답 zod 스키마 추가"
```

---

### Task 4: classifyRegime 유닛 테스트

**Files:**
- Modify: `src/services/__tests__/market-regime.service.test.ts` (Create)

- [ ] **Step 1: failing test 작성**

`src/services/__tests__/market-regime.service.test.ts`:
```typescript
import { classifyRegime, REGIME_THRESHOLDS } from '../../config/market-regime'

describe('classifyRegime', () => {
  it('2y series boundary — 0.65 → BOTTOM', () => {
    expect(classifyRegime(0.65, '2y')).toBe('BOTTOM')
  })
  it('2y series boundary — 0.649 → NEUTRAL', () => {
    expect(classifyRegime(0.649, '2y')).toBe('NEUTRAL')
  })
  it('2y series boundary — 0.55 → TOP', () => {
    expect(classifyRegime(0.55, '2y')).toBe('TOP')
  })
  it('2y series boundary — 0.551 → NEUTRAL', () => {
    expect(classifyRegime(0.551, '2y')).toBe('NEUTRAL')
  })
  it('1y series uses +5pt offset', () => {
    expect(classifyRegime(0.7, '1y')).toBe('BOTTOM')
    expect(classifyRegime(0.69, '1y')).toBe('NEUTRAL')
  })
  it('3y series uses -5pt offset', () => {
    expect(classifyRegime(0.6, '3y')).toBe('BOTTOM')
    expect(classifyRegime(0.5, '3y')).toBe('TOP')
  })
})
```

- [ ] **Step 2: 테스트 실행**

```bash
npx jest src/services/__tests__/market-regime.service.test.ts
```
Expected: PASS (Task 1에서 구현 완료).

- [ ] **Step 3: 커밋**

```bash
git add src/services/__tests__/market-regime.service.test.ts
git commit -m "test: classifyRegime boundary 테스트 추가"
```

---

### Task 5: market-regime.service.ts — fetchFromCoinMetrics (TDD)

**Files:**
- Create: `src/services/market-regime.service.ts`
- Modify: `src/services/__tests__/market-regime.service.test.ts`

- [ ] **Step 1: failing test 추가**

기존 `market-regime.service.test.ts` 상단에 import 및 mock 추가:
```typescript
import { fetchFromCoinMetrics } from '../market-regime.service'

// global fetch mock
const originalFetch = global.fetch
afterEach(() => { global.fetch = originalFetch })

describe('fetchFromCoinMetrics', () => {
  it('단일 일자 fetch 정상 응답', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{
          asset: 'btc', time: '2026-06-17T00:00:00Z',
          SplyAct1yr: '5000000', SplyAct2yr: '4500000', SplyAct3yr: '4200000',
          SplyCur: '19700000', PriceUSD: '91234.56',
        }],
      }),
    }) as any
    const rows = await fetchFromCoinMetrics(new Date('2026-06-17'), new Date('2026-06-17'))
    expect(rows).toHaveLength(1)
    expect(rows[0].SplyAct2yr).toBe(4500000)
  })

  it('HTTP 5xx → throw', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 }) as any
    await expect(
      fetchFromCoinMetrics(new Date('2026-06-17'), new Date('2026-06-17')),
    ).rejects.toThrow(/503/)
  })
})
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

```bash
npx jest src/services/__tests__/market-regime.service.test.ts -t fetchFromCoinMetrics
```
Expected: FAIL (module not exporting fetchFromCoinMetrics).

- [ ] **Step 3: market-regime.service.ts 생성 — fetchFromCoinMetrics 구현**

`src/services/market-regime.service.ts`:
```typescript
import { MARKET_REGIME_CONFIG } from '../config/market-regime'
import {
  coinmetricsResponseSchema,
  type CoinmetricsRow,
} from './market-regime.schemas'

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export async function fetchFromCoinMetrics(
  start: Date,
  end: Date,
): Promise<CoinmetricsRow[]> {
  const params = new URLSearchParams({
    assets: 'btc',
    metrics: 'SplyAct1yr,SplyAct2yr,SplyAct3yr,SplyCur,PriceUSD',
    start_time: fmtDate(start),
    end_time: fmtDate(end),
    frequency: '1d',
    page_size: '10000',
  })
  if (MARKET_REGIME_CONFIG.coinmetricsApiKey) {
    params.set('api_key', MARKET_REGIME_CONFIG.coinmetricsApiKey)
  }
  const url = `${MARKET_REGIME_CONFIG.coinmetricsBase}/timeseries/asset-metrics?${params}`
  const ctl = new AbortController()
  const to = setTimeout(() => ctl.abort(), MARKET_REGIME_CONFIG.fetchTimeoutMs)
  try {
    const res = await fetch(url, { signal: ctl.signal })
    if (!res.ok) throw new Error(`CoinMetrics ${res.status}`)
    const json = await res.json()
    return coinmetricsResponseSchema.parse(json).data
  } finally {
    clearTimeout(to)
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
npx jest src/services/__tests__/market-regime.service.test.ts -t fetchFromCoinMetrics
```
Expected: PASS, 2 tests.

- [ ] **Step 5: 커밋**

```bash
git add src/services/market-regime.service.ts src/services/__tests__/market-regime.service.test.ts
git commit -m "feat: CoinMetrics community API fetch 함수 추가"
```

---

### Task 6: fetchFromBitcoinData + retry 래퍼

**Files:**
- Modify: `src/services/market-regime.service.ts`
- Modify: `src/services/__tests__/market-regime.service.test.ts`

- [ ] **Step 1: failing test 추가**

```typescript
import { fetchFromBitcoinData, withRetry } from '../market-regime.service'

describe('fetchFromBitcoinData', () => {
  it('hodl-waves 응답을 배열로 반환', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ([
        { d: '2026-06-17', '1y': 0.12, '2y': 0.08, '3y': 0.07, '5y': 0.05, '7y': 0.04, '10y': 0.03 },
      ]),
    }) as any
    const rows = await fetchFromBitcoinData()
    expect(rows[0]['2y']).toBe(0.08)
  })
})

describe('withRetry', () => {
  it('첫 시도 성공 시 1회만 호출', async () => {
    const fn = jest.fn().mockResolvedValue('ok')
    await withRetry(fn, [10, 10, 10])
    expect(fn).toHaveBeenCalledTimes(1)
  })
  it('2회 실패 후 3번째 성공', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce('ok')
    const out = await withRetry(fn, [10, 10, 10])
    expect(out).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  }, 1000)
})
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

```bash
npx jest src/services/__tests__/market-regime.service.test.ts -t 'fetchFromBitcoinData|withRetry'
```
Expected: FAIL.

- [ ] **Step 3: 구현 추가**

`src/services/market-regime.service.ts`에 추가:
```typescript
import {
  bitcoinDataHodlWavesSchema,
  type BitcoinDataHodlWavesRow,
} from './market-regime.schemas'

export async function fetchFromBitcoinData(): Promise<BitcoinDataHodlWavesRow[]> {
  const url = `${MARKET_REGIME_CONFIG.bitcoinDataBase}/hodl-waves`
  const ctl = new AbortController()
  const to = setTimeout(() => ctl.abort(), MARKET_REGIME_CONFIG.fetchTimeoutMs)
  try {
    const res = await fetch(url, { signal: ctl.signal })
    if (!res.ok) throw new Error(`bitcoin-data ${res.status}`)
    const json = await res.json()
    return bitcoinDataHodlWavesSchema.parse(json)
  } finally {
    clearTimeout(to)
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  delaysMs: readonly number[],
): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i <= delaysMs.length; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (i === delaysMs.length) break
      await new Promise((r) => setTimeout(r, delaysMs[i]))
    }
  }
  throw lastErr
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
npx jest src/services/__tests__/market-regime.service.test.ts
```
Expected: 모든 테스트 PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/services/market-regime.service.ts src/services/__tests__/market-regime.service.test.ts
git commit -m "feat: bitcoin-data.com fetch 및 retry 유틸 추가"
```

---

### Task 7: reconcile + 행 계산 함수

**Files:**
- Modify: `src/services/market-regime.service.ts`
- Modify: `src/services/__tests__/market-regime.service.test.ts`

- [ ] **Step 1: failing test 추가**

```typescript
import { computeSnapshotRow, reconcile } from '../market-regime.service'

describe('reconcile', () => {
  it('5%p 미만 차이 → 경고 없음', () => {
    expect(reconcile(0.6234, 0.65)).toBe(false)
  })
  it('5.1%p 차이 → 경고', () => {
    expect(reconcile(0.6234, 0.6745)).toBe(true)
  })
})

describe('computeSnapshotRow', () => {
  it('CoinMetrics + bitcoin-data 둘 다 있을 때 BOTH로 저장', () => {
    const cm = {
      asset: 'btc', time: '2026-06-17T00:00:00Z',
      SplyAct1yr: 5000000, SplyAct2yr: 4500000, SplyAct3yr: 4200000,
      SplyCur: 19700000, PriceUSD: 91234.56,
    } as any
    const bd = { d: '2026-06-17', '1y': 0.12, '2y': 0.08, '3y': 0.07, '5y': 0.05, '7y': 0.04, '10y': 0.03 } as any
    const row = computeSnapshotRow(new Date('2026-06-17'), cm, bd)
    expect(row.dataSource).toBe('BOTH')
    expect(row.dormant2yRatio).toBeCloseTo(1 - 4500000 / 19700000, 5)
    expect(row.btcPriceUsd).toBe(91234.56)
  })

  it('CoinMetrics 만 있을 때 PRIMARY', () => {
    const cm = {
      asset: 'btc', time: '2026-06-17T00:00:00Z',
      SplyAct1yr: 5000000, SplyAct2yr: 4500000, SplyAct3yr: 4200000,
      SplyCur: 19700000, PriceUSD: 91234.56,
    } as any
    const row = computeSnapshotRow(new Date('2026-06-17'), cm, null)
    expect(row.dataSource).toBe('PRIMARY')
    expect(row.reconcileWarning).toBe(false)
  })

  it('bitcoin-data 만 있을 때 FALLBACK', () => {
    const bd = { d: '2026-06-17', '1y': 0.12, '2y': 0.08, '3y': 0.07, '5y': 0.05, '7y': 0.04, '10y': 0.03 } as any
    const row = computeSnapshotRow(new Date('2026-06-17'), null, bd, 88000)
    expect(row.dataSource).toBe('FALLBACK')
    expect(row.dormant2yRatio).toBeCloseTo(0.08 + 0.07 + 0.05 + 0.04 + 0.03, 5)
    expect(row.btcPriceUsd).toBe(88000)
  })
})
```

- [ ] **Step 2: 실패 확인**

```bash
npx jest src/services/__tests__/market-regime.service.test.ts -t 'reconcile|computeSnapshotRow'
```
Expected: FAIL.

- [ ] **Step 3: 구현 추가**

`src/services/market-regime.service.ts`에 추가:
```typescript
import { BD_LONG_TERM_BUCKETS } from './market-regime.schemas'
import { MARKET_REGIME_CONFIG } from '../config/market-regime'

export interface SnapshotInput {
  date: Date
  dormant1yRatio: number
  dormant2yRatio: number
  dormant3yRatio: number
  btcPriceUsd: number
  rawCoinmetrics: unknown | null
  rawBitcoinData: unknown | null
  reconcileWarning: boolean
  dataSource: 'PRIMARY' | 'FALLBACK' | 'BOTH' | 'NONE'
}

export function reconcile(cmDormant2y: number, bdDormant2y: number): boolean {
  return Math.abs(cmDormant2y - bdDormant2y) > MARKET_REGIME_CONFIG.reconcileThreshold
}

function sumBuckets(bd: Record<string, number | string>, keys: readonly string[]): number {
  return keys.reduce((s, k) => s + (typeof bd[k] === 'number' ? (bd[k] as number) : 0), 0)
}

export function computeSnapshotRow(
  date: Date,
  cm: CoinmetricsRow | null,
  bd: BitcoinDataHodlWavesRow | null,
  fallbackBtcPriceUsd?: number,
): SnapshotInput {
  if (cm && bd) {
    const d1 = 1 - cm.SplyAct1yr / cm.SplyCur
    const d2 = 1 - cm.SplyAct2yr / cm.SplyCur
    const d3 = 1 - cm.SplyAct3yr / cm.SplyCur
    const bdDormant2y = sumBuckets(bd as any, BD_LONG_TERM_BUCKETS)
    return {
      date,
      dormant1yRatio: d1,
      dormant2yRatio: d2,
      dormant3yRatio: d3,
      btcPriceUsd: cm.PriceUSD,
      rawCoinmetrics: cm,
      rawBitcoinData: bd,
      reconcileWarning: reconcile(d2, bdDormant2y),
      dataSource: 'BOTH',
    }
  }
  if (cm) {
    return {
      date,
      dormant1yRatio: 1 - cm.SplyAct1yr / cm.SplyCur,
      dormant2yRatio: 1 - cm.SplyAct2yr / cm.SplyCur,
      dormant3yRatio: 1 - cm.SplyAct3yr / cm.SplyCur,
      btcPriceUsd: cm.PriceUSD,
      rawCoinmetrics: cm,
      rawBitcoinData: null,
      reconcileWarning: false,
      dataSource: 'PRIMARY',
    }
  }
  if (bd) {
    const sum1 = sumBuckets(bd as any, ['1y', ...BD_LONG_TERM_BUCKETS])
    const sum2 = sumBuckets(bd as any, BD_LONG_TERM_BUCKETS)
    const sum3 = sumBuckets(bd as any, ['3y', '5y', '7y', '10y'])
    return {
      date,
      dormant1yRatio: sum1,
      dormant2yRatio: sum2,
      dormant3yRatio: sum3,
      btcPriceUsd: fallbackBtcPriceUsd ?? 0,
      rawCoinmetrics: null,
      rawBitcoinData: bd,
      reconcileWarning: false,
      dataSource: 'FALLBACK',
    }
  }
  throw new Error('computeSnapshotRow: both sources null')
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
npx jest src/services/__tests__/market-regime.service.test.ts
```
Expected: 모두 PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/services/market-regime.service.ts src/services/__tests__/market-regime.service.test.ts
git commit -m "feat: reconcile 및 snapshot row 계산 함수 추가"
```

---

### Task 8: 백필 함수 (createMany)

**Files:**
- Modify: `src/services/market-regime.service.ts`
- Modify: `src/services/__tests__/market-regime.service.test.ts`

- [ ] **Step 1: failing test 추가**

```typescript
import { runBackfill } from '../market-regime.service'
import prisma from '../../config/database'

jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    btcDormantSnapshot: {
      count: jest.fn(),
      createMany: jest.fn(),
    },
  },
}))

describe('runBackfill', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('DB 0건 + fetch 정상 → createMany 호출', async () => {
    ;(prisma.btcDormantSnapshot.count as jest.Mock).mockResolvedValue(0)
    ;(prisma.btcDormantSnapshot.createMany as jest.Mock).mockResolvedValue({ count: 3650 })

    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: Array.from({ length: 3 }, (_, i) => ({
            asset: 'btc',
            time: `2026-06-${15 + i}T00:00:00Z`,
            SplyAct1yr: '5000000', SplyAct2yr: '4500000', SplyAct3yr: '4200000',
            SplyCur: '19700000', PriceUSD: '91234.56',
          })),
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          { d: '2026-06-15', '1y': 0.12, '2y': 0.08, '3y': 0.07, '5y': 0.05, '7y': 0.04, '10y': 0.03 },
          { d: '2026-06-16', '1y': 0.12, '2y': 0.08, '3y': 0.07, '5y': 0.05, '7y': 0.04, '10y': 0.03 },
          { d: '2026-06-17', '1y': 0.12, '2y': 0.08, '3y': 0.07, '5y': 0.05, '7y': 0.04, '10y': 0.03 },
        ]),
      }) as any

    const result = await runBackfill()
    expect(result.inserted).toBeGreaterThan(0)
    expect(prisma.btcDormantSnapshot.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    )
  })

  it('DB에 이미 데이터 있으면 skip', async () => {
    ;(prisma.btcDormantSnapshot.count as jest.Mock).mockResolvedValue(100)
    const result = await runBackfill()
    expect(result.skipped).toBe(true)
    expect(prisma.btcDormantSnapshot.createMany).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 실패 확인**

```bash
npx jest src/services/__tests__/market-regime.service.test.ts -t runBackfill
```
Expected: FAIL.

- [ ] **Step 3: 구현 추가**

`src/services/market-regime.service.ts`에 추가:
```typescript
import prisma from '../config/database'

export interface BackfillResult {
  skipped: boolean
  inserted: number
}

export async function runBackfill(): Promise<BackfillResult> {
  const existing = await prisma.btcDormantSnapshot.count()
  if (existing > 0) return { skipped: true, inserted: 0 }

  const end = new Date()
  end.setUTCDate(end.getUTCDate() - 1) // 어제
  end.setUTCHours(0, 0, 0, 0)
  const start = new Date(end)
  start.setUTCFullYear(start.getUTCFullYear() - MARKET_REGIME_CONFIG.backfillYears)

  const [cmRows, bdRows] = await Promise.all([
    withRetry(() => fetchFromCoinMetrics(start, end), MARKET_REGIME_CONFIG.retryDelaysMs).catch(() => []),
    withRetry(() => fetchFromBitcoinData(), MARKET_REGIME_CONFIG.retryDelaysMs).catch(() => []),
  ])

  const bdByDate = new Map(bdRows.map((r) => [r.d.slice(0, 10), r]))
  const cmByDate = new Map(cmRows.map((r) => [r.time.slice(0, 10), r]))
  const dates = new Set([...bdByDate.keys(), ...cmByDate.keys()])

  const rows: SnapshotInput[] = []
  for (const dstr of dates) {
    const date = new Date(`${dstr}T00:00:00Z`)
    if (date < start || date > end) continue
    const cm = cmByDate.get(dstr) ?? null
    const bd = bdByDate.get(dstr) ?? null
    if (!cm && !bd) continue
    try {
      rows.push(computeSnapshotRow(date, cm, bd))
    } catch {
      /* both null — skip */
    }
  }

  if (rows.length === 0) return { skipped: false, inserted: 0 }

  const result = await prisma.btcDormantSnapshot.createMany({
    data: rows.map((r) => ({
      date: r.date,
      dormant1yRatio: r.dormant1yRatio,
      dormant2yRatio: r.dormant2yRatio,
      dormant3yRatio: r.dormant3yRatio,
      btcPriceUsd: r.btcPriceUsd,
      rawCoinmetrics: r.rawCoinmetrics as any,
      rawBitcoinData: r.rawBitcoinData as any,
      reconcileWarning: r.reconcileWarning,
      dataSource: r.dataSource,
    })),
    skipDuplicates: true,
  })

  return { skipped: false, inserted: result.count }
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
npx jest src/services/__tests__/market-regime.service.test.ts -t runBackfill
```
Expected: 2 tests PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/services/market-regime.service.ts src/services/__tests__/market-regime.service.test.ts
git commit -m "feat: 10년 백필 함수 추가 (createMany skipDuplicates)"
```

---

### Task 9: 일별 폴링 함수 (upsert)

**Files:**
- Modify: `src/services/market-regime.service.ts`
- Modify: `src/services/__tests__/market-regime.service.test.ts`

- [ ] **Step 1: failing test 추가**

```typescript
import { runDailyPoll } from '../market-regime.service'

describe('runDailyPoll', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.btcDormantSnapshot as any).findUnique = jest.fn()
    ;(prisma.btcDormantSnapshot as any).upsert = jest.fn()
  })

  it('어제 날짜 row 이미 있으면 skip', async () => {
    ;(prisma.btcDormantSnapshot.findUnique as jest.Mock).mockResolvedValue({ date: 'x' })
    const r = await runDailyPoll()
    expect(r.status).toBe('skipped_existing')
  })

  it('두 소스 모두 실패 → status=failed', async () => {
    ;(prisma.btcDormantSnapshot.findUnique as jest.Mock).mockResolvedValue(null)
    global.fetch = jest.fn().mockRejectedValue(new Error('net')) as any
    const r = await runDailyPoll()
    expect(r.status).toBe('failed')
  })

  it('CoinMetrics 정상 → upsert 호출', async () => {
    ;(prisma.btcDormantSnapshot.findUnique as jest.Mock).mockResolvedValue(null)
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{
            asset: 'btc',
            time: new Date(Date.now() - 86400000).toISOString().slice(0, 10) + 'T00:00:00Z',
            SplyAct1yr: '5000000', SplyAct2yr: '4500000', SplyAct3yr: '4200000',
            SplyCur: '19700000', PriceUSD: '91234.56',
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          { d: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
            '1y': 0.12, '2y': 0.08, '3y': 0.07, '5y': 0.05, '7y': 0.04, '10y': 0.03 },
        ]),
      }) as any

    const r = await runDailyPoll()
    expect(r.status).toBe('ok')
    expect(prisma.btcDormantSnapshot.upsert).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 실패 확인**

```bash
npx jest src/services/__tests__/market-regime.service.test.ts -t runDailyPoll
```
Expected: FAIL.

- [ ] **Step 3: 구현 추가**

`src/services/market-regime.service.ts`에 추가:
```typescript
export interface DailyPollResult {
  status: 'ok' | 'skipped_existing' | 'failed'
  date?: string
  dataSource?: string
}

export async function runDailyPoll(): Promise<DailyPollResult> {
  const fetchDate = new Date()
  fetchDate.setUTCDate(fetchDate.getUTCDate() - 1)
  fetchDate.setUTCHours(0, 0, 0, 0)
  const dstr = fetchDate.toISOString().slice(0, 10)

  const existing = await prisma.btcDormantSnapshot.findUnique({ where: { date: fetchDate } })
  if (existing) return { status: 'skipped_existing', date: dstr }

  const cmResult = await withRetry(
    () => fetchFromCoinMetrics(fetchDate, fetchDate),
    MARKET_REGIME_CONFIG.retryDelaysMs,
  ).catch(() => null)

  const bdResult = await withRetry(
    () => fetchFromBitcoinData(),
    MARKET_REGIME_CONFIG.retryDelaysMs,
  ).catch(() => null)

  const cm = cmResult?.find((r) => r.time.slice(0, 10) === dstr) ?? null
  const bd = bdResult?.find((r) => r.d.slice(0, 10) === dstr) ?? null

  if (!cm && !bd) return { status: 'failed', date: dstr }

  const row = computeSnapshotRow(fetchDate, cm, bd)
  await prisma.btcDormantSnapshot.upsert({
    where: { date: fetchDate },
    create: {
      date: row.date,
      dormant1yRatio: row.dormant1yRatio,
      dormant2yRatio: row.dormant2yRatio,
      dormant3yRatio: row.dormant3yRatio,
      btcPriceUsd: row.btcPriceUsd,
      rawCoinmetrics: row.rawCoinmetrics as any,
      rawBitcoinData: row.rawBitcoinData as any,
      reconcileWarning: row.reconcileWarning,
      dataSource: row.dataSource,
    },
    update: {
      dormant1yRatio: row.dormant1yRatio,
      dormant2yRatio: row.dormant2yRatio,
      dormant3yRatio: row.dormant3yRatio,
      btcPriceUsd: row.btcPriceUsd,
      rawCoinmetrics: row.rawCoinmetrics as any,
      rawBitcoinData: row.rawBitcoinData as any,
      reconcileWarning: row.reconcileWarning,
      dataSource: row.dataSource,
    },
  })
  return { status: 'ok', date: dstr, dataSource: row.dataSource }
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
npx jest src/services/__tests__/market-regime.service.test.ts
```
Expected: 모두 PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/services/market-regime.service.ts src/services/__tests__/market-regime.service.test.ts
git commit -m "feat: 일별 폴링 함수 (upsert) 추가"
```

---

### Task 10: scheduler 모듈 (node-cron)

**Files:**
- Create: `src/services/market-regime-scheduler.service.ts`

- [ ] **Step 1: node-cron 의존성 확인**

```bash
node -e "console.log(require('node-cron'))" 2>&1 | head -5
```
없으면:
```bash
npm install node-cron
npm install -D @types/node-cron
```

- [ ] **Step 2: scheduler 모듈 작성**

`src/services/market-regime-scheduler.service.ts`:
```typescript
import cron from 'node-cron'
import { MARKET_REGIME_CONFIG } from '../config/market-regime'
import { runBackfill, runDailyPoll } from './market-regime.service'

let task: cron.ScheduledTask | null = null

export async function startMarketRegimeScheduler(): Promise<void> {
  // 부팅 시 백필 (비동기, 서버 시작 차단하지 않음)
  runBackfill()
    .then((r) => console.log('[market-regime] backfill', r))
    .catch((e) => console.error('[market-regime] backfill failed', e))

  if (task) return
  task = cron.schedule(MARKET_REGIME_CONFIG.cron, async () => {
    try {
      const r = await runDailyPoll()
      console.log('[market-regime] daily poll', r)
    } catch (e) {
      console.error('[market-regime] daily poll error', e)
    }
  }, { timezone: 'UTC' })
}

export function stopMarketRegimeScheduler(): void {
  if (task) { task.stop(); task = null }
}
```

- [ ] **Step 3: 타입 체크**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 4: 커밋**

```bash
git add src/services/market-regime-scheduler.service.ts package.json package-lock.json
git commit -m "feat: market regime 스케줄러 모듈 추가"
```

---

### Task 11: controller — current 엔드포인트

**Files:**
- Create: `src/controllers/market-regime.controller.ts`

- [ ] **Step 1: controller 파일 생성**

`src/controllers/market-regime.controller.ts`:
```typescript
import type { Request, Response, NextFunction } from 'express'
import prisma from '../config/database'
import {
  classifyRegime,
  REGIME_THRESHOLDS,
  type Series,
} from '../config/market-regime'

const SERIES_KEYS: Series[] = ['1y', '2y', '3y']

export async function getCurrent(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const latest = await prisma.btcDormantSnapshot.findFirst({
      orderBy: { date: 'desc' },
    })

    if (!latest) {
      const total = await prisma.btcDormantSnapshot.count()
      res.json({
        status: 'backfilling',
        progress: total,
        message: '데이터 백필 진행 중입니다',
      })
      return
    }

    const ratios = {
      '1y': Number(latest.dormant1yRatio),
      '2y': Number(latest.dormant2yRatio),
      '3y': Number(latest.dormant3yRatio),
    }
    const regimes = Object.fromEntries(
      SERIES_KEYS.map((s) => [s, classifyRegime(ratios[s], s)]),
    ) as Record<Series, ReturnType<typeof classifyRegime>>

    const ageDays = (Date.now() - latest.date.getTime()) / 86_400_000
    res.json({
      date: latest.date.toISOString().slice(0, 10),
      ratios,
      regimes,
      btcPriceUsd: Number(latest.btcPriceUsd),
      thresholds: REGIME_THRESHOLDS,
      lastFetched: latest.updatedAt.toISOString(),
      warnings: {
        reconcileWarning: latest.reconcileWarning,
        dataSource: latest.dataSource,
        stale: ageDays > 7,
      },
    })
  } catch (e) {
    next(e)
  }
}
```

- [ ] **Step 2: 타입 체크**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 3: 커밋**

```bash
git add src/controllers/market-regime.controller.ts
git commit -m "feat: market regime current 엔드포인트 controller 추가"
```

---

### Task 12: controller — timeseries 엔드포인트

**Files:**
- Modify: `src/controllers/market-regime.controller.ts`

- [ ] **Step 1: timeseries 핸들러 추가**

`src/controllers/market-regime.controller.ts`에 추가:
```typescript
const RANGE_YEARS = { '1y': 1, '3y': 3, '5y': 5, '10y': 10 } as const

export async function getTimeseries(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const rangeParam = (req.query.range as string) ?? '5y'
    const years = (RANGE_YEARS as Record<string, number>)[rangeParam]
    if (!years) {
      res.status(400).json({ error: 'invalid range (use 1y|3y|5y|10y)' })
      return
    }

    const start = new Date()
    start.setUTCFullYear(start.getUTCFullYear() - years)

    const rows = await prisma.btcDormantSnapshot.findMany({
      where: { date: { gte: start } },
      orderBy: { date: 'asc' },
      select: {
        date: true,
        dormant1yRatio: true,
        dormant2yRatio: true,
        dormant3yRatio: true,
        btcPriceUsd: true,
      },
    })

    res.json(
      rows.map((r) => ({
        date: r.date.toISOString().slice(0, 10),
        dormant1y: Number(r.dormant1yRatio),
        dormant2y: Number(r.dormant2yRatio),
        dormant3y: Number(r.dormant3yRatio),
        btcPriceUsd: Number(r.btcPriceUsd),
      })),
    )
  } catch (e) {
    next(e)
  }
}
```

- [ ] **Step 2: 타입 체크**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 3: 커밋**

```bash
git add src/controllers/market-regime.controller.ts
git commit -m "feat: market regime timeseries 엔드포인트 추가"
```

---

### Task 13: 라우트 등록 + 앱 마운트 + 부팅 시 스케줄러 시작

**Files:**
- Create: `src/routes/market-regime.routes.ts`
- Modify: `src/app.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: 라우트 파일 생성**

`src/routes/market-regime.routes.ts`:
```typescript
import { Router } from 'express'
import { authMiddleware } from '../middlewares/auth'
import { getCurrent, getTimeseries } from '../controllers/market-regime.controller'

const router = Router()

router.get('/btc/current', authMiddleware, getCurrent)
router.get('/btc/timeseries', authMiddleware, getTimeseries)

export default router
```

(`authMiddleware`의 정확한 export 이름은 `src/middlewares/auth.ts` 확인 후 일치시킬 것. 다른 라우트에서 사용 중인 import 그대로 따라 쓰기.)

- [ ] **Step 2: app.ts에 마운트**

`src/app.ts`에서 다른 라우트 마운트가 있는 위치 근처에 추가:
```typescript
import marketRegimeRoutes from './routes/market-regime.routes'
// ...
app.use('/api/market-regime', marketRegimeRoutes)
```

- [ ] **Step 3: index.ts에서 스케줄러 시작**

`src/index.ts`의 서버 listen 직후에 추가:
```typescript
import { startMarketRegimeScheduler } from './services/market-regime-scheduler.service'
// ... server.listen(...) 직후
startMarketRegimeScheduler().catch((e) => console.error('scheduler start failed', e))
```

- [ ] **Step 4: 타입 체크 + 빌드**

```bash
npx tsc --noEmit
npm run build
```
Expected: 둘 다 0 errors.

- [ ] **Step 5: 로컬 서버 시작 시 정상 부팅 확인**

```bash
npm run dev
```
Expected: 콘솔에 `[market-regime] backfill ...` 로그가 보이고 서버는 정상 listen.

확인 후 Ctrl+C로 종료.

- [ ] **Step 6: 커밋**

```bash
git add src/routes/market-regime.routes.ts src/app.ts src/index.ts
git commit -m "feat: market regime 라우트 등록 및 스케줄러 부팅 연결"
```

---

### Task 14: 실제 외부 API 응답 schema 검증 (통합 테스트)

**Files:**
- Create: `src/services/__tests__/market-regime.integration.test.ts`

bitcoin-data.com의 실제 응답 키와 schemas.ts의 `BD_LONG_TERM_BUCKETS`가 일치하는지 1회 검증한다.

- [ ] **Step 1: 통합 테스트 작성**

`src/services/__tests__/market-regime.integration.test.ts`:
```typescript
import { fetchFromCoinMetrics, fetchFromBitcoinData } from '../market-regime.service'
import { BD_LONG_TERM_BUCKETS } from '../market-regime.schemas'

// 실제 외부 API 호출 — CI에서도 실행 (무료, 부담 없음)
describe('market-regime integration', () => {
  jest.setTimeout(30_000)

  it('CoinMetrics: BTC 어제 데이터 fetch', async () => {
    const end = new Date()
    end.setUTCDate(end.getUTCDate() - 1)
    const rows = await fetchFromCoinMetrics(end, end)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].SplyCur).toBeGreaterThan(19_000_000)
  })

  it('bitcoin-data: hodl waves 응답에 long-term buckets 키가 모두 존재', async () => {
    const rows = await fetchFromBitcoinData()
    expect(rows.length).toBeGreaterThan(0)
    const latest = rows[rows.length - 1]
    for (const key of BD_LONG_TERM_BUCKETS) {
      expect(latest).toHaveProperty(key)
    }
  })
})
```

- [ ] **Step 2: 통합 테스트 실행**

```bash
npx jest src/services/__tests__/market-regime.integration.test.ts
```
Expected: 2 tests PASS.

**실패 시 대응**: bitcoin-data.com 실제 키 이름이 다르면 (`1y` → `1Y`, `2y` → `1y_2y` 등) `market-regime.schemas.ts`의 `BD_LONG_TERM_BUCKETS`와 `computeSnapshotRow`의 키를 실제 값으로 수정한 뒤 다시 실행.

- [ ] **Step 3: 커밋**

```bash
git add src/services/__tests__/market-regime.integration.test.ts
git commit -m "test: market regime 외부 API 통합 테스트 추가"
```

---

### Task 15: 백엔드 PR #A 준비 (push + PR 생성)

**Files:** 없음. git/gh 명령만.

- [ ] **Step 1: 전체 테스트 통과 확인**

```bash
npx jest src/services/__tests__/market-regime
```
Expected: 모든 테스트 PASS.

- [ ] **Step 2: 빌드 확인**

```bash
npm run build
```
Expected: 0 errors.

- [ ] **Step 3: feature 브랜치 push (사용자 확인 후 실행)**

현재 브랜치명 확인:
```bash
git branch --show-current
```

main이면 신규 브랜치 생성:
```bash
git checkout -b feat/btc-lth-regime-backend
```

- [ ] **Step 4: 사용자에게 push 승인 요청**

> "백엔드 PR #A 준비 완료. 브랜치 `feat/btc-lth-regime-backend`를 origin에 push해도 될까요?"

승인 후:
```bash
git push -u origin feat/btc-lth-regime-backend
```

- [ ] **Step 5: PR 생성**

```bash
gh pr create --title "feat: BTC LTH regime PoC 백엔드 (PR #A)" --body "$(cat <<'EOF'
## Summary
- BTC 장기 보유자(1y/2y/3y 미이동) 비율을 일별 수집·저장
- CoinMetrics Community(메인) + bitcoin-data.com(폴백) 이중 소스
- 매일 UTC 01:00 폴링, 첫 가동 시 10년 백필
- 새 엔드포인트: `GET /api/market-regime/btc/current`, `GET /api/market-regime/btc/timeseries?range=1y|3y|5y|10y`

## Spec
- `docs/superpowers/specs/2026-06-18-btc-lth-regime-design.md`

## Plan
- `docs/superpowers/plans/2026-06-18-btc-lth-regime.md`

## Test plan
- [ ] 로컬 `npm run dev` 정상 부팅 + 백필 로그 확인
- [ ] `/api/market-regime/btc/current` 200 응답 (백필 진행 중이면 `status: backfilling`)
- [ ] 백필 완료 후 `/api/market-regime/btc/timeseries?range=10y` row 수 ~3650 확인
- [ ] `npx jest src/services/__tests__/market-regime` 전체 PASS
- [ ] 통합 테스트 외부 API 응답 schema 검증 PASS

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: GitHub Actions 결과 확인**

```bash
gh run list --limit 1
```
정상 완료까지 대기.

---

# Phase 2 — 프론트엔드 (PR #B)

작업 디렉터리는 모두 `v0-grid-transaction-frontend/`. **Phase 1 (PR #A)이 머지·배포된 뒤 시작 권장** (실데이터로 차트 작업이 빠름).

---

### Task 16: lib/api.ts에 타입과 함수 추가

**Files:**
- Modify: `lib/api.ts`

- [ ] **Step 1: 기존 패턴 확인**

```bash
grep -n "fetchAuth\|API_BASE" lib/api.ts | head -10
```
기존 fetch wrapper 함수명·base URL 패턴 파악.

- [ ] **Step 2: 타입과 함수 추가**

`lib/api.ts` 끝에 추가 (기존 wrapper 함수명에 맞춰 `fetchAuth` 등 변경):
```typescript
export type Regime = 'BOTTOM' | 'NEUTRAL' | 'TOP'
export type RegimeSeries = '1y' | '2y' | '3y'

export interface BtcRegimeCurrent {
  date: string
  ratios: Record<RegimeSeries, number>
  regimes: Record<RegimeSeries, Regime>
  btcPriceUsd: number
  thresholds: Record<RegimeSeries, { bottom: number; top: number }>
  lastFetched: string
  warnings: { reconcileWarning: boolean; dataSource: string; stale: boolean }
}

export interface BtcRegimeBackfilling {
  status: 'backfilling'
  progress: number
  message: string
}

export interface BtcRegimeTimeseriesPoint {
  date: string
  dormant1y: number
  dormant2y: number
  dormant3y: number
  btcPriceUsd: number
}

export type BtcRegimeRange = '1y' | '3y' | '5y' | '10y'

export async function getBtcRegimeCurrent(): Promise<BtcRegimeCurrent | BtcRegimeBackfilling> {
  return fetchAuth('/api/market-regime/btc/current')
}

export async function getBtcRegimeTimeseries(
  range: BtcRegimeRange,
): Promise<BtcRegimeTimeseriesPoint[]> {
  return fetchAuth(`/api/market-regime/btc/timeseries?range=${range}`)
}
```

- [ ] **Step 3: 타입 체크**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 4: 커밋**

```bash
git add lib/api.ts
git commit -m "feat: BTC regime API 클라이언트 함수 추가"
```

---

### Task 17: regime-badge.tsx

**Files:**
- Create: `components/market-regime/regime-badge.tsx`

- [ ] **Step 1: 컴포넌트 작성**

`components/market-regime/regime-badge.tsx`:
```tsx
import { Badge } from '@/components/ui/badge'
import type { Regime } from '@/lib/api'

const STYLES: Record<Regime, string> = {
  BOTTOM: 'bg-green-100 text-green-800 border-green-200',
  NEUTRAL: 'bg-gray-100 text-gray-800 border-gray-200',
  TOP: 'bg-red-100 text-red-800 border-red-200',
}

const LABELS: Record<Regime, string> = {
  BOTTOM: '바닥권',
  NEUTRAL: '중립',
  TOP: '고점권',
}

export function RegimeBadge({ regime }: { regime: Regime }) {
  return (
    <Badge variant="outline" className={STYLES[regime]}>
      {LABELS[regime]}
    </Badge>
  )
}
```

- [ ] **Step 2: 타입 체크**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 3: 커밋**

```bash
git add components/market-regime/regime-badge.tsx
git commit -m "feat: RegimeBadge 컴포넌트 추가"
```

---

### Task 18: btc-dormant-chart.tsx

**Files:**
- Create: `components/market-regime/btc-dormant-chart.tsx`

- [ ] **Step 1: 차트 컴포넌트 작성**

`components/market-regime/btc-dormant-chart.tsx`:
```tsx
'use client'

import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts'
import type { BtcRegimeTimeseriesPoint } from '@/lib/api'

interface Props {
  data: BtcRegimeTimeseriesPoint[]
  showCutoffs: boolean
  thresholds: { '2y': { bottom: number; top: number } }
}

export function BtcDormantChart({ data, showCutoffs, thresholds }: Props) {
  return (
    <ResponsiveContainer width="100%" height={400}>
      <ComposedChart data={data} margin={{ top: 10, right: 10, bottom: 10, left: 10 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="date" tick={{ fontSize: 12 }} />
        <YAxis
          yAxisId="left"
          domain={[0, 1]}
          tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
          tick={{ fontSize: 12 }}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          scale="log"
          domain={['auto', 'auto']}
          tickFormatter={(v) => `$${Number(v).toLocaleString()}`}
          tick={{ fontSize: 12 }}
        />
        <Tooltip
          formatter={(value: number, name: string) =>
            name === 'btcPriceUsd' ? `$${value.toLocaleString()}` : `${(value * 100).toFixed(2)}%`
          }
        />
        <Legend />
        <Line yAxisId="left" type="monotone" dataKey="dormant1y" stroke="#a78bfa" dot={false} name="1y dormant" />
        <Line yAxisId="left" type="monotone" dataKey="dormant2y" stroke="#6d28d9" strokeWidth={2} dot={false} name="2y dormant" />
        <Line yAxisId="left" type="monotone" dataKey="dormant3y" stroke="#312e81" dot={false} name="3y dormant" />
        <Line yAxisId="right" type="monotone" dataKey="btcPriceUsd" stroke="#9ca3af" strokeDasharray="4 4" dot={false} name="BTC price" />
        {showCutoffs && (
          <>
            <ReferenceLine yAxisId="left" y={thresholds['2y'].bottom} stroke="#16a34a" strokeDasharray="5 5" label="BOTTOM" />
            <ReferenceLine yAxisId="left" y={thresholds['2y'].top} stroke="#dc2626" strokeDasharray="5 5" label="TOP" />
          </>
        )}
      </ComposedChart>
    </ResponsiveContainer>
  )
}
```

- [ ] **Step 2: 타입 체크**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 3: 커밋**

```bash
git add components/market-regime/btc-dormant-chart.tsx
git commit -m "feat: BtcDormantChart 컴포넌트 추가"
```

---

### Task 19: btc-regime-section.tsx (wrapper)

**Files:**
- Create: `components/market-regime/btc-regime-section.tsx`

- [ ] **Step 1: 섹션 컴포넌트 작성**

`components/market-regime/btc-regime-section.tsx`:
```tsx
'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  getBtcRegimeCurrent,
  getBtcRegimeTimeseries,
  type BtcRegimeCurrent,
  type BtcRegimeBackfilling,
  type BtcRegimeTimeseriesPoint,
  type BtcRegimeRange,
} from '@/lib/api'
import { BtcDormantChart } from './btc-dormant-chart'
import { RegimeBadge } from './regime-badge'

export function BtcRegimeSection() {
  const [current, setCurrent] = useState<BtcRegimeCurrent | BtcRegimeBackfilling | null>(null)
  const [series, setSeries] = useState<BtcRegimeTimeseriesPoint[]>([])
  const [range, setRange] = useState<BtcRegimeRange>('5y')
  const [showCutoffs, setShowCutoffs] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    Promise.all([getBtcRegimeCurrent(), getBtcRegimeTimeseries(range)])
      .then(([c, s]) => {
        if (!alive) return
        setCurrent(c)
        setSeries(s)
        setError(null)
      })
      .catch((e) => alive && setError(String(e)))
      .finally(() => alive && setLoading(false))
    return () => { alive = false }
  }, [range])

  if (loading) return <Card><CardContent className="p-6">불러오는 중...</CardContent></Card>
  if (error) return <Alert><AlertDescription>에러: {error}</AlertDescription></Alert>
  if (!current) return null

  if ('status' in current && current.status === 'backfilling') {
    return (
      <Card>
        <CardHeader><CardTitle>BTC 장기 보유자 Regime</CardTitle></CardHeader>
        <CardContent>
          <p>데이터 백필 진행 중입니다 (현재 {current.progress}건)</p>
        </CardContent>
      </Card>
    )
  }

  const c = current as BtcRegimeCurrent
  return (
    <Card>
      <CardHeader>
        <CardTitle>BTC 장기 보유자 Regime</CardTitle>
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <span>2년+ 미이동: {(c.ratios['2y'] * 100).toFixed(2)}%</span>
          <RegimeBadge regime={c.regimes['2y']} />
          <span>·</span>
          <span>{c.date} 기준</span>
          {c.warnings.reconcileWarning && (
            <Alert className="mt-2 text-xs">
              <AlertDescription>⚠ 두 소스 값 차이 5%p 이상</AlertDescription>
            </Alert>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
          <ToggleGroup type="single" value={range} onValueChange={(v) => v && setRange(v as BtcRegimeRange)}>
            <ToggleGroupItem value="1y">1Y</ToggleGroupItem>
            <ToggleGroupItem value="3y">3Y</ToggleGroupItem>
            <ToggleGroupItem value="5y">5Y</ToggleGroupItem>
            <ToggleGroupItem value="10y">10Y</ToggleGroupItem>
          </ToggleGroup>
          <div className="flex items-center gap-2">
            <Switch id="cutoffs" checked={showCutoffs} onCheckedChange={setShowCutoffs} />
            <Label htmlFor="cutoffs">컷오프 표시</Label>
          </div>
        </div>
        <BtcDormantChart data={series} showCutoffs={showCutoffs} thresholds={c.thresholds} />
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 2: 타입 체크**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 3: 커밋**

```bash
git add components/market-regime/btc-regime-section.tsx
git commit -m "feat: BtcRegimeSection wrapper 컴포넌트 추가"
```

---

### Task 20: /whale 페이지에 섹션 삽입

**Files:**
- Modify: `app/whale/page.tsx`

- [ ] **Step 1: 페이지 상단 구조 확인**

```bash
head -50 app/whale/page.tsx
```

- [ ] **Step 2: 섹션 import 및 배치**

`app/whale/page.tsx` 상단 import에 추가:
```tsx
import { BtcRegimeSection } from '@/components/market-regime/btc-regime-section'
```

JSX 최상단 (페이지 제목 직후, 기존 whale 콘텐츠 직전)에 추가:
```tsx
<div className="mb-6">
  <BtcRegimeSection />
</div>
```

- [ ] **Step 3: 타입 체크**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 4: 커밋**

```bash
git add app/whale/page.tsx
git commit -m "feat: /whale 페이지에 BTC regime 섹션 삽입"
```

---

### Task 21: 컴포넌트 단위 테스트 (Vitest + RTL)

**Files:**
- Create: `components/market-regime/__tests__/regime-badge.test.tsx`
- Create: `components/market-regime/__tests__/btc-regime-section.test.tsx`

- [ ] **Step 1: regime-badge 테스트**

`components/market-regime/__tests__/regime-badge.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { RegimeBadge } from '../regime-badge'

describe('RegimeBadge', () => {
  it('BOTTOM 라벨 표시', () => {
    render(<RegimeBadge regime="BOTTOM" />)
    expect(screen.getByText('바닥권')).toBeInTheDocument()
  })
  it('TOP 라벨 표시', () => {
    render(<RegimeBadge regime="TOP" />)
    expect(screen.getByText('고점권')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: section 테스트 (API mock)**

`components/market-regime/__tests__/btc-regime-section.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BtcRegimeSection } from '../btc-regime-section'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

describe('BtcRegimeSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('백필 중 상태 표시', async () => {
    vi.mocked(api.getBtcRegimeCurrent).mockResolvedValue({
      status: 'backfilling', progress: 532, message: 'x',
    } as any)
    vi.mocked(api.getBtcRegimeTimeseries).mockResolvedValue([])
    render(<BtcRegimeSection />)
    await waitFor(() => {
      expect(screen.getByText(/백필 진행 중/)).toBeInTheDocument()
    })
  })

  it('정상 데이터 렌더링', async () => {
    vi.mocked(api.getBtcRegimeCurrent).mockResolvedValue({
      date: '2026-06-17',
      ratios: { '1y': 0.6754, '2y': 0.6234, '3y': 0.5612 },
      regimes: { '1y': 'NEUTRAL', '2y': 'NEUTRAL', '3y': 'NEUTRAL' },
      btcPriceUsd: 91234.56,
      thresholds: {
        '1y': { bottom: 0.7, top: 0.6 },
        '2y': { bottom: 0.65, top: 0.55 },
        '3y': { bottom: 0.6, top: 0.5 },
      },
      lastFetched: '2026-06-18T01:00:23Z',
      warnings: { reconcileWarning: false, dataSource: 'BOTH', stale: false },
    })
    vi.mocked(api.getBtcRegimeTimeseries).mockResolvedValue([
      { date: '2026-06-17', dormant1y: 0.67, dormant2y: 0.62, dormant3y: 0.56, btcPriceUsd: 91234 },
    ])
    render(<BtcRegimeSection />)
    await waitFor(() => {
      expect(screen.getByText('중립')).toBeInTheDocument()
      expect(screen.getByText(/62\.34%/)).toBeInTheDocument()
    })
  })
})
```

- [ ] **Step 3: 테스트 실행**

```bash
npm run test -- market-regime
```
Expected: 모든 테스트 PASS.

- [ ] **Step 4: 커밋**

```bash
git add components/market-regime/__tests__/
git commit -m "test: market regime 컴포넌트 단위 테스트 추가"
```

---

### Task 22: 빌드 + 로컬 확인

**Files:** 없음.

- [ ] **Step 1: 빌드 성공 확인**

```bash
npm run build
```
Expected: 0 errors.

- [ ] **Step 2: 로컬 dev 서버 + 브라우저 확인**

```bash
npm run dev
```

브라우저에서 `/whale` 접속 → 상단에 "BTC 장기 보유자 Regime" 카드 표시 확인:
- 카드 헤더에 ratio % + regime 배지
- 차트 라인 3개 + BTC 가격 점선
- Range 토글 동작 (1Y/3Y/5Y/10Y)
- 컷오프 표시 토글 동작 (해제 시 가로선 사라짐)
- 모바일 크기에서도 깨지지 않음

문제 발견 시 해당 파일 수정 + 추가 커밋.

---

### Task 23: 프론트엔드 PR #B 준비 (push + PR 생성)

**Files:** 없음.

- [ ] **Step 1: feature 브랜치 push (사용자 확인 후)**

```bash
git checkout -b feat/btc-lth-regime-frontend
```

- [ ] **Step 2: 사용자 승인 요청**

> "프론트엔드 PR #B 준비 완료. 브랜치 `feat/btc-lth-regime-frontend`를 origin에 push해도 될까요?"

승인 후:
```bash
git push -u origin feat/btc-lth-regime-frontend
```

- [ ] **Step 3: PR 생성**

```bash
gh pr create --title "feat: BTC LTH regime PoC 프론트 (PR #B)" --body "$(cat <<'EOF'
## Summary
- /whale 페이지 상단에 "BTC 장기 보유자 Regime" 섹션 추가
- 1y/2y/3y 미이동 ratio 라인 + BTC 가격 점선 ComposedChart
- Range 토글 (1Y/3Y/5Y/10Y), 컷오프 표시 토글
- Regime 배지 (바닥권/중립/고점권)

## Backend dependency
- 백엔드 PR #A가 머지·배포된 뒤 정상 동작 (백필 진행 중에는 안내 메시지)

## Spec / Plan
- 백엔드 repo: `docs/superpowers/specs/2026-06-18-btc-lth-regime-design.md`
- 백엔드 repo: `docs/superpowers/plans/2026-06-18-btc-lth-regime.md`

## Test plan
- [ ] 로컬 `npm run dev` → /whale 페이지 카드 정상 렌더
- [ ] Range 토글 1Y/3Y/5Y/10Y 각각 동작
- [ ] 컷오프 표시 토글 ON/OFF 동작
- [ ] 모바일 크기에서 레이아웃 OK
- [ ] `npm run test -- market-regime` 전체 PASS
- [ ] 백필 중 상태에서 안내 메시지 표시

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Vercel preview URL 확인**

PR 코멘트에 Vercel preview 링크가 올라오면 모바일/데스크탑에서 한 번 더 확인.

---

# 완료 기준

- 두 PR 모두 머지·배포 완료
- 백엔드: `/api/market-regime/btc/current` 200 + `regimes.2y` 값 정상
- 프론트: `/whale` 페이지 상단에 차트가 정상 렌더, range/cutoff 토글 동작
- 백필이 완료된 후 timeseries `range=10y` row 수 약 3,650건
- 첫 일주일 cron 폴링 매일 정상 (PR #C에서 health 카드로 가시화 예정)

---

# 부록 — Self-Review 체크리스트

| 항목 | 결과 |
|------|------|
| Spec 모든 섹션이 task에 매핑됨 | ✓ (1~7 결정사항 모두 Task 1~23에 반영) |
| 백필 흐름 | Task 8 |
| 일별 폴링 흐름 | Task 9 |
| reconcile 로직 | Task 7 |
| regime 분류 (응답 시) | Task 11 |
| 두 엔드포인트 | Task 11, 12 |
| 백엔드 라우트 + 부팅 연결 | Task 13 |
| UI 섹션 + 컴포넌트 3개 | Task 17~20 |
| 환경 변수 | Task 1 |
| 테스트 (유닛 + 통합 + 프론트) | Task 3~9, 14, 21 |
| 검증 명령 (tsc, build, jest, vitest) | Task 마다 명시 |
| 두 phase 사이 의존성 (백엔드 머지 후 프론트) | 명시 |
| 사용자 승인 게이트 (push 전) | Task 15, 23에 명시 |

타입 이름 일치 확인:
- `Series` / `Regime` / `RegimeSeries` — 백엔드 `Series`, 프론트 `RegimeSeries`로 분리 (충돌 없음)
- `BtcRegimeCurrent` / `BtcRegimeBackfilling` — Task 16, 19, 21에서 일관
- `BD_LONG_TERM_BUCKETS` — Task 3 정의, Task 7·14에서 사용
- `runBackfill` / `runDailyPoll` — Task 8, 9 정의, Task 10에서 호출

Placeholder scan: TBD / TODO / "appropriate error handling" 등 없음.
