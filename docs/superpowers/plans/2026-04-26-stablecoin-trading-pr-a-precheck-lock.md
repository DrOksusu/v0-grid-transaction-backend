# PR A 구현 계획: pre-check + tradingLock + DB 확장

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 스테이블코인 통합 트레이딩의 안전 기반 구축 — 5단계 pre-check 순수 함수, 메모리 mutex, DB 스키마 확장 (live 필드 + makerOrderUuid + krwFlowNetKrw). **실거래 코드 없음** (가장 안전한 PR로 시작).

**Architecture:** PR A는 PR B/C/D의 기반. 새 모듈 2개 + DB schema 확장만 포함. 모든 함수는 순수 함수 또는 메모리 only. agent / executor / Upbit 호출 없음.

**Tech Stack:** TypeScript, Prisma (MySQL stablecoin DB), Jest, ts-jest

---

## File Structure

| 종류 | 경로 | 책임 |
|---|---|---|
| Create | `src/services/stablecoin-trading-lock.ts` | process-local 메모리 mutex (singleton). tryAcquire/release/isLocked + 30s timeout |
| Create | `src/services/stablecoin-pre-check.ts` | 5개 검사 순수 함수 + runAll 통합 |
| Create | `__tests__/services/stablecoin-trading-lock.test.ts` | mutex 단위 테스트 |
| Create | `__tests__/services/stablecoin-pre-check.test.ts` | 5 함수 단위 테스트 |
| Modify | `prisma-stablecoin/schema.prisma` | StablecoinArbBot+live, MakerTakerSimBot+live, MakerTakerSimTrade+live+makerOrderUuid, StablecoinArbTrade+krwFlowNetKrw |
| Create | `prisma-stablecoin/migrations/<timestamp>_add_live_and_uuid/migration.sql` | 위 변경 ALTER TABLE |

기존 ArbTradeStatus enum (LEG1_FILLED 등) 그대로 활용 → spec의 legAStatus/legBStatus 추가는 불필요. totalFeeKrw도 이미 있어 paidFeeKrw 추가 불필요.

---

## Task 1: Prisma schema 변경

**Files:**
- Modify: `prisma-stablecoin/schema.prisma`

- [ ] **Step 1: schema.prisma의 StablecoinArbBot 모델에 live 필드 추가**

`prisma-stablecoin/schema.prisma`에서 `model StablecoinArbBot` 안의 `killSwitch` 라인 바로 다음에 추가:

```prisma
  live       Boolean @default(false)  // M3 실거래 활성화 (false=detection only)
```

- [ ] **Step 2: StablecoinArbTrade 모델에 krwFlowNetKrw 필드 추가**

`model StablecoinArbTrade` 안의 `profitUsd` 라인 바로 다음에 추가:

```prisma
  krwFlowNetKrw Decimal? @db.Decimal(18, 4)  // 보조 통계: KRW flow 기준 net (자산 변환 무시)
```

- [ ] **Step 3: MakerTakerSimBot 모델에 live 필드 추가**

`model MakerTakerSimBot` 안의 `killSwitch` 라인 바로 다음에 추가:

```prisma
  live       Boolean @default(false)  // 실거래 활성화 (false=시뮬레이터 유지)
```

- [ ] **Step 4: MakerTakerSimTrade 모델에 live + makerOrderUuid 필드 추가**

`model MakerTakerSimTrade` 안의 `quantity` 라인 바로 다음에 추가:

```prisma
  live            Boolean @default(false)  // 실거래 trade 표시
  makerOrderUuid  String? @db.VarChar(64)  // live 주문의 Upbit uuid (status polling/cancel용)
```

- [ ] **Step 5: prisma format으로 들여쓰기 정렬**

Run: `cd "D:/ExpressProject/Grid_project/v0-grid-tranasction-backend" && npx prisma format --schema=prisma-stablecoin/schema.prisma`
Expected: "Formatted prisma-stablecoin/schema.prisma" 메시지 + 변경 없거나 들여쓰기만 정렬

- [ ] **Step 6: prisma generate로 client 갱신**

Run: `cd "D:/ExpressProject/Grid_project/v0-grid-tranasction-backend" && npx prisma generate --schema=prisma-stablecoin/schema.prisma`
Expected: "Generated Prisma Client (vX.X.X) to ./node_modules/.prisma/client-stablecoin" 메시지

- [ ] **Step 7: tsc로 client 타입 검증**

Run: `cd "D:/ExpressProject/Grid_project/v0-grid-tranasction-backend" && npx tsc --noEmit`
Expected: 에러 0개. 신규 필드(live, krwFlowNetKrw, makerOrderUuid)가 type으로 노출됨

- [ ] **Step 8: schema 변경 commit**

```bash
cd "D:/ExpressProject/Grid_project/v0-grid-tranasction-backend"
git checkout -b feat/stablecoin-trading-pr-a
git add prisma-stablecoin/schema.prisma
git commit -m "feat(stablecoin): schema에 live/makerOrderUuid/krwFlowNetKrw 필드 추가

PR A 기반 작업: PR B/C/D에서 사용할 schema 확장.
- StablecoinArbBot.live: M3 실거래 활성화 토글 (default false)
- StablecoinArbTrade.krwFlowNetKrw: 보조 통계 (KRW flow 기준 net)
- MakerTakerSimBot.live: maker-taker 실거래 활성화 (default false)
- MakerTakerSimTrade.live + makerOrderUuid: live trade 표시 + Upbit 주문 추적

기존 enum/필드(ArbTradeStatus, totalFeeKrw)로 spec 일부 요건 충족."
```

---

## Task 2: Migration 생성 + 검증 + 로컬 적용

**Files:**
- Create: `prisma-stablecoin/migrations/<timestamp>_add_live_and_uuid/migration.sql`

> **트랩 #0 회피**: Prisma 5.22 migrate dev가 migration.sql 끝에 box-drawing 문자(┌ │ └) 혼입 → P3009. 반드시 `--create-only` + `tail -10` 검사 후 deploy.

- [ ] **Step 1: migration --create-only로 SQL만 생성 (deploy X)**

먼저 로컬 Docker MySQL이 떠있는지 확인:
```bash
docker ps --filter name=grid-mysql-dev --format "{{.Status}}"
```
Expected: "Up X minutes" 출력. 없으면 시작:
```bash
docker start grid-mysql-dev
```

그 다음 migration 생성:
```bash
cd "D:/ExpressProject/Grid_project/v0-grid-tranasction-backend"
npx prisma migrate dev --schema=prisma-stablecoin/schema.prisma --create-only --name add_live_and_uuid
```
Expected: "The following migration(s) have been created and applied: <timestamp>_add_live_and_uuid" 또는 "created (not applied)" 메시지. SQL 파일 생성됨.

- [ ] **Step 2: 생성된 migration.sql 끝부분 검사 (CLI garbage 체크)**

Run:
```bash
ls prisma-stablecoin/migrations/ | tail -3
# 가장 최근 폴더 이름 확인 후 (예: 20260426120000_add_live_and_uuid)
tail -15 prisma-stablecoin/migrations/<폴더>/migration.sql
```
Expected: SQL 문장만. `┌`, `│`, `└`, "Want to" 등 prompt 텍스트 발견 시 → 직접 vim/edit로 마지막 ALTER까지만 남기고 삭제.

검증 통과 기준: 마지막 줄이 `;` 로 끝나거나 빈 줄.

- [ ] **Step 3: migration deploy (로컬 dev DB만)**

Run:
```bash
cd "D:/ExpressProject/Grid_project/v0-grid-tranasction-backend"
npx prisma migrate deploy --schema=prisma-stablecoin/schema.prisma
```
Expected: "Applying migration `<timestamp>_add_live_and_uuid`" + "All migrations have been successfully applied"

이때 STABLECOIN_DATABASE_URL이 로컬 (localhost:3308) 가리키는지 .env 확인 필수. production 가리키면 즉시 abort + .env 수정.

- [ ] **Step 4: migration 적용 확인 (information_schema)**

Run:
```bash
docker exec grid-mysql-dev mysql -uroot -proot -e "
USE grid_stablecoin_arb;
SHOW COLUMNS FROM stablecoin_arb_bots LIKE 'live';
SHOW COLUMNS FROM stablecoin_arb_trades LIKE 'krwFlowNetKrw';
SHOW COLUMNS FROM maker_taker_sim_bots LIKE 'live';
SHOW COLUMNS FROM maker_taker_sim_trades LIKE 'live';
SHOW COLUMNS FROM maker_taker_sim_trades LIKE 'makerOrderUuid';
"
```
Expected: 5 row 출력 (각 컬럼 존재 확인)

- [ ] **Step 5: migration commit**

```bash
git add prisma-stablecoin/migrations/<폴더>/
git commit -m "feat(stablecoin): migration 추가 (live + makerOrderUuid + krwFlowNetKrw)

ALTER TABLE 5건. tail 검사로 Prisma CLI garbage 없음 확인.
production은 deploy.yml의 'npx prisma migrate deploy'로 자동 적용."
```

---

## Task 3: tradingLock 모듈 + 단위 테스트 (TDD)

**Files:**
- Create: `__tests__/services/stablecoin-trading-lock.test.ts`
- Create: `src/services/stablecoin-trading-lock.ts`

- [ ] **Step 1: 테스트 파일 작성 (4 케이스)**

Create `__tests__/services/stablecoin-trading-lock.test.ts`:

```typescript
import { tradingLock } from '../../src/services/stablecoin-trading-lock';

describe('tradingLock', () => {
  beforeEach(() => {
    // 각 테스트 전 lock 강제 해제 (다른 테스트 영향 방지)
    if (tradingLock.isLocked()) {
      // 강제 release: 30s timeout 흉내내려면 시계 mock이 필요하지만
      // 단순화 — 모듈 내부 reset 함수 호출
      (tradingLock as any)._reset?.();
    }
  });

  it('처음 acquire는 성공한다', () => {
    expect(tradingLock.tryAcquire('test-A')).toBe(true);
    expect(tradingLock.isLocked()).toBe(true);
    tradingLock.release('test-A');
    expect(tradingLock.isLocked()).toBe(false);
  });

  it('점유 중에 다른 holder의 acquire는 실패한다 (contention)', () => {
    expect(tradingLock.tryAcquire('A')).toBe(true);
    expect(tradingLock.tryAcquire('B')).toBe(false);
    expect(tradingLock.isLocked()).toBe(true);
    tradingLock.release('A');
  });

  it('다른 holder의 release는 무시된다 (안전)', () => {
    tradingLock.tryAcquire('A');
    tradingLock.release('B');  // 잘못된 holder — 무시
    expect(tradingLock.isLocked()).toBe(true);
    tradingLock.release('A');
    expect(tradingLock.isLocked()).toBe(false);
  });

  it('30초 timeout 후 강제 release되어 새 acquire 가능 (deadlock 방어)', () => {
    jest.useFakeTimers();
    tradingLock.tryAcquire('stuck');
    expect(tradingLock.isLocked()).toBe(true);

    // 31초 경과
    jest.advanceTimersByTime(31_000);

    // 새 acquire 시도 — timeout으로 강제 해제 후 성공
    expect(tradingLock.tryAcquire('B')).toBe(true);
    tradingLock.release('B');
    jest.useRealTimers();
  });
});
```

- [ ] **Step 2: jest 실행 — RED 확인 (모듈 없음 에러)**

Run:
```bash
cd "D:/ExpressProject/Grid_project/v0-grid-tranasction-backend"
npx jest __tests__/services/stablecoin-trading-lock.test.ts 2>&1 | head -30
```
Expected: "Cannot find module '../../src/services/stablecoin-trading-lock'" 류 에러 (RED 확인)

- [ ] **Step 3: tradingLock 구현**

Create `src/services/stablecoin-trading-lock.ts`:

```typescript
/**
 * 스테이블코인 트레이딩용 process-local 메모리 mutex.
 *
 * 직접 아비트리지 executor 진입 시 acquire,
 * maker-taker live executor의 신규 PENDING 생성 시 isLocked() 확인.
 *
 * 30초 timeout으로 deadlock 방어 (이전 holder가 throw해서 안 풀린 경우).
 */

let locked = false;
let holder: string | null = null;
let acquiredAt = 0;
const MAX_HOLD_MS = 30_000;

export const tradingLock = {
  tryAcquire(by: string): boolean {
    // timeout 지난 lock은 강제 해제
    if (locked && Date.now() - acquiredAt > MAX_HOLD_MS) {
      console.warn(`[TradingLock] forced release from ${holder} (timeout > ${MAX_HOLD_MS}ms)`);
      locked = false;
      holder = null;
    }
    if (locked) return false;
    locked = true;
    holder = by;
    acquiredAt = Date.now();
    return true;
  },

  release(by: string): void {
    if (holder === by) {
      locked = false;
      holder = null;
    }
  },

  isLocked(): boolean {
    return locked;
  },

  // 테스트 전용 — runtime에서는 호출 안 함
  _reset(): void {
    locked = false;
    holder = null;
    acquiredAt = 0;
  },
};
```

- [ ] **Step 4: jest 실행 — GREEN 확인**

Run:
```bash
cd "D:/ExpressProject/Grid_project/v0-grid-tranasction-backend"
npx jest __tests__/services/stablecoin-trading-lock.test.ts 2>&1 | tail -15
```
Expected: "Tests: 4 passed, 4 total" + PASS

- [ ] **Step 5: tradingLock commit**

```bash
git add src/services/stablecoin-trading-lock.ts __tests__/services/stablecoin-trading-lock.test.ts
git commit -m "feat(stablecoin): process-local trading mutex 추가

직접 아비트리지/maker-taker live의 잔고 충돌 방지용.
- tryAcquire/release/isLocked + 30초 deadlock timeout
- 4 단위 테스트 통과 (acquire/contention/타 holder release 무시/timeout)"
```

---

## Task 4: pre-check 5단계 + 단위 테스트 (TDD)

**Files:**
- Create: `__tests__/services/stablecoin-pre-check.test.ts`
- Create: `src/services/stablecoin-pre-check.ts`

- [ ] **Step 1: 테스트 파일 작성 (5 함수 × pass/fail = 10 + runAll 1 = 11 케이스)**

Create `__tests__/services/stablecoin-pre-check.test.ts`:

```typescript
import {
  checkKillSwitch,
  checkDailyTradeLimit,
  checkDailyLossLimit,
  checkDepeg,
  checkDepthAndBalance,
  runAll,
  type PreCheckBot,
  type PreCheckOpp,
} from '../../src/services/stablecoin-pre-check';
import type { OrderbookTop } from '../../src/services/upbit-price-manager';

const baseBot: PreCheckBot = {
  id: 1,
  killSwitch: false,
  maxDailyTrades: 30,
  dailyLossLimitKrw: 50000,
  depegBps: 200,
};

const baseOpp: PreCheckOpp = {
  soldCoin: 'USDT',
  boughtCoin: 'USDC',
  bidSoldKrw: 1486,
  askBoughtKrw: 1485,
  bidSoldSize: 100,
  askBoughtSize: 100,
};

const makeBook = (bid: number, ask: number, bidSize = 100, askSize = 100): OrderbookTop => ({
  market: 'KRW-X',
  bid: { price: bid, size: bidSize },
  ask: { price: ask, size: askSize },
  timestamp: Date.now(),
});

const fiveBooks = new Map<string, OrderbookTop>([
  ['KRW-USDT', makeBook(1486, 1487)],
  ['KRW-USDC', makeBook(1485, 1486)],
  ['KRW-USD1', makeBook(1485, 1487)],
  ['KRW-USDS', makeBook(1483, 1488)],
  ['KRW-USDE', makeBook(1484, 1489)],
]);

describe('checkKillSwitch', () => {
  it('killSwitch=false → ok', () => {
    expect(checkKillSwitch(baseBot)).toEqual({ ok: true });
  });
  it('killSwitch=true → abort', () => {
    expect(checkKillSwitch({ ...baseBot, killSwitch: true })).toEqual({
      ok: false, reason: 'killswitch',
    });
  });
});

describe('checkDailyTradeLimit', () => {
  it('count < limit → ok', () => {
    expect(checkDailyTradeLimit(baseBot, 5)).toEqual({ ok: true });
  });
  it('count >= limit → abort', () => {
    expect(checkDailyTradeLimit(baseBot, 30)).toEqual({
      ok: false, reason: 'daily_limit',
    });
  });
});

describe('checkDailyLossLimit', () => {
  it('todayNetProfitKrw > -limit → ok', () => {
    expect(checkDailyLossLimit(baseBot, -1000)).toEqual({ ok: true });
  });
  it('todayNetProfitKrw <= -limit → abort', () => {
    expect(checkDailyLossLimit(baseBot, -50000)).toEqual({
      ok: false, reason: 'daily_loss_limit',
    });
  });
});

describe('checkDepeg', () => {
  it('X와 Y가 5종 mid 중간값 ±200bp 안 → ok', () => {
    // 모든 코인 mid가 1485~1486.5 범위 → 중간값 ~1486. depeg 0
    expect(checkDepeg(fiveBooks, 'USDT', 'USDC', 200)).toEqual({ ok: true });
  });
  it('X가 mid 중간값 대비 ±200bp 벗어남 → abort', () => {
    // USDT mid를 1700으로 왜곡 (중간값 1486 대비 +14% = 1400bp)
    const skewed = new Map(fiveBooks);
    skewed.set('KRW-USDT', makeBook(1699, 1701));
    expect(checkDepeg(skewed, 'USDT', 'USDC', 200)).toEqual({
      ok: false, reason: 'depeg',
    });
  });
});

describe('checkDepthAndBalance', () => {
  it('depth+balance 모두 충분 → ok', () => {
    const balance = { USDT: 100 };
    expect(checkDepthAndBalance(baseOpp, 50, balance)).toEqual({ ok: true });
  });
  it('balance 부족 → abort', () => {
    const balance = { USDT: 10 };
    expect(checkDepthAndBalance(baseOpp, 50, balance)).toEqual({
      ok: false, reason: 'insufficient',
    });
  });
});

describe('runAll', () => {
  it('모든 검사 pass → ok', () => {
    const balance = { USDT: 100 };
    const result = runAll(baseBot, baseOpp, fiveBooks, balance, {
      todayTradeCount: 5,
      todayNetProfitKrw: -1000,
    }, 50);
    expect(result).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: jest 실행 — RED 확인**

Run:
```bash
cd "D:/ExpressProject/Grid_project/v0-grid-tranasction-backend"
npx jest __tests__/services/stablecoin-pre-check.test.ts 2>&1 | head -30
```
Expected: "Cannot find module '../../src/services/stablecoin-pre-check'" 에러 (RED)

- [ ] **Step 3: pre-check 모듈 구현 (5 함수 + runAll)**

Create `src/services/stablecoin-pre-check.ts`:

```typescript
import type { OrderbookTop } from './upbit-price-manager';

/** 사전 검사 결과 */
export type PreCheckResult =
  | { ok: true }
  | { ok: false; reason: string };

/** 사전 검사에 필요한 봇 필드만 추림 (실제 StablecoinArbBot 일부) */
export interface PreCheckBot {
  id: number;
  killSwitch: boolean;
  maxDailyTrades: number;
  dailyLossLimitKrw: number;
  depegBps: number;
}

/** 사전 검사에 필요한 기회 필드만 추림 (실제 ArbOpportunity 일부) */
export interface PreCheckOpp {
  soldCoin: string;
  boughtCoin: string;
  bidSoldKrw: number;
  askBoughtKrw: number;
  bidSoldSize: number;
  askBoughtSize: number;
}

/** 1단계: kill switch */
export function checkKillSwitch(bot: PreCheckBot): PreCheckResult {
  if (bot.killSwitch) return { ok: false, reason: 'killswitch' };
  return { ok: true };
}

/** 2단계: 일일 거래 한도 */
export function checkDailyTradeLimit(
  bot: PreCheckBot,
  todayTradeCount: number,
): PreCheckResult {
  if (todayTradeCount >= bot.maxDailyTrades) {
    return { ok: false, reason: 'daily_limit' };
  }
  return { ok: true };
}

/** 3단계: 일일 손실 한도 (도달 시 auto kill switch 후속 trigger 가능) */
export function checkDailyLossLimit(
  bot: PreCheckBot,
  todayNetProfitKrw: number,
): PreCheckResult {
  if (todayNetProfitKrw <= -bot.dailyLossLimitKrw) {
    return { ok: false, reason: 'daily_loss_limit' };
  }
  return { ok: true };
}

/** 4단계: 디페그 (X와 Y가 5종 mid 중간값 ±depegBps 안) */
export function checkDepeg(
  books: ReadonlyMap<string, OrderbookTop>,
  coinX: string,
  coinY: string,
  depegBps: number,
): PreCheckResult {
  // 5종 모든 코인의 mid-price 수집
  const mids: number[] = [];
  for (const [, book] of books) {
    const mid = (book.bid.price + book.ask.price) / 2;
    if (mid > 0) mids.push(mid);
  }
  if (mids.length === 0) return { ok: false, reason: 'depeg' };

  // 중간값(median)
  const sorted = [...mids].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  // X, Y mid가 median 대비 depegBps 안인지
  const checkOne = (coin: string): boolean => {
    const book = books.get(`KRW-${coin}`);
    if (!book) return false;
    const mid = (book.bid.price + book.ask.price) / 2;
    const diffBps = Math.abs((mid / median - 1) * 10000);
    return diffBps <= depegBps;
  };

  if (!checkOne(coinX) || !checkOne(coinY)) {
    return { ok: false, reason: 'depeg' };
  }
  return { ok: true };
}

/** 5단계: 호가 깊이 + 잔고 */
export function checkDepthAndBalance(
  opp: PreCheckOpp,
  qty: number,
  balance: Record<string, number>,
): PreCheckResult {
  if (opp.bidSoldSize < qty || opp.askBoughtSize < qty) {
    return { ok: false, reason: 'insufficient' };
  }
  const balX = balance[opp.soldCoin] ?? 0;
  if (balX < qty) {
    return { ok: false, reason: 'insufficient' };
  }
  return { ok: true };
}

/** 통합 — 5단계 순차 실행 (앞 단계 abort면 즉시 return) */
export function runAll(
  bot: PreCheckBot,
  opp: PreCheckOpp,
  books: ReadonlyMap<string, OrderbookTop>,
  balance: Record<string, number>,
  todayStats: { todayTradeCount: number; todayNetProfitKrw: number },
  qty: number,
): PreCheckResult {
  const r1 = checkKillSwitch(bot);
  if (!r1.ok) return r1;

  const r2 = checkDailyTradeLimit(bot, todayStats.todayTradeCount);
  if (!r2.ok) return r2;

  const r3 = checkDailyLossLimit(bot, todayStats.todayNetProfitKrw);
  if (!r3.ok) return r3;

  const r4 = checkDepeg(books, opp.soldCoin, opp.boughtCoin, bot.depegBps);
  if (!r4.ok) return r4;

  const r5 = checkDepthAndBalance(opp, qty, balance);
  if (!r5.ok) return r5;

  return { ok: true };
}
```

- [ ] **Step 4: jest 실행 — GREEN 확인**

Run:
```bash
cd "D:/ExpressProject/Grid_project/v0-grid-tranasction-backend"
npx jest __tests__/services/stablecoin-pre-check.test.ts 2>&1 | tail -15
```
Expected: "Tests: 11 passed, 11 total" + PASS

- [ ] **Step 5: tsc 타입 검증**

Run:
```bash
cd "D:/ExpressProject/Grid_project/v0-grid-tranasction-backend"
npx tsc --noEmit
```
Expected: 에러 0개

- [ ] **Step 6: pre-check commit**

```bash
git add src/services/stablecoin-pre-check.ts __tests__/services/stablecoin-pre-check.test.ts
git commit -m "feat(stablecoin): pre-check 5단계 순수 함수 추가

직접 아비트리지/maker-taker live executor 진입 직전 안전 검사.
- checkKillSwitch / checkDailyTradeLimit / checkDailyLossLimit
- checkDepeg (5종 mid 중간값 ±depegBps)
- checkDepthAndBalance (호가 깊이 + 잔고)
- runAll 통합 (앞 단계 abort 시 즉시 return)
- 11 단위 테스트 통과"
```

---

## Task 5: PR A 생성 + 머지 + 배포 검증

**Files:** (없음 — git 작업만)

- [ ] **Step 1: 전체 jest + tsc 최종 확인**

Run:
```bash
cd "D:/ExpressProject/Grid_project/v0-grid-tranasction-backend"
npx tsc --noEmit && npx jest __tests__/services/stablecoin-trading-lock.test.ts __tests__/services/stablecoin-pre-check.test.ts 2>&1 | tail -10
```
Expected: tsc 에러 0개 + "Tests: 15 passed, 15 total" (4 lock + 11 pre-check)

- [ ] **Step 2: 브랜치 push**

```bash
cd "D:/ExpressProject/Grid_project/v0-grid-tranasction-backend"
git push -u origin feat/stablecoin-trading-pr-a
```
Expected: "branch 'feat/stablecoin-trading-pr-a' set up to track..." + push 성공

- [ ] **Step 3: PR 생성 (사용자 승인 후 머지)**

Run:
```bash
cd "D:/ExpressProject/Grid_project/v0-grid-tranasction-backend"
gh pr create --base main --head feat/stablecoin-trading-pr-a \
  --title "feat(stablecoin): PR A — pre-check + tradingLock + DB 확장 (M3 기반)" \
  --body "$(cat <<'EOF'
## 배경

스테이블코인 통합 트레이딩 (직접 아비트리지 + Maker-Taker Live) 4단계 PR 중 첫번째.
설계서: \`docs/superpowers/specs/2026-04-26-stablecoin-trading-routing-design.md\`

**실거래 코드 없음** — 가장 안전한 PR. PR B/C/D의 기반 모듈만 추가.

## 변경

### 새 파일
- \`src/services/stablecoin-trading-lock.ts\` — process-local mutex (30초 timeout)
- \`src/services/stablecoin-pre-check.ts\` — 5단계 사전 검사 순수 함수
- \`__tests__/services/stablecoin-trading-lock.test.ts\` — 4 케이스
- \`__tests__/services/stablecoin-pre-check.test.ts\` — 11 케이스

### Schema 확장
- \`StablecoinArbBot.live\` (default false)
- \`StablecoinArbTrade.krwFlowNetKrw\` (보조 통계)
- \`MakerTakerSimBot.live\` (default false)
- \`MakerTakerSimTrade.live\` + \`makerOrderUuid\`

migration: \`add_live_and_uuid\` (production은 deploy.yml로 자동 적용)

## 영향

- 기존 코드 동작 변경 없음 (신규 모듈은 import 0건)
- live 필드 default false라 PR D 전까지 기존 detection-only 흐름 유지
- 기존 시뮬 봇 영향 없음 (live=false 유지)

## Test plan

- [x] tsc --noEmit 통과
- [x] jest 15/15 통과 (lock 4 + pre-check 11)
- [ ] 머지 + 배포 후 운영 동작 변화 없음 (6 에이전트 running, errors=0 유지)
EOF
)"
```
Expected: PR URL 출력

- [ ] **Step 4: 사용자에게 PR review 요청**

사용자에게 PR 링크 보고 + review 부탁. 통과 후 다음 step.

- [ ] **Step 5: 사용자 승인 후 머지**

Run (사용자 승인 받은 후):
```bash
gh pr merge <PR번호> --squash --delete-branch
git checkout main
git pull origin main
gh run list --limit 1
```
Expected: 머지 성공 + GitHub Actions in_progress

- [ ] **Step 6: 배포 완료 대기 + 운영 동작 변화 없음 확인**

배포 ~1.5분 대기 후:
```bash
ssh -i "C:/pem/54.180.188.8.pem" -o StrictHostKeyChecking=no ubuntu@54.180.188.8 \
  "docker inspect grid-bot --format '{{.State.StartedAt}}' && curl -s http://localhost:3010/api/health"
curl -s http://54.180.188.8:3010/api/agents | python -c "
import sys, json
for a in json.load(sys.stdin)['data']:
    print('  ', a['name'], a['status'], 'errors=', a['metrics']['errors'])"
```
Expected:
- 컨테이너 새 시작 시각 (방금)
- health: status=ok
- 6 에이전트 모두 running, errors=0

- [ ] **Step 7: PR A 완료 보고**

사용자에게 머지 완료 + 다음 단계 옵션 제시:
- (a) PR B plan 작성 시작 (writing-plans 스킬 다시 호출 — arb-executor + StablecoinArbAgent 통합 + Admin API/UI)
- (b) 다른 작업 (stage 3 분석 등)

---

## Self-Review

### 1. Spec coverage

| Spec 섹션 | Plan task |
|---|---|
| §2.1 새 파일 (4개 중 2개: lock, pre-check) | Task 3, 4 |
| §5 Pre-check 5단계 | Task 4 (Step 3 구현) |
| §6 Trading Lock 30초 timeout | Task 3 (Step 3 구현) |
| §9 DB 스키마 (4 테이블 + PARTIAL_HOLD) | Task 1, 2 |
| §13 PR A 범위 (pre-check + lock + DB schema) | Task 1~5 전체 |

**미커버 (PR B/C/D로 위임)**:
- §3 직접 arb executor → PR B
- §4 Maker-Taker live executor → PR C
- §7 Auto kill switch → PR B/C에서 통합
- §8 Canary → PR D
- §10 Admin API → PR B/C/D 분산
- §11 Admin UI → PR B/C/D 분산
- §12 통합/E2E 테스트 → PR B/C/D 분산
- PARTIAL_HOLD enum 추가 → PR C (live executor 도입 시 필요해짐. status는 String 타입이라 enum 변경 불필요)

### 2. Placeholder scan

- "TBD" / "TODO" / "implement later": 0건
- "Add appropriate error handling": 0건
- 모든 코드 step에 완전한 코드 블록 포함 ✅
- 모든 명령어 expected output 명시 ✅

### 3. Type consistency

- `PreCheckBot.killSwitch` → 테스트와 구현 일치 ✅
- `PreCheckOpp.bidSoldSize/askBoughtSize` → ArbOpportunity와 일치 (spec §3.1) ✅
- `tradingLock.tryAcquire(by: string)` → 테스트와 구현 일치 ✅
- `OrderbookTop` import → 기존 `upbit-price-manager.ts` export와 일치 ✅
- `runAll(bot, opp, books, balance, todayStats, qty)` 순서 → 테스트와 구현 일치 ✅

### 4. 트랩 회피 명시

- Prisma migrate CLI garbage (트랩 #0): Task 2 Step 2에 `tail -15` 검사 명시 ✅
- 별도 process module-state 격리 (세션 9~10 트랩): 본 PR엔 module-state 진단 코드 없음, 해당 없음
- mock vs 실제 시그니처 mismatch (트랩 #3): 본 PR은 mock 안 씀 (순수 함수만 테스트), 해당 없음

---

## 다음 단계

PR A 머지 후 별도 brainstorming/writing-plans 사이클 (PR B):
- 범위: arb-executor (직접 아비트리지) + StablecoinArbAgent 통합 + Admin API (live 토글, Stage 승급)
- 위험도: 중 (live=false 기본이라 실행 안 됨)
- 예상 task: 8~12개
