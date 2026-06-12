# 변동성 돌파 자동매매 봇 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 변동성 돌파(래리 윌리엄스, k=0.65) 전략을 업비트 KRW 시장에서 모의/실거래로 실행하는 봇과 관리자 전용 UI를 만든다.

**Architecture:** 기존 BaseAgent 아키텍처에 30초 주기 에이전트를 추가하고, 순수 함수 core(목표가·거래일·청산판단·백테스트)를 봇과 백테스트가 공유한다. API는 `/admin/volatility` (authenticate + requireAdmin), 프론트는 `app/admin/volatility/page.tsx` 관리자 전용 페이지.

**Tech Stack:** Express 5 + TypeScript + Prisma(MySQL) + jest(ts-jest, `__tests__/`) / Next.js 16 + shadcn/ui + sonner

**스펙:** `docs/superpowers/specs/2026-06-13-volatility-breakout-bot-design.md`

**스펙과 다른 점 (의도적):** 스펙 §6은 zod 검증을 언급하지만 백엔드에 zod가 설치돼 있지 않고, 기존 컨트롤러(stablecoin-admin)가 "zod 미사용 — 수동 검증" 패턴을 명시적으로 따른다. 새 패키지 설치 대신 동일한 수동 검증(AppError 400) 패턴을 사용한다.

**핵심 시간 변환:** KST 09:00 사이클 경계 == UTC 00:00. 따라서 `tradeDate` = UTC 날짜 문자열, 강제 청산 창(KST 08:55~09:00) = UTC 23:55~24:00.

**작업 디렉토리:** Task 1~9 = `v0-grid-tranasction-backend/`, Task 10~12 = `v0-grid-transaction-frontend/` (글로벌 규칙: 양쪽 수정은 별도 서브에이전트로 분리할 것. 백엔드 에이전트는 프론트 파일 수정 금지, 역도 같음)

---

### Task 1: Prisma 스키마 + 마이그레이션

**Files:**
- Modify: `prisma/schema.prisma` (파일 끝에 모델 2개 추가)

- [ ] **Step 1: 스키마에 모델 추가**

`prisma/schema.prisma` 끝에 추가 (기존 모델들과 같은 @@map snake_case 컨벤션):

```prisma
// 변동성 돌파(래리 윌리엄스) 봇 — 사용자×코인당 1개
model VolatilityBreakoutBot {
  id           Int      @id @default(autoincrement())
  userId       Int      @map("user_id")
  market       String   // "KRW-BTC" 등
  buyAmountKrw Float    @map("buy_amount_krw") // 1회 매수금액
  k            Float    @default(0.65)
  stopLossPct  Float    @default(3) @map("stop_loss_pct")
  live         Boolean  @default(false) // false=모의, true=실거래
  enabled      Boolean  @default(false)
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")
  trades       VolatilityBreakoutTrade[]

  @@unique([userId, market])
  @@map("volatility_breakout_bots")
}

// 거래가 발생한 날만 row 생성. status=HOLDING row가 곧 포지션 (서버 재시작 복구용)
model VolatilityBreakoutTrade {
  id          Int       @id @default(autoincrement())
  botId       Int       @map("bot_id")
  bot         VolatilityBreakoutBot @relation(fields: [botId], references: [id])
  tradeDate   String    @map("trade_date") // KST 거래일 "2026-06-13" (09:00 경계 = UTC 날짜)
  targetPrice Float     @map("target_price")
  entryPrice  Float     @map("entry_price")
  entryAt     DateTime  @map("entry_at")
  qty         Float
  exitPrice   Float?    @map("exit_price")
  exitAt      DateTime? @map("exit_at")
  exitReason  String?   @map("exit_reason") // "CLOSE" | "STOP"
  pnlKrw      Float?    @map("pnl_krw")
  pnlPct      Float?    @map("pnl_pct") // 수수료 차감 후
  isLive      Boolean   @map("is_live")
  status      String    // "HOLDING" | "CLOSED"

  @@index([botId, tradeDate])
  @@map("volatility_breakout_trades")
}
```

- [ ] **Step 2: 마이그레이션 생성 (--create-only, Prisma CLI garbage 버그 대비)**

Run: `npx prisma migrate dev --create-only --name add_volatility_breakout`

- [ ] **Step 3: migration.sql tail 검사 (박스 문자 혼입 확인)**

Run: `tail -5 prisma/migrations/*add_volatility_breakout/migration.sql`
Expected: 정상 SQL로 끝남 (`┌` `─` 등 박스 문자 없어야 함). 혼입 시 해당 라인 수동 삭제.

- [ ] **Step 4: 마이그레이션 적용 + 클라이언트 생성**

Run: `npx prisma migrate dev` 후 `npx prisma generate`
Expected: 마이그레이션 적용 성공, 클라이언트 생성. (주의: 로컬 .env의 DATABASE_URL이 dev DB인지 먼저 확인 — production이면 중단)

- [ ] **Step 5: 타입 체크 + 커밋**

Run: `npx tsc --noEmit`
Expected: 에러 0개

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: 변동성 돌파 봇 Prisma 모델 추가"
```

---

### Task 2: core 순수 함수 — 목표가·거래일·청산판단 (TDD)

**Files:**
- Create: `src/utils/volatility-breakout-core.ts`
- Test: `__tests__/utils/volatility-breakout-core.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`__tests__/utils/volatility-breakout-core.test.ts`:

```typescript
import {
  calcTargetPrice,
  getTradeDate,
  isForceCloseWindow,
  calcStopLossPrice,
  evaluateExit,
} from '../../src/utils/volatility-breakout-core';

describe('calcTargetPrice', () => {
  it('당일 시가 + 전일 변동폭 × k', () => {
    // 시가 100, 전일 고가 110/저가 90 → 변동폭 20, k=0.65 → 100 + 13 = 113
    expect(calcTargetPrice(100, 110, 90, 0.65)).toBeCloseTo(113);
  });

  it('k=0이면 시가 그대로', () => {
    expect(calcTargetPrice(100, 110, 90, 0)).toBe(100);
  });
});

describe('getTradeDate (KST 09:00 경계 = UTC 00:00)', () => {
  it('KST 08:59는 전일 거래일', () => {
    expect(getTradeDate(new Date('2026-06-13T08:59:00+09:00'))).toBe('2026-06-12');
  });

  it('KST 09:01은 당일 거래일', () => {
    expect(getTradeDate(new Date('2026-06-13T09:01:00+09:00'))).toBe('2026-06-13');
  });
});

describe('isForceCloseWindow (KST 08:55~09:00 = UTC 23:55~24:00)', () => {
  it('UTC 23:54 → false', () => {
    expect(isForceCloseWindow(new Date('2026-06-12T23:54:59Z'))).toBe(false);
  });
  it('UTC 23:55 → true', () => {
    expect(isForceCloseWindow(new Date('2026-06-12T23:55:00Z'))).toBe(true);
  });
  it('UTC 23:59 → true', () => {
    expect(isForceCloseWindow(new Date('2026-06-12T23:59:59Z'))).toBe(true);
  });
  it('UTC 00:00 → false (새 거래일)', () => {
    expect(isForceCloseWindow(new Date('2026-06-13T00:00:00Z'))).toBe(false);
  });
});

describe('calcStopLossPrice', () => {
  it('진입가 × (1 - 손절%/100)', () => {
    expect(calcStopLossPrice(100000, 3)).toBeCloseTo(97000);
  });
});

describe('evaluateExit', () => {
  const base = {
    now: new Date('2026-06-13T05:00:00Z'), // 거래일 2026-06-13, 강제청산 창 아님
    entryPrice: 100000,
    stopLossPct: 3,
    entryTradeDate: '2026-06-13',
  };

  it('현재가가 손절선 이하면 STOP', () => {
    expect(evaluateExit({ ...base, currentPrice: 96999 })).toBe('STOP');
  });

  it('손절선 정확히 도달도 STOP', () => {
    expect(evaluateExit({ ...base, currentPrice: 97000 })).toBe('STOP');
  });

  it('강제 청산 창이면 CLOSE', () => {
    expect(
      evaluateExit({ ...base, now: new Date('2026-06-13T23:56:00Z'), currentPrice: 105000 }),
    ).toBe('CLOSE');
  });

  it('거래일이 바뀌었는데 HOLDING이면 CLOSE (서버 다운 청산 누락)', () => {
    expect(
      evaluateExit({ ...base, now: new Date('2026-06-14T01:00:00Z'), currentPrice: 105000 }),
    ).toBe('CLOSE');
  });

  it('손절 조건이 강제 청산보다 우선', () => {
    expect(
      evaluateExit({ ...base, now: new Date('2026-06-13T23:56:00Z'), currentPrice: 90000 }),
    ).toBe('STOP');
  });

  it('아무 조건도 아니면 null (보유 유지)', () => {
    expect(evaluateExit({ ...base, currentPrice: 105000 })).toBeNull();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest __tests__/utils/volatility-breakout-core.test.ts`
Expected: FAIL — "Cannot find module '../../src/utils/volatility-breakout-core'"

- [ ] **Step 3: 구현**

`src/utils/volatility-breakout-core.ts`:

```typescript
/**
 * 변동성 돌파(래리 윌리엄스) 순수 함수 모음.
 * 봇 사이클과 백테스트가 공유한다. DB/네트워크 의존 없음 — 단위 테스트 대상.
 *
 * 시간 규칙: 하루 사이클 = KST 09:00 ~ 다음날 09:00 (업비트 일봉 갱신 시각).
 * KST 09:00 == UTC 00:00 이므로 거래일 = UTC 날짜 문자열.
 */

export type ExitReason = 'STOP' | 'CLOSE';

/** 매수 목표가 = 당일 시가 + (전일 고가 - 전일 저가) × k */
export function calcTargetPrice(
  todayOpen: number,
  prevHigh: number,
  prevLow: number,
  k: number,
): number {
  return todayOpen + (prevHigh - prevLow) * k;
}

/** KST 09:00 경계 기준 거래일 — UTC 날짜와 일치 */
export function getTradeDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** 강제 청산 창: KST 08:55~09:00 == UTC 23:55~24:00 */
export function isForceCloseWindow(now: Date): boolean {
  return now.getUTCHours() === 23 && now.getUTCMinutes() >= 55;
}

/** 손절선 = 진입가 × (1 - stopLossPct/100) */
export function calcStopLossPrice(entryPrice: number, stopLossPct: number): number {
  return entryPrice * (1 - stopLossPct / 100);
}

/**
 * HOLDING 포지션의 청산 판단.
 * STOP이 CLOSE보다 우선 (손절선 도달 시 즉시 매도).
 * 거래일 변경 감지 = 서버 다운으로 강제 청산을 놓친 경우 → 즉시 CLOSE.
 */
export function evaluateExit(params: {
  now: Date;
  currentPrice: number;
  entryPrice: number;
  stopLossPct: number;
  entryTradeDate: string;
}): ExitReason | null {
  const { now, currentPrice, entryPrice, stopLossPct, entryTradeDate } = params;
  if (currentPrice <= calcStopLossPrice(entryPrice, stopLossPct)) return 'STOP';
  if (isForceCloseWindow(now)) return 'CLOSE';
  if (getTradeDate(now) !== entryTradeDate) return 'CLOSE';
  return null;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest __tests__/utils/volatility-breakout-core.test.ts`
Expected: PASS (15개)

- [ ] **Step 5: 커밋**

```bash
git add src/utils/volatility-breakout-core.ts __tests__/utils/volatility-breakout-core.test.ts
git commit -m "feat: 변동성 돌파 core 순수 함수 (목표가/거래일/청산판단)"
```

---

### Task 3: core 백테스트 시뮬레이션 (TDD)

**Files:**
- Modify: `src/utils/volatility-breakout-core.ts` (파일 끝에 추가)
- Modify: `__tests__/utils/volatility-breakout-core.test.ts` (파일 끝에 추가)

- [ ] **Step 1: 실패하는 테스트 추가**

`__tests__/utils/volatility-breakout-core.test.ts` 끝에 추가. 별도 import 줄을 추가하지 말고 **파일 상단의 기존 import 목록에 `simulateBreakout`, `DailyCandle`을 합칠 것**:

```typescript
describe('simulateBreakout', () => {
  const opts = { k: 0.5, stopLossPct: 3, feeRoundTripPct: 0.1, startCapital: 1_000_000 };

  // 전일(인덱스 0)은 변동폭 산출용 — 거래는 인덱스 1부터
  const prevDay: DailyCandle = { date: '2026-01-01', open: 100, high: 110, low: 90, close: 105 };
  // 전일 변동폭 20, k=0.5 → 목표가 = 당일시가 100 + 10 = 110

  it('고가가 목표가 미달이면 진입 없음', () => {
    const r = simulateBreakout(
      [prevDay, { date: '2026-01-02', open: 100, high: 109, low: 95, close: 108 }],
      opts,
    );
    expect(r.n).toBe(0);
    expect(r.finalCapital).toBe(1_000_000);
  });

  it('돌파 시 목표가 체결 → 종가 청산, 수수료 차감', () => {
    const r = simulateBreakout(
      [prevDay, { date: '2026-01-02', open: 100, high: 120, low: 108, close: 115 }],
      opts,
    );
    expect(r.n).toBe(1);
    // (115/110 - 1)*100 - 0.1 = 4.4545... - 0.1
    expect(r.avgNetPct).toBeCloseTo((115 / 110 - 1) * 100 - 0.1, 5);
    expect(r.winRate).toBe(100);
  });

  it('저가가 손절선 이하면 손절 체결이 우선 (보수적 가정)', () => {
    // 손절선 = 110 × 0.97 = 106.7, 저가 99 ≤ 106.7 → STOP
    const r = simulateBreakout(
      [prevDay, { date: '2026-01-02', open: 100, high: 120, low: 99, close: 115 }],
      opts,
    );
    expect(r.n).toBe(1);
    expect(r.avgNetPct).toBeCloseTo(-3 - 0.1, 5); // -stopLossPct - 수수료
    expect(r.worstPct).toBeCloseTo(-3.1, 5);
  });

  it('복리 누적: 2거래 수익률이 곱으로 반영', () => {
    const day2: DailyCandle = { date: '2026-01-02', open: 100, high: 120, low: 108, close: 115 };
    // day2 변동폭 12 → day3 목표가 = 110 + 6 = 116
    const day3: DailyCandle = { date: '2026-01-03', open: 110, high: 130, low: 114, close: 120 };
    const r = simulateBreakout([prevDay, day2, day3], opts);
    expect(r.n).toBe(2);
    const pnl1 = (115 / 110 - 1) * 100 - 0.1;
    const pnl2 = (120 / 116 - 1) * 100 - 0.1;
    expect(r.finalCapital).toBeCloseTo(1_000_000 * (1 + pnl1 / 100) * (1 + pnl2 / 100), 2);
  });

  it('연도별 손익 집계', () => {
    const r = simulateBreakout(
      [prevDay, { date: '2026-01-02', open: 100, high: 120, low: 108, close: 115 }],
      opts,
    );
    expect(r.yearly).toEqual([{ year: 2026, pnlPct: expect.closeTo((115 / 110 - 1) * 100 - 0.1, 5) }]);
  });

  it('단순 보유 최종자본 = 첫 종가 대비 마지막 종가 배율', () => {
    const r = simulateBreakout(
      [prevDay, { date: '2026-01-02', open: 100, high: 109, low: 95, close: 210 }],
      opts,
    );
    expect(r.buyHoldFinal).toBeCloseTo(1_000_000 * (210 / 105), 2);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest __tests__/utils/volatility-breakout-core.test.ts`
Expected: FAIL — simulateBreakout is not exported

- [ ] **Step 3: 구현 추가**

`src/utils/volatility-breakout-core.ts` 끝에 추가:

```typescript
export interface DailyCandle {
  date: string; // "2026-06-13" (UTC)
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface BacktestOptions {
  k: number;
  stopLossPct: number;
  feeRoundTripPct: number; // 왕복 수수료 % (업비트 0.05×2 = 0.1)
  startCapital: number;
}

export interface BacktestResult {
  n: number;
  winRate: number;
  avgNetPct: number;
  finalCapital: number;
  maxDdPct: number;
  worstPct: number;
  yearly: Array<{ year: number; pnlPct: number }>;
  buyHoldFinal: number;
}

/**
 * 변동성 돌파 백테스트 (일봉, 롱 온리, 하루 1회, 복리).
 * - 진입: high ≥ 목표가 → 목표가 체결 가정
 * - 손절: low ≤ 손절선 → 손절가 체결 (보수적 — 종가 청산보다 먼저 가정)
 * - 그 외: 당일 종가 청산
 * 한계: 일봉 기반이라 장중 돌파→손절 순서는 근사치. 슬리피지 미반영.
 */
export function simulateBreakout(daily: DailyCandle[], opts: BacktestOptions): BacktestResult {
  let equity = opts.startCapital;
  let peak = equity;
  let maxDd = 0;
  let n = 0;
  let wins = 0;
  let sumNet = 0;
  let worst = 0;
  const yearlyMap = new Map<number, number>();

  for (let i = 1; i < daily.length; i++) {
    const today = daily[i];
    const prev = daily[i - 1];
    const target = calcTargetPrice(today.open, prev.high, prev.low, opts.k);
    if (today.high < target) continue;

    const stopPrice = calcStopLossPrice(target, opts.stopLossPct);
    const exitPrice = today.low <= stopPrice ? stopPrice : today.close;
    const pnlPct = (exitPrice / target - 1) * 100 - opts.feeRoundTripPct;

    n++;
    sumNet += pnlPct;
    if (pnlPct > 0) wins++;
    worst = n === 1 ? pnlPct : Math.min(worst, pnlPct);

    equity *= 1 + pnlPct / 100;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (1 - equity / peak) * 100);

    const year = Number(today.date.slice(0, 4));
    yearlyMap.set(year, (yearlyMap.get(year) ?? 0) + pnlPct);
  }

  const buyHoldFinal =
    daily.length >= 2
      ? opts.startCapital * (daily[daily.length - 1].close / daily[0].close)
      : opts.startCapital;

  return {
    n,
    winRate: n > 0 ? (wins / n) * 100 : 0,
    avgNetPct: n > 0 ? sumNet / n : 0,
    finalCapital: equity,
    maxDdPct: maxDd,
    worstPct: worst,
    yearly: [...yearlyMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([year, pnlPct]) => ({ year, pnlPct })),
    buyHoldFinal,
  };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest __tests__/utils/volatility-breakout-core.test.ts`
Expected: PASS (21개)

- [ ] **Step 5: 커밋**

```bash
git add src/utils/volatility-breakout-core.ts __tests__/utils/volatility-breakout-core.test.ts
git commit -m "feat: 변동성 돌파 백테스트 시뮬레이션 순수 함수"
```

---

### Task 4: UpbitService.sellMarket 추가

**Files:**
- Modify: `src/services/upbit.service.ts` (`sellLimit` 메서드 뒤, 약 L310)

- [ ] **Step 1: sellMarket 구현**

`sellLimit` 메서드(L283~309) 바로 뒤에 추가. 기존 `buyMarket`(L256)과 동일 패턴 — 차이는 side:'ask', ord_type:'market', volume 사용:

```typescript
  // 시장가 매도 주문
  // volume: 매도할 코인 수량
  async sellMarket(market: string, volume: number) {
    try {
      await throttleOrderApi();
      const params: OrderParams = {
        market,
        side: 'ask',
        ord_type: 'market',  // 시장가 매도는 'market' 타입 + volume 필수
        volume: volume.toString(),
      };

      const queryString = new URLSearchParams(params as any).toString();

      const response = await axiosInstance.post(
        `${UPBIT_API_URL}/orders`,
        params,
        {
          headers: this.getHeaders(queryString),
        }
      );

      return response.data;
    } catch (error: any) {
      throw new Error(`시장가 매도 주문 실패: ${error.response?.data?.error?.message || error.message}`);
    }
  }
```

- [ ] **Step 2: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 에러 0개 (OrderParams의 ord_type 유니온에 'market' 이미 포함 — L134 확인됨)

- [ ] **Step 3: 커밋**

```bash
git add src/services/upbit.service.ts
git commit -m "feat: 업비트 시장가 매도 주문(sellMarket) 추가"
```

---

### Task 5: 백테스트 서비스 (업비트 일봉 수집 + 실행)

**Files:**
- Create: `src/services/volatility-backtest.service.ts`

- [ ] **Step 1: 구현**

`src/services/volatility-backtest.service.ts`:

```typescript
import axios from 'axios';
import { AppError } from '../middlewares/errorHandler';
import {
  DailyCandle,
  BacktestResult,
  simulateBreakout,
} from '../utils/volatility-breakout-core';

const UPBIT_API_URL = 'https://api.upbit.com/v1';
const FEE_ROUND_TRIP_PCT = 0.1; // 업비트 0.05% × 2
const START_CAPITAL = 1_000_000; // ₩100만 시작 복리

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface UpbitDayCandle {
  candle_date_time_utc: string;
  opening_price: number;
  high_price: number;
  low_price: number;
  trade_price: number;
}

/**
 * 업비트 일봉 수집 (최신→과거 200개씩 페이지네이션 → 시간 오름차순 반환).
 * 8년 ≈ 2920개 = 15회 호출, 호출 간 150ms 대기 (public API rate limit).
 */
export async function fetchDailyCandles(market: string, days: number): Promise<DailyCandle[]> {
  const out: UpbitDayCandle[] = [];
  let to: string | undefined;

  while (out.length < days) {
    const count = Math.min(200, days - out.length);
    const res = await axios.get(`${UPBIT_API_URL}/candles/days`, {
      params: { market, count, ...(to ? { to } : {}) },
      timeout: 10_000,
    });
    const batch: UpbitDayCandle[] = res.data;
    if (!Array.isArray(batch) || batch.length === 0) break; // 상장 이전 — 데이터 끝
    out.push(...batch);
    to = batch[batch.length - 1].candle_date_time_utc;
    await sleep(150);
  }

  return out
    .reverse()
    .map((c) => ({
      date: c.candle_date_time_utc.slice(0, 10),
      open: c.opening_price,
      high: c.high_price,
      low: c.low_price,
      close: c.trade_price,
    }));
}

export async function runBacktest(params: {
  market: string;
  k: number;
  stopLossPct: number;
  years: number;
}): Promise<BacktestResult> {
  const days = params.years * 365 + 1; // 전일 변동폭 계산용 1일 여유
  const daily = await fetchDailyCandles(params.market, days);
  if (daily.length < 30) {
    throw new AppError(`캔들 데이터 부족: ${params.market} ${daily.length}일 (최소 30일)`, 400);
  }
  return simulateBreakout(daily, {
    k: params.k,
    stopLossPct: params.stopLossPct,
    feeRoundTripPct: FEE_ROUND_TRIP_PCT,
    startCapital: START_CAPITAL,
  });
}
```

- [ ] **Step 2: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 에러 0개. (참고: `AppError`가 `../middlewares/errorHandler`에 export돼 있는지 확인 — stablecoin-admin.controller.ts L5가 같은 경로로 import하므로 동일하게 사용)

- [ ] **Step 3: 실데이터 스모크 테스트 (1년 BTC)**

Run: `npx ts-node -e "import('./src/services/volatility-backtest.service').then(async (m) => { const r = await m.runBacktest({ market: 'KRW-BTC', k: 0.65, stopLossPct: 3, years: 1 }); console.log(JSON.stringify(r, null, 2)); })"`
Expected: n > 0, finalCapital 숫자, yearly 배열 출력 (3~5초 소요)

- [ ] **Step 4: 커밋**

```bash
git add src/services/volatility-backtest.service.ts
git commit -m "feat: 변동성 돌파 백테스트 서비스 (업비트 일봉 수집)"
```

---

### Task 6: 봇 서비스 (CRUD + 사이클 로직)

**Files:**
- Create: `src/services/volatility-breakout.service.ts`

- [ ] **Step 1: 구현**

`src/services/volatility-breakout.service.ts`:

```typescript
import axios from 'axios';
import prisma from '../config/database';
import { UpbitService } from './upbit.service';
import { decrypt } from '../utils/encryption';
import { kakaoNotifyService } from './kakao-notify.service';
import { AppError } from '../middlewares/errorHandler';
import {
  calcTargetPrice,
  getTradeDate,
  evaluateExit,
  ExitReason,
} from '../utils/volatility-breakout-core';

const FEE_PCT_PER_SIDE = 0.05; // 업비트 시장가 수수료 (편도)
const MIN_ORDER_KRW = 5000; // 업비트 최소 주문금액
const UPBIT_API_URL = 'https://api.upbit.com/v1';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ===== CRUD =====

export async function listBots(userId: number) {
  const bots = await prisma.volatilityBreakoutBot.findMany({
    where: { userId },
    orderBy: { id: 'asc' },
  });

  // 실시간 상태 enrich: 목표가, 현재가, 돌파까지 %, 포지션
  const tradeDate = getTradeDate(new Date());
  return Promise.all(
    bots.map(async (bot) => {
      let targetPrice: number | null = null;
      let currentPrice: number | null = null;
      try {
        const ref = await getDayRef(bot.market, tradeDate);
        targetPrice = calcTargetPrice(ref.todayOpen, ref.prevHigh, ref.prevLow, bot.k);
        const ticker = await UpbitService.getCurrentPrice(bot.market);
        currentPrice = ticker.trade_price;
      } catch {
        // 시세 조회 실패해도 봇 목록은 반환
      }
      const holding = await prisma.volatilityBreakoutTrade.findFirst({
        where: { botId: bot.id, status: 'HOLDING' },
      });
      const todayTrade = await prisma.volatilityBreakoutTrade.findFirst({
        where: { botId: bot.id, tradeDate },
        orderBy: { id: 'desc' },
      });
      return {
        ...bot,
        status: {
          tradeDate,
          targetPrice,
          currentPrice,
          breakoutDistancePct:
            targetPrice && currentPrice ? ((targetPrice - currentPrice) / currentPrice) * 100 : null,
          position: holding ? 'HOLDING' : todayTrade ? 'CLOSED_TODAY' : 'WAITING',
          holding: holding
            ? {
                entryPrice: holding.entryPrice,
                qty: holding.qty,
                entryAt: holding.entryAt,
                unrealizedPnlKrw: currentPrice
                  ? (currentPrice - holding.entryPrice) * holding.qty
                  : null,
              }
            : null,
        },
      };
    }),
  );
}

export async function createBot(params: {
  userId: number;
  market: string;
  buyAmountKrw: number;
  k?: number;
  stopLossPct?: number;
}) {
  const existing = await prisma.volatilityBreakoutBot.findFirst({
    where: { userId: params.userId, market: params.market },
  });
  if (existing) throw new AppError(`${params.market} 봇이 이미 존재합니다`, 400);

  return prisma.volatilityBreakoutBot.create({
    data: {
      userId: params.userId,
      market: params.market,
      buyAmountKrw: params.buyAmountKrw,
      ...(params.k !== undefined && { k: params.k }),
      ...(params.stopLossPct !== undefined && { stopLossPct: params.stopLossPct }),
    },
  });
}

export async function updateBot(
  userId: number,
  botId: number,
  patch: Partial<{
    buyAmountKrw: number;
    k: number;
    stopLossPct: number;
    live: boolean;
    enabled: boolean;
  }>,
) {
  const bot = await prisma.volatilityBreakoutBot.findFirst({ where: { id: botId, userId } });
  if (!bot) throw new AppError('봇을 찾을 수 없습니다', 404);
  return prisma.volatilityBreakoutBot.update({ where: { id: botId }, data: patch });
}

export async function deleteBot(userId: number, botId: number) {
  const bot = await prisma.volatilityBreakoutBot.findFirst({ where: { id: botId, userId } });
  if (!bot) throw new AppError('봇을 찾을 수 없습니다', 404);

  const holding = await prisma.volatilityBreakoutTrade.findFirst({
    where: { botId, status: 'HOLDING' },
  });
  if (holding) throw new AppError('HOLDING 포지션이 있어 삭제할 수 없습니다. 청산 후 삭제하세요', 400);

  await prisma.volatilityBreakoutTrade.deleteMany({ where: { botId } });
  await prisma.volatilityBreakoutBot.delete({ where: { id: botId } });
}

export async function listTrades(userId: number, botId: number, page: number, pageSize: number) {
  const bot = await prisma.volatilityBreakoutBot.findFirst({ where: { id: botId, userId } });
  if (!bot) throw new AppError('봇을 찾을 수 없습니다', 404);

  const [trades, total] = await Promise.all([
    prisma.volatilityBreakoutTrade.findMany({
      where: { botId },
      orderBy: { id: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.volatilityBreakoutTrade.count({ where: { botId } }),
  ]);
  return { trades, total, page, pageSize };
}

// ===== 사이클 로직 (에이전트가 30초마다 호출) =====

interface DayRef {
  todayOpen: number;
  prevHigh: number;
  prevLow: number;
}

// 거래일당 1회만 일봉 조회 (market:tradeDate 키)
const dayRefCache = new Map<string, DayRef>();
// 실거래 매수 주문 실패한 거래일 — 중복 주문 방지 우선, 해당일 재시도 안 함
const failedEntryDates = new Map<number, string>();

async function getDayRef(market: string, tradeDate: string): Promise<DayRef> {
  const key = `${market}:${tradeDate}`;
  const cached = dayRefCache.get(key);
  if (cached) return cached;

  const res = await axios.get(`${UPBIT_API_URL}/candles/days`, {
    params: { market, count: 2 },
    timeout: 10_000,
  });
  const [today, prev] = res.data; // 최신순: [0]=오늘, [1]=전일
  if (today.candle_date_time_utc.slice(0, 10) !== tradeDate) {
    // 09:00 직후 일봉 갱신 지연 — 다음 사이클에서 재시도
    throw new Error(`${market} 일봉 미갱신 (응답=${today.candle_date_time_utc}, 기대=${tradeDate})`);
  }
  const ref: DayRef = {
    todayOpen: today.opening_price,
    prevHigh: prev.high_price,
    prevLow: prev.low_price,
  };
  dayRefCache.set(key, ref);
  // 과거 거래일 캐시 정리 (메모리 누수 방지)
  if (dayRefCache.size > 100) {
    const oldest = dayRefCache.keys().next().value;
    if (oldest) dayRefCache.delete(oldest);
  }
  return ref;
}

async function getUpbitClientFor(userId: number): Promise<UpbitService> {
  const credential = await prisma.credential.findFirst({
    where: { userId, exchange: 'upbit' },
  });
  if (!credential) throw new Error(`userId=${userId} 업비트 인증정보 없음`);
  return new UpbitService({
    accessKey: decrypt(credential.apiKey),
    secretKey: decrypt(credential.secretKey),
  });
}

/** 주문 체결 확인 — 0.5초 간격 최대 10회 폴링 */
async function waitForFill(
  upbit: UpbitService,
  uuid: string,
): Promise<{ avgPrice: number; qty: number }> {
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    const order = await upbit.getOrder(uuid);
    const vol = parseFloat(order.executed_volume ?? '0');
    if ((order.state === 'done' || order.state === 'cancel') && vol > 0) {
      const funds = parseFloat((order as any).executed_funds ?? '0');
      if (funds > 0) return { avgPrice: funds / vol, qty: vol };
      // executed_funds 미제공 시 trades 합산 폴백
      const trades = (order as any).trades ?? [];
      const sumFunds = trades.reduce(
        (a: number, t: any) => a + parseFloat(t.funds ?? '0'),
        0,
      );
      if (sumFunds > 0) return { avgPrice: sumFunds / vol, qty: vol };
    }
  }
  throw new Error(`주문 체결 확인 실패 uuid=${uuid}`);
}

function notify(msg: string): void {
  kakaoNotifyService
    .sendToMe(msg)
    .catch((e: any) => console.error('[VolatilityBreakout] 카카오 알림 실패:', e.message));
}

export async function runCycle(): Promise<void> {
  const now = new Date();
  const tradeDate = getTradeDate(now);

  // 대상: enabled 봇 + (disabled여도 HOLDING 거래가 있는 봇 — 청산 감시 유지)
  const enabledBots = await prisma.volatilityBreakoutBot.findMany({ where: { enabled: true } });
  const holdingTrades = await prisma.volatilityBreakoutTrade.findMany({
    where: { status: 'HOLDING' },
  });
  const enabledIds = new Set(enabledBots.map((b) => b.id));
  const extraIds = holdingTrades.map((t) => t.botId).filter((id) => !enabledIds.has(id));
  const extraBots =
    extraIds.length > 0
      ? await prisma.volatilityBreakoutBot.findMany({ where: { id: { in: extraIds } } })
      : [];

  for (const bot of [...enabledBots, ...extraBots]) {
    try {
      const holding = holdingTrades.find((t) => t.botId === bot.id) ?? null;
      await runBotCycle(bot, holding, now, tradeDate);
    } catch (e: any) {
      // 개별 봇 에러는 다른 봇 사이클을 막지 않음 — 다음 사이클에서 조건 재평가
      console.error(`[VolatilityBreakout] bot=${bot.id} ${bot.market} 사이클 에러:`, e.message);
      throw e; // BaseAgent 메트릭 기록을 위해 재던짐 — 마지막 봇이 아니어도 기록되도록 아래 주의 참고
    }
  }
}
```

**주의 (구현 시 결정):** 위 for 루프에서 `throw e`를 하면 뒤 봇들이 실행되지 않는다. **`throw e` 줄을 삭제하고 console.error만 남길 것** — 개별 봇 에러 격리가 우선이고, 에이전트 차원 에러(전체 조회 실패 등)는 어차피 runCycle 바깥으로 전파돼 BaseAgent가 기록한다.

이어서 같은 파일에 추가:

```typescript
async function runBotCycle(
  bot: { id: number; userId: number; market: string; buyAmountKrw: number; k: number; stopLossPct: number; live: boolean; enabled: boolean },
  holding: { id: number; tradeDate: string; entryPrice: number; qty: number; isLive: boolean } | null,
  now: Date,
  tradeDate: string,
): Promise<void> {
  const ticker = await UpbitService.getCurrentPrice(bot.market);
  const currentPrice: number = ticker.trade_price;

  // 1) HOLDING 포지션: 청산 조건 평가 (disabled여도 수행)
  if (holding) {
    const reason = evaluateExit({
      now,
      currentPrice,
      entryPrice: holding.entryPrice,
      stopLossPct: bot.stopLossPct,
      entryTradeDate: holding.tradeDate,
    });
    if (reason) await exitPosition(bot, holding, currentPrice, reason);
    return; // 보유 중에는 신규 진입 없음
  }

  // 2) 신규 진입: enabled 봇만
  if (!bot.enabled) return;
  if (isNearCycleEnd(now)) return; // 강제청산 창 직전·내 신규 진입 금지
  if (failedEntryDates.get(bot.id) === tradeDate) return; // 주문 실패한 날 skip
  const existing = await prisma.volatilityBreakoutTrade.findFirst({
    where: { botId: bot.id, tradeDate },
  });
  if (existing) return; // 하루 최대 1회 진입

  const ref = await getDayRef(bot.market, tradeDate);
  const target = calcTargetPrice(ref.todayOpen, ref.prevHigh, ref.prevLow, bot.k);
  if (currentPrice < target) return; // 돌파 전 — 대기

  await enterPosition(bot, target, currentPrice, tradeDate);
}

/** KST 08:50 이후(UTC 23:50~)는 신규 진입 금지 — 진입 직후 강제청산 방지 */
function isNearCycleEnd(now: Date): boolean {
  return now.getUTCHours() === 23 && now.getUTCMinutes() >= 50;
}

async function enterPosition(
  bot: { id: number; userId: number; market: string; buyAmountKrw: number; live: boolean },
  targetPrice: number,
  currentPrice: number,
  tradeDate: string,
): Promise<void> {
  let entryPrice = currentPrice;
  let qty = bot.buyAmountKrw / currentPrice; // 모의: 현재가 가상 체결

  if (bot.live) {
    if (bot.buyAmountKrw < MIN_ORDER_KRW) {
      failedEntryDates.set(bot.id, tradeDate);
      notify(`[변동성돌파 ⚠️] ${bot.market} 매수금액 ${bot.buyAmountKrw} < 최소 5,000 KRW — 오늘 진입 skip`);
      return;
    }
    try {
      const upbit = await getUpbitClientFor(bot.userId);
      const order = await upbit.buyMarket(bot.market, bot.buyAmountKrw);
      const filled = await waitForFill(upbit, order.uuid);
      entryPrice = filled.avgPrice;
      qty = filled.qty;
    } catch (e: any) {
      // 매수 실패: 중복 주문 방지 우선 — 해당 거래일 재시도 안 함
      failedEntryDates.set(bot.id, tradeDate);
      console.error(`[VolatilityBreakout] bot=${bot.id} 매수 실패:`, e.message);
      notify(`[변동성돌파 ❌ 매수 실패] ${bot.market}\n${e.message}\n오늘(${tradeDate}) 진입 skip`);
      return;
    }
  }

  await prisma.volatilityBreakoutTrade.create({
    data: {
      botId: bot.id,
      tradeDate,
      targetPrice,
      entryPrice,
      entryAt: new Date(),
      qty,
      isLive: bot.live,
      status: 'HOLDING',
    },
  });

  notify(
    `[변동성돌파 🚀 진입${bot.live ? '' : ' (모의)'}] ${bot.market}\n` +
      `목표가 ${Math.round(targetPrice).toLocaleString()} 돌파\n` +
      `진입가 ${Math.round(entryPrice).toLocaleString()} / 수량 ${qty.toFixed(8)}`,
  );
}

async function exitPosition(
  bot: { id: number; userId: number; market: string },
  holding: { id: number; entryPrice: number; qty: number; isLive: boolean },
  currentPrice: number,
  reason: ExitReason,
): Promise<void> {
  let exitPrice = currentPrice; // 모의: 현재가 가상 체결
  let qty = holding.qty;

  if (holding.isLive) {
    try {
      const upbit = await getUpbitClientFor(bot.userId);
      const order = await upbit.sellMarket(bot.market, holding.qty);
      const filled = await waitForFill(upbit, order.uuid);
      exitPrice = filled.avgPrice;
      qty = filled.qty;
    } catch (e: any) {
      // 매도 실패는 재시도함 (포지션 방치가 더 위험) — 다음 사이클의 조건 재평가가 자연 재시도
      console.error(`[VolatilityBreakout] bot=${bot.id} 매도 실패(${reason}):`, e.message);
      notify(`[변동성돌파 ⚠️ 매도 실패] ${bot.market} (${reason})\n${e.message}\n다음 사이클 재시도`);
      return;
    }
  }

  // 수수료 차감 손익: 매수·매도 각 0.05% 가정 (모의/실거래 동일 공식 — 실거래 실측은 paid_fee 비교로 검증)
  const entryCostKrw = holding.entryPrice * holding.qty * (1 + FEE_PCT_PER_SIDE / 100);
  const exitNetKrw = exitPrice * qty * (1 - FEE_PCT_PER_SIDE / 100);
  const pnlKrw = exitNetKrw - entryCostKrw;
  const pnlPct = (pnlKrw / entryCostKrw) * 100;

  await prisma.volatilityBreakoutTrade.update({
    where: { id: holding.id },
    data: {
      exitPrice,
      exitAt: new Date(),
      exitReason: reason,
      pnlKrw,
      pnlPct,
      status: 'CLOSED',
    },
  });

  const emoji = reason === 'STOP' ? '🛑 손절' : '🔔 청산';
  notify(
    `[변동성돌파 ${emoji}${holding.isLive ? '' : ' (모의)'}] ${bot.market}\n` +
      `진입 ${Math.round(holding.entryPrice).toLocaleString()} → 청산 ${Math.round(exitPrice).toLocaleString()}\n` +
      `손익 ${Math.round(pnlKrw).toLocaleString()} KRW (${pnlPct.toFixed(2)}%)`,
  );
}
```

- [ ] **Step 2: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 에러 0개. 흔한 이슈: ① `kakaoNotifyService` export 이름이 다르면 `src/services/kakao-notify.service.ts`를 열어 실제 export명 확인 ② `credential.apiKey`/`secretKey` 필드명이 다르면 `prisma/schema.prisma`의 Credential 모델 확인 ③ `UpbitService.getCurrentPrice` 반환 타입이 any면 `ticker.trade_price` 그대로 사용 가능

- [ ] **Step 3: 커밋**

```bash
git add src/services/volatility-breakout.service.ts
git commit -m "feat: 변동성 돌파 봇 서비스 (CRUD + 사이클 + 모의/실거래 체결)"
```

---

### Task 7: 에이전트 + index.ts 등록

**Files:**
- Create: `src/agents/volatility-breakout-agent.ts`
- Modify: `src/index.ts` (L88~97 부근 `agentManager.register(...)` 블록)

- [ ] **Step 1: 에이전트 구현**

`src/agents/volatility-breakout-agent.ts`:

```typescript
import { BaseAgent } from './base-agent';
import { runCycle } from '../services/volatility-breakout.service';

/**
 * 변동성 돌파(래리 윌리엄스) 자동매매 에이전트.
 * 30초 주기로 enabled 봇의 돌파 진입 + HOLDING 포지션 청산 조건을 평가한다.
 * 실제 로직은 volatility-breakout.service.ts에 위임.
 */
export class VolatilityBreakoutAgent extends BaseAgent {
  constructor() {
    super({
      id: 'volatility-breakout',
      name: 'VolatilityBreakoutAgent',
      description: '변동성 돌파(래리 윌리엄스) 자동매매 봇 — KST 09:00 사이클, 하루 1회 진입',
      cycleIntervalMs: 30_000,
    });
  }

  protected async onStart(): Promise<void> {
    // HOLDING 포지션은 DB row 기반이라 별도 복구 작업 불필요 — 첫 사이클에서 자동 감시 재개
  }

  protected async onStop(): Promise<void> {}

  protected async onCycle(): Promise<void> {
    await runCycle();
  }
}
```

- [ ] **Step 2: src/index.ts에 등록**

`src/index.ts`의 기존 `agentManager.register(new ...)` 블록(L88~97) 마지막 줄 뒤에 추가:

```typescript
import { VolatilityBreakoutAgent } from './agents/volatility-breakout-agent'; // 상단 import 블록에

agentManager.register(new VolatilityBreakoutAgent()); // register 블록에
```

- [ ] **Step 3: 타입 체크 + 개발 서버 기동 확인**

Run: `npx tsc --noEmit`
Expected: 에러 0개

Run: `npm run dev` (잠깐 띄웠다가 Ctrl+C)
Expected: 에이전트 등록 로그에 VolatilityBreakoutAgent 포함, 에러 없이 기동. (참고: `agentManager.startAll()`은 production에서만 실행되므로 로컬에서 사이클이 돌지 않는 것이 정상)

- [ ] **Step 4: 커밋**

```bash
git add src/agents/volatility-breakout-agent.ts src/index.ts
git commit -m "feat: 변동성 돌파 에이전트 등록 (30초 사이클)"
```

---

### Task 8: 컨트롤러 + 라우트

**Files:**
- Create: `src/controllers/volatility-admin.controller.ts`
- Create: `src/routes/volatility-admin.ts`
- Modify: `src/routes/index.ts` (L53 `/admin/stablecoin` 부근)

- [ ] **Step 1: 컨트롤러 구현**

`src/controllers/volatility-admin.controller.ts` (수동 검증 — stablecoin-admin 패턴):

```typescript
import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { AppError } from '../middlewares/errorHandler';
import * as vbService from '../services/volatility-breakout.service';
import { runBacktest } from '../services/volatility-backtest.service';

const MARKET_RE = /^KRW-[A-Z0-9]+$/;

function validateBotFields(body: any, partial: boolean) {
  if (!partial || body.buyAmountKrw !== undefined) {
    if (typeof body.buyAmountKrw !== 'number' || body.buyAmountKrw < 5000) {
      throw new AppError('buyAmountKrw는 5000 이상 숫자여야 합니다', 400);
    }
  }
  if (body.k !== undefined && (typeof body.k !== 'number' || body.k < 0.1 || body.k > 2)) {
    throw new AppError('k는 0.1~2 사이 숫자여야 합니다', 400);
  }
  if (
    body.stopLossPct !== undefined &&
    (typeof body.stopLossPct !== 'number' || body.stopLossPct < 0.5 || body.stopLossPct > 50)
  ) {
    throw new AppError('stopLossPct는 0.5~50 사이 숫자여야 합니다', 400);
  }
}

/** GET /api/admin/volatility/bots — 봇 목록 + 실시간 상태 */
export const listBots = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await vbService.listBots(req.userId!));
  } catch (error) {
    next(error);
  }
};

/** POST /api/admin/volatility/bots — {market, buyAmountKrw, k?, stopLossPct?} */
export const createBot = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = req.body ?? {};
    if (typeof body.market !== 'string' || !MARKET_RE.test(body.market)) {
      throw new AppError('market은 KRW-XXX 형식이어야 합니다', 400);
    }
    validateBotFields(body, false);
    const bot = await vbService.createBot({
      userId: req.userId!,
      market: body.market,
      buyAmountKrw: body.buyAmountKrw,
      k: body.k,
      stopLossPct: body.stopLossPct,
    });
    res.json(bot);
  } catch (error) {
    next(error);
  }
};

/** PUT /api/admin/volatility/bots/:id — Partial{buyAmountKrw, k, stopLossPct, live, enabled} */
export const updateBot = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw new AppError('Invalid id', 400);
    const body = req.body ?? {};
    validateBotFields(body, true);

    const patch: Record<string, any> = {};
    for (const f of ['buyAmountKrw', 'k', 'stopLossPct'] as const) {
      if (body[f] !== undefined) patch[f] = body[f];
    }
    for (const f of ['live', 'enabled'] as const) {
      if (body[f] !== undefined) {
        if (typeof body[f] !== 'boolean') throw new AppError(`${f}는 boolean이어야 합니다`, 400);
        patch[f] = body[f];
      }
    }
    if (Object.keys(patch).length === 0) throw new AppError('수정할 필드가 없습니다', 400);

    res.json(await vbService.updateBot(req.userId!, id, patch));
  } catch (error) {
    next(error);
  }
};

/** DELETE /api/admin/volatility/bots/:id — HOLDING이면 거부 */
export const deleteBot = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw new AppError('Invalid id', 400);
    await vbService.deleteBot(req.userId!, id);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

/** GET /api/admin/volatility/bots/:id/trades?page=1&pageSize=20 */
export const listTrades = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw new AppError('Invalid id', 400);
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? '20'), 10) || 20));
    res.json(await vbService.listTrades(req.userId!, id, page, pageSize));
  } catch (error) {
    next(error);
  }
};

/** POST /api/admin/volatility/backtest — {market, k, stopLossPct, years(1|2|4|8)} */
export const backtest = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = req.body ?? {};
    if (typeof body.market !== 'string' || !MARKET_RE.test(body.market)) {
      throw new AppError('market은 KRW-XXX 형식이어야 합니다', 400);
    }
    if (typeof body.k !== 'number' || body.k < 0.1 || body.k > 2) {
      throw new AppError('k는 0.1~2 사이 숫자여야 합니다', 400);
    }
    if (typeof body.stopLossPct !== 'number' || body.stopLossPct < 0.5 || body.stopLossPct > 50) {
      throw new AppError('stopLossPct는 0.5~50 사이 숫자여야 합니다', 400);
    }
    if (![1, 2, 4, 8].includes(body.years)) {
      throw new AppError('years는 1|2|4|8 중 하나여야 합니다', 400);
    }
    const result = await runBacktest({
      market: body.market,
      k: body.k,
      stopLossPct: body.stopLossPct,
      years: body.years,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
};
```

- [ ] **Step 2: 라우트 구현**

`src/routes/volatility-admin.ts` (stablecoin-admin.ts 패턴):

```typescript
import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import { requireAdmin } from '../middlewares/requireAdmin';
import {
  listBots,
  createBot,
  updateBot,
  deleteBot,
  listTrades,
  backtest,
} from '../controllers/volatility-admin.controller';

const router = Router();

// 모든 라우트에 authenticate + requireAdmin 적용 (관리자 전용)
router.use(authenticate);
router.use(requireAdmin);

router.get('/bots', listBots);
router.post('/bots', createBot);
router.put('/bots/:id', updateBot);
router.delete('/bots/:id', deleteBot);
router.get('/bots/:id/trades', listTrades);
router.post('/backtest', backtest);

export default router;
```

- [ ] **Step 3: routes/index.ts에 마운트**

`src/routes/index.ts` — 상단 import 블록과 L53 `/admin/stablecoin` 마운트 아래에 추가:

```typescript
import volatilityAdminRoutes from './volatility-admin';

router.use('/admin/volatility', volatilityAdminRoutes);
```

- [ ] **Step 4: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 에러 0개

- [ ] **Step 5: 커밋**

```bash
git add src/controllers/volatility-admin.controller.ts src/routes/volatility-admin.ts src/routes/index.ts
git commit -m "feat: 변동성 돌파 관리자 API (/admin/volatility)"
```

---

### Task 9: 백엔드 전체 검증

- [ ] **Step 1: 전체 테스트**

Run: `npx jest`
Expected: 기존 테스트 + 신규 19개 모두 PASS

- [ ] **Step 2: 빌드**

Run: `npm run build`
Expected: prisma generate + tsc 성공 (0 errors)

- [ ] **Step 3: 미커밋 변경 없는지 확인**

Run: `git status`
Expected: clean (scripts/diagnose-profit-gap.ts, scripts/exchange-rates.ts는 기존 미커밋 잔여 — 건드리지 말 것)

---

### Task 10: 프론트엔드 — lib/api.ts API 함수 + 타입

> **작업 디렉토리: `v0-grid-transaction-frontend/`** (백엔드 파일 수정 금지)

**Files:**
- Modify: `lib/api.ts` (파일 끝에 추가 — 기존 `getAuthHeaders`/`fetchWithTimeout`/`API_BASE_URL` 재사용)

- [ ] **Step 1: 타입 + 함수 추가**

`lib/api.ts` 끝에 추가:

```typescript
// ===== 변동성 돌파 봇 (관리자 전용) =====

export interface VolatilityBotStatus {
  tradeDate: string;
  targetPrice: number | null;
  currentPrice: number | null;
  breakoutDistancePct: number | null;
  position: 'WAITING' | 'HOLDING' | 'CLOSED_TODAY';
  holding: {
    entryPrice: number;
    qty: number;
    entryAt: string;
    unrealizedPnlKrw: number | null;
  } | null;
}

export interface VolatilityBot {
  id: number;
  market: string;
  buyAmountKrw: number;
  k: number;
  stopLossPct: number;
  live: boolean;
  enabled: boolean;
  createdAt: string;
  status: VolatilityBotStatus;
}

export interface VolatilityTrade {
  id: number;
  tradeDate: string;
  targetPrice: number;
  entryPrice: number;
  entryAt: string;
  qty: number;
  exitPrice: number | null;
  exitAt: string | null;
  exitReason: 'CLOSE' | 'STOP' | null;
  pnlKrw: number | null;
  pnlPct: number | null;
  isLive: boolean;
  status: 'HOLDING' | 'CLOSED';
}

export interface VolatilityBacktestResult {
  n: number;
  winRate: number;
  avgNetPct: number;
  finalCapital: number;
  maxDdPct: number;
  worstPct: number;
  yearly: Array<{ year: number; pnlPct: number }>;
  buyHoldFinal: number;
}

const VOLATILITY_BASE = `${API_BASE_URL}/api/admin/volatility`;

export async function getVolatilityBots(): Promise<VolatilityBot[]> {
  const res = await fetchWithTimeout(`${VOLATILITY_BASE}/bots`, { headers: getAuthHeaders() });
  if (!res.ok) throw new Error((await res.json()).message || '봇 목록 조회 실패');
  return res.json();
}

export async function createVolatilityBot(params: {
  market: string;
  buyAmountKrw: number;
  k?: number;
  stopLossPct?: number;
}): Promise<VolatilityBot> {
  const res = await fetchWithTimeout(`${VOLATILITY_BASE}/bots`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error((await res.json()).message || '봇 생성 실패');
  return res.json();
}

export async function updateVolatilityBot(
  id: number,
  patch: Partial<{ buyAmountKrw: number; k: number; stopLossPct: number; live: boolean; enabled: boolean }>,
): Promise<VolatilityBot> {
  const res = await fetchWithTimeout(`${VOLATILITY_BASE}/bots/${id}`, {
    method: 'PUT',
    headers: getAuthHeaders(),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error((await res.json()).message || '봇 수정 실패');
  return res.json();
}

export async function deleteVolatilityBot(id: number): Promise<void> {
  const res = await fetchWithTimeout(`${VOLATILITY_BASE}/bots/${id}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  if (!res.ok) throw new Error((await res.json()).message || '봇 삭제 실패');
}

export async function getVolatilityTrades(
  botId: number,
  page = 1,
  pageSize = 20,
): Promise<{ trades: VolatilityTrade[]; total: number; page: number; pageSize: number }> {
  const res = await fetchWithTimeout(
    `${VOLATILITY_BASE}/bots/${botId}/trades?page=${page}&pageSize=${pageSize}`,
    { headers: getAuthHeaders() },
  );
  if (!res.ok) throw new Error((await res.json()).message || '거래 내역 조회 실패');
  return res.json();
}

export async function runVolatilityBacktest(params: {
  market: string;
  k: number;
  stopLossPct: number;
  years: 1 | 2 | 4 | 8;
}): Promise<VolatilityBacktestResult> {
  // 8년 백테스트는 일봉 수집에 3~5초 — 타임아웃 30초
  const res = await fetchWithTimeout(
    `${VOLATILITY_BASE}/backtest`,
    { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify(params) },
    30000,
  );
  if (!res.ok) throw new Error((await res.json()).message || '백테스트 실패');
  return res.json();
}
```

**주의:** 백엔드 라우트가 `/api` 접두사 아래 마운트되는지 확인 — 기존 stablecoin admin 호출이 `lib/api.ts`에서 어떤 경로를 쓰는지 grep (`admin/stablecoin`)해서 동일한 접두사를 따를 것. `/api`가 아니면 `VOLATILITY_BASE`를 맞춰 수정.

- [ ] **Step 2: 커밋**

```bash
git add lib/api.ts
git commit -m "feat: 변동성 돌파 봇 API 함수 추가"
```

---

### Task 11: 프론트엔드 — 관리자 페이지

**Files:**
- Create: `app/admin/volatility/page.tsx`

- [ ] **Step 1: 페이지 구현**

`app/admin/volatility/page.tsx` — `app/admin/btc-rsi/page.tsx`의 관리자 체크 패턴 + shadcn Card/Dialog/Switch/Select/Table 사용 (모두 `components/ui/`에 존재 확인됨):

```tsx
"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { TrendingUp, Play, Square, Trash2, FlaskConical, RefreshCw } from "lucide-react"
import {
  getVolatilityBots, createVolatilityBot, updateVolatilityBot, deleteVolatilityBot,
  getVolatilityTrades, runVolatilityBacktest,
  type VolatilityBot, type VolatilityTrade, type VolatilityBacktestResult,
} from "@/lib/api"
import { toast } from "sonner"

const ADMIN_EMAIL = "ok4192@hanmail.net"
const MARKETS = ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP", "KRW-DOGE"]
const krw = (n: number) => Math.round(n).toLocaleString()

export default function VolatilityAdminPage() {
  const router = useRouter()
  const [bots, setBots] = useState<VolatilityBot[]>([])
  const [trades, setTrades] = useState<VolatilityTrade[]>([])
  const [loading, setLoading] = useState(true)

  // 봇 생성 폼
  const [market, setMarket] = useState("KRW-BTC")
  const [buyAmountKrw, setBuyAmountKrw] = useState("100000")
  const [k, setK] = useState("0.65")
  const [stopLossPct, setStopLossPct] = useState("3")

  // 실거래 전환 확인 다이얼로그
  const [liveConfirmBot, setLiveConfirmBot] = useState<VolatilityBot | null>(null)

  // 백테스트
  const [btYears, setBtYears] = useState<"1" | "2" | "4" | "8">("4")
  const [btResult, setBtResult] = useState<VolatilityBacktestResult | null>(null)
  const [btRunning, setBtRunning] = useState(false)

  useEffect(() => {
    const user = typeof window !== "undefined" ? JSON.parse(localStorage.getItem("user") || "{}") : {}
    if (user.email !== ADMIN_EMAIL) router.push("/")
  }, [router])

  const loadBots = useCallback(async () => {
    try {
      const data = await getVolatilityBots()
      setBots(data)
      if (data.length > 0) {
        const t = await getVolatilityTrades(data[0].id)
        setTrades(t.trades)
      }
    } catch (e: any) {
      toast.error(e.message || "데이터 로딩 실패")
    } finally {
      setLoading(false)
    }
  }, [])

  // 10초 폴링 갱신 (스펙 §8)
  useEffect(() => {
    loadBots()
    const timer = setInterval(loadBots, 10_000)
    return () => clearInterval(timer)
  }, [loadBots])

  const handleCreate = async () => {
    try {
      await createVolatilityBot({
        market,
        buyAmountKrw: Number(buyAmountKrw),
        k: Number(k),
        stopLossPct: Number(stopLossPct),
      })
      toast.success(`${market} 봇 생성 완료 (모의 모드)`)
      loadBots()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  const handleToggleEnabled = async (bot: VolatilityBot) => {
    try {
      await updateVolatilityBot(bot.id, { enabled: !bot.enabled })
      toast.success(bot.enabled ? "봇 정지 (보유 포지션 청산 감시는 유지)" : "봇 시작")
      loadBots()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  const handleToggleLive = (bot: VolatilityBot) => {
    if (!bot.live) {
      setLiveConfirmBot(bot) // 모의→실거래는 확인 다이얼로그
    } else {
      confirmLiveChange(bot, false)
    }
  }

  const confirmLiveChange = async (bot: VolatilityBot, live: boolean) => {
    try {
      await updateVolatilityBot(bot.id, { live })
      toast.success(live ? "⚠️ 실거래 모드 전환됨" : "모의 모드 전환됨")
      setLiveConfirmBot(null)
      loadBots()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  const handleDelete = async (bot: VolatilityBot) => {
    if (!window.confirm(`${bot.market} 봇을 삭제할까요? 거래 내역도 함께 삭제됩니다.`)) return
    try {
      await deleteVolatilityBot(bot.id)
      toast.success("봇 삭제 완료")
      loadBots()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  const handleBacktest = async () => {
    setBtRunning(true)
    setBtResult(null)
    try {
      const result = await runVolatilityBacktest({
        market,
        k: Number(k),
        stopLossPct: Number(stopLossPct),
        years: Number(btYears) as 1 | 2 | 4 | 8,
      })
      setBtResult(result)
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBtRunning(false)
    }
  }

  if (loading) return <div className="p-8 text-muted-foreground">로딩 중...</div>

  return (
    <div className="space-y-6 p-4 md:p-8 max-w-5xl mx-auto">
      <div className="flex items-center gap-2">
        <TrendingUp className="h-6 w-6" />
        <h1 className="text-2xl font-bold">변동성 돌파 봇 (관리자)</h1>
      </div>

      {/* 1. 봇 설정 카드 */}
      <Card>
        <CardHeader><CardTitle>새 봇 / 백테스트 설정</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <Label>코인</Label>
            <Select value={market} onValueChange={setMarket}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {MARKETS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>1회 매수금액 (KRW)</Label>
            <Input type="number" value={buyAmountKrw} onChange={(e) => setBuyAmountKrw(e.target.value)} />
          </div>
          <div>
            <Label>k (0.1~2)</Label>
            <Input type="number" step="0.05" value={k} onChange={(e) => setK(e.target.value)} />
          </div>
          <div>
            <Label>손절 % (0.5~50)</Label>
            <Input type="number" step="0.5" value={stopLossPct} onChange={(e) => setStopLossPct(e.target.value)} />
          </div>
          <div className="col-span-2 md:col-span-4 flex gap-2">
            <Button onClick={handleCreate}>봇 생성 (모의 모드)</Button>
            <Button variant="outline" onClick={handleBacktest} disabled={btRunning}>
              <FlaskConical className="h-4 w-4 mr-1" />
              {btRunning ? "백테스트 실행 중..." : "백테스트 검증"}
            </Button>
            <Select value={btYears} onValueChange={(v) => setBtYears(v as typeof btYears)}>
              <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["1", "2", "4", "8"].map((y) => <SelectItem key={y} value={y}>{y}년</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* 3. 백테스트 결과 카드 */}
      {btResult && (
        <Card>
          <CardHeader>
            <CardTitle>백테스트 결과 — {market}, k={k}, 손절 {stopLossPct}%, {btYears}년 (₩100만 시작)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div>최종자본 <div className="font-bold text-lg">₩{krw(btResult.finalCapital)}</div></div>
              <div>단순보유 <div className="font-bold text-lg">₩{krw(btResult.buyHoldFinal)}</div></div>
              <div>승률 <div className="font-bold text-lg">{btResult.winRate.toFixed(0)}% ({btResult.n}건)</div></div>
              <div>MDD <div className="font-bold text-lg">{btResult.maxDdPct.toFixed(1)}%</div></div>
            </div>
            <div className="flex flex-wrap gap-2">
              {btResult.yearly.map((y) => (
                <Badge key={y.year} variant={y.pnlPct >= 0 ? "default" : "destructive"}>
                  {y.year}: {y.pnlPct >= 0 ? "+" : ""}{y.pnlPct.toFixed(1)}%
                </Badge>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              일봉 기반 근사치 — 장중 돌파→손절 순서/슬리피지 미반영. 모의 모드 실측으로 검증 권장.
            </p>
          </CardContent>
        </Card>
      )}

      {/* 2. 봇 목록 + 오늘 상태 카드 */}
      {bots.map((bot) => (
        <Card key={bot.id}>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              {bot.market}
              <Badge variant={bot.enabled ? "default" : "secondary"}>{bot.enabled ? "가동 중" : "정지"}</Badge>
              <Badge variant={bot.live ? "destructive" : "outline"}>{bot.live ? "실거래" : "모의"}</Badge>
            </CardTitle>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1 text-sm">
                <span>실거래</span>
                <Switch checked={bot.live} onCheckedChange={() => handleToggleLive(bot)} />
              </div>
              <Button size="sm" variant={bot.enabled ? "secondary" : "default"} onClick={() => handleToggleEnabled(bot)}>
                {bot.enabled ? <><Square className="h-4 w-4 mr-1" />정지</> : <><Play className="h-4 w-4 mr-1" />시작</>}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => handleDelete(bot)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
            <div>매수금액 <div className="font-semibold">₩{krw(bot.buyAmountKrw)}</div></div>
            <div>k / 손절 <div className="font-semibold">{bot.k} / {bot.stopLossPct}%</div></div>
            <div>목표가 <div className="font-semibold">{bot.status.targetPrice ? `₩${krw(bot.status.targetPrice)}` : "—"}</div></div>
            <div>현재가 <div className="font-semibold">{bot.status.currentPrice ? `₩${krw(bot.status.currentPrice)}` : "—"}</div></div>
            <div>
              포지션
              <div className="font-semibold">
                {bot.status.position === "HOLDING" && bot.status.holding ? (
                  <>보유 (진입 ₩{krw(bot.status.holding.entryPrice)}
                  {bot.status.holding.unrealizedPnlKrw !== null &&
                    `, 평가 ${bot.status.holding.unrealizedPnlKrw >= 0 ? "+" : ""}₩${krw(bot.status.holding.unrealizedPnlKrw)}`})</>
                ) : bot.status.position === "CLOSED_TODAY" ? "오늘 청산 완료" :
                  bot.status.breakoutDistancePct !== null ?
                    `대기 (돌파까지 ${bot.status.breakoutDistancePct.toFixed(2)}%)` : "대기"}
              </div>
            </div>
          </CardContent>
        </Card>
      ))}

      {/* 4. 거래 내역 테이블 (첫 봇 기준) */}
      {trades.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>거래 내역</CardTitle>
            <Button size="sm" variant="ghost" onClick={loadBots}><RefreshCw className="h-4 w-4" /></Button>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>날짜</TableHead><TableHead>모드</TableHead><TableHead>진입가</TableHead>
                  <TableHead>청산가</TableHead><TableHead>사유</TableHead><TableHead className="text-right">손익</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trades.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>{t.tradeDate}</TableCell>
                    <TableCell><Badge variant={t.isLive ? "destructive" : "outline"}>{t.isLive ? "실거래" : "모의"}</Badge></TableCell>
                    <TableCell>₩{krw(t.entryPrice)}</TableCell>
                    <TableCell>{t.exitPrice ? `₩${krw(t.exitPrice)}` : "보유 중"}</TableCell>
                    <TableCell>{t.exitReason ?? "—"}</TableCell>
                    <TableCell className={`text-right ${(t.pnlKrw ?? 0) >= 0 ? "text-green-600" : "text-red-600"}`}>
                      {t.pnlKrw !== null ? `${t.pnlKrw >= 0 ? "+" : ""}₩${krw(t.pnlKrw)} (${t.pnlPct?.toFixed(2)}%)` : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* 실거래 전환 확인 다이얼로그 (스펙 §3) */}
      <Dialog open={liveConfirmBot !== null} onOpenChange={(open) => !open && setLiveConfirmBot(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>⚠️ 실거래 모드 전환</DialogTitle>
            <DialogDescription>
              {liveConfirmBot?.market} 봇이 실제 업비트 주문을 실행합니다.
              1회 매수금액 ₩{liveConfirmBot ? krw(liveConfirmBot.buyAmountKrw) : 0}.
              모의 모드 실측 결과를 확인했나요?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLiveConfirmBot(null)}>취소</Button>
            <Button variant="destructive" onClick={() => liveConfirmBot && confirmLiveChange(liveConfirmBot, true)}>
              실거래 전환
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
```

- [ ] **Step 2: 커밋**

```bash
git add app/admin/volatility/page.tsx
git commit -m "feat: 변동성 돌파 봇 관리자 페이지"
```

---

### Task 12: 프론트엔드 빌드 검증 + 통합 확인

- [ ] **Step 1: 린트 + 빌드**

Run: `npm run lint` → 에러 0개
Run: `npm run build` → 빌드 성공

- [ ] **Step 2: 브라우저 확인 (백엔드 dev 서버 + 프론트 dev 서버 동시 기동)**

백엔드: `npm run dev` (포트 3010) / 프론트: `npm run dev` (포트 3009)
확인 항목:
1. 관리자 계정 로그인 → `/admin/volatility` 접근 가능, 비관리자는 `/`로 리다이렉트
2. 봇 생성 (KRW-BTC, 10만원, k=0.65, 손절 3%) → 목록에 표시, 목표가/현재가/돌파까지 % 표시
3. 백테스트 검증 버튼 (1년) → 결과 카드 표시 (최종자본/승률/MDD/연도별)
4. 실거래 토글 → 확인 다이얼로그 표시, 취소 동작
5. 시작/정지 토글 동작

- [ ] **Step 3: 통합 검증 (모의 모드 1사이클 관찰 — 스펙 §11-6)**

배포 후 production에서: 봇 enabled=true (모의 모드) 상태로 두고 30초 사이클 로그 확인.
- 돌파 전: 사이클 에러 없음, 목표가 캐시 1회 조회
- (돌파 발생 시) HOLDING row 생성 + 카카오 알림 수신
- 관리자 페이지 10초 폴링으로 상태 갱신 확인

---

## Self-Review 체크 결과

**스펙 커버리지:** §2 전략 규칙→Task 2·3·6 / §3 모드·토글·확인 다이얼로그·최소금액→Task 6·11 / §4 데이터 모델→Task 1 / §5 백엔드 구성·사이클→Task 5~8 / §6 API 6개·검증 범위→Task 8 / §7 백테스트 엔진→Task 3·5 / §8 화면 4구성·10초 폴링→Task 11 / §9 안전장치(매수 skip·매도 재시도·disabled 청산 감시·삭제 거부)→Task 6 / §10 TDD 항목 전부→Task 2·3 / §11 구현 순서 준수.

**스펙과 다른 점 정리:**
1. zod → 수동 검증 (백엔드에 zod 없음, 기존 패턴 따름)
2. 추가 안전장치: `isNearCycleEnd` (KST 08:50 이후 신규 진입 금지) — 진입 5분 만에 강제청산되는 무의미한 거래 방지
3. 텔레그램 알림 → 카카오만 (코드베이스에 kakaoNotifyService만 확인됨. 텔레그램 서비스가 있으면 구현 시 같이 호출)

**구현자가 현장 확인할 것:** ① `kakao-notify.service.ts`의 실제 export명 ② Credential 모델의 apiKey/secretKey 필드명 ③ 프론트 API 경로 `/api` 접두사 여부 ④ Task 6의 `throw e` 삭제 지시 반영

