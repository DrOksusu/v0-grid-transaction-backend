# PR B 구현 계획: arb-executor + StablecoinArbAgent 통합 + Admin API/UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 직접 아비트리지 executor 도입 + StablecoinArbAgent에 routing 통합 (PR A의 pre-check + tradingLock 활용) + Admin에서 live 토글 / Stage 승급 가능. **`live=false` default로 머지** (실거래 가동은 PR D Canary에서).

**Architecture:** PR A에서 만든 `pre-check` + `tradingLock` 위에 `arb-executor` 모듈 신규. Agent의 evaluate 함수가 `bot.live=true`일 때만 executor 호출. 기존 detection-only 흐름 유지. Admin API 2개 + UI 토글 추가.

**Tech Stack:** TypeScript, Prisma (stablecoin DB), Jest, ts-jest, Express, Next.js (frontend)

---

## File Structure

| 종류 | 경로 | 책임 |
|---|---|---|
| Create | `src/services/stablecoin-arb-executor.ts` | `executeArbitrage(opp, bot, balance, creds)` — Leg-1/Leg-2/fallback + P&L 계산 |
| Create | `__tests__/services/stablecoin-arb-executor.test.ts` | mock UpbitService로 5+ 시나리오 |
| Modify | `src/services/stablecoin-arb.service.ts` | `getTodayStats(botId)`, `recordTrade(...)`, `setLive(...)`, `setStage(...)` 추가 |
| Modify | `src/agents/stablecoin-arb-agent.ts` | evaluate에 live=true 분기 + tradingLock + preCheck.runAll + executor 호출 |
| Modify | `src/controllers/stablecoin-admin.controller.ts` | `postLive`, `postStage` endpoint + `getBot` 응답에 live 포함 |
| Modify | `src/routes/<stablecoin-admin route>` (위치 확인 필요) | 신규 endpoint 라우팅 등록 |
| Modify | `__tests__/controllers/stablecoin-admin.controller.test.ts` | postLive / postStage 테스트 추가 |
| Modify | `v0-grid-transaction-frontend/lib/api.ts` | `setStablecoinBotLive`, `setStablecoinBotStage` 함수 |
| Modify | `v0-grid-transaction-frontend/app/admin/stablecoin/_components/BotStatusCard.tsx` | live 토글 (큰 confirm dialog) + Stage 표시 + 승급 버튼 |

기존 활용:
- `tradingLock` (PR A) — executor 진입 전 acquire, 끝나면 release
- `preCheck.runAll` (PR A) — executor 호출 직전
- `UpbitService.placeBestIoc` (M1 검증) — Leg-1/Leg-2 주문
- `UpbitService.getAccounts` — 잔고 조회 (5초 캐시)
- `arbService.logOpportunity` (기존) — Opportunity 기록
- `credentialService` (기존 패턴) — 사용자 Upbit credential 복호화

---

## Task 1: stablecoin-arb.service에 헬퍼 함수 추가

**Files:**
- Modify: `src/services/stablecoin-arb.service.ts`

- [ ] **Step 1: getTodayStats 함수 추가**

`stablecoin-arb.service.ts` 끝에 추가:

```typescript
/**
 * 오늘 0시 KST 이후 봇 거래 통계 — preCheck.runAll에 전달
 *
 * @returns todayTradeCount: COMPLETED/FAILED/ROLLED_BACK 모두 포함
 * @returns todayNetProfitKrw: krwFlowNetKrw 합 (자산 변환 무시한 보수적 net)
 */
export async function getTodayStats(botId: number): Promise<{
  todayTradeCount: number;
  todayNetProfitKrw: number;
}> {
  // KST 자정 (UTC+9)
  const now = new Date();
  const kstMidnight = new Date(now);
  kstMidnight.setUTCHours(15, 0, 0, 0); // UTC 15:00 = KST 0:00
  if (kstMidnight > now) kstMidnight.setUTCDate(kstMidnight.getUTCDate() - 1);

  const trades = await prisma.stablecoinArbTrade.findMany({
    where: {
      botId,
      detectedAt: { gte: kstMidnight },
    },
    select: { krwFlowNetKrw: true, status: true },
  });

  const todayTradeCount = trades.length;
  const todayNetProfitKrw = trades.reduce(
    (s, t) => s + (t.krwFlowNetKrw ? Number(t.krwFlowNetKrw) : 0),
    0,
  );

  return { todayTradeCount, todayNetProfitKrw };
}
```

- [ ] **Step 2: setLive 함수 추가**

```typescript
/**
 * StablecoinArbBot.live 토글 (Admin 전용).
 * live=true 전환은 큰 영향 → confirm body 필수 (controller에서 검증).
 */
export async function setLive(userId: number, live: boolean) {
  return updateBotConfig(userId, { live });
}
```

- [ ] **Step 3: setStage 함수 추가**

```typescript
/**
 * Canary Stage 1/2/3 일괄 적용 (Admin 전용).
 * Stage 1 = 1만원/일3건/손실 1만원, Stage 2 = 2만원/일10건/손실 3만원, Stage 3 = 5만원/일30건/손실 5만원.
 */
export type CanaryStage = 1 | 2 | 3;

const STAGE_VALUES: Record<CanaryStage, {
  tradeSizeKrw: number;
  maxDailyTrades: number;
  dailyLossLimitKrw: number;
}> = {
  1: { tradeSizeKrw: 10000, maxDailyTrades: 3, dailyLossLimitKrw: 10000 },
  2: { tradeSizeKrw: 20000, maxDailyTrades: 10, dailyLossLimitKrw: 30000 },
  3: { tradeSizeKrw: 50000, maxDailyTrades: 30, dailyLossLimitKrw: 50000 },
};

export async function setStage(userId: number, stage: CanaryStage) {
  return updateBotConfig(userId, STAGE_VALUES[stage]);
}
```

- [ ] **Step 4: 헬퍼 함수 단위 테스트 작성 (선택, integration이 더 가치)**

본 task는 service layer 직접 테스트보다 controller/agent 통합 테스트로 커버. tsc 통과만 확인:

Run: `cd "D:/ExpressProject/Grid_project/v0-grid-tranasction-backend" && npx tsc --noEmit`
Expected: 에러 0개

- [ ] **Step 5: commit**

```bash
git checkout -b feat/stablecoin-trading-pr-b
git add src/services/stablecoin-arb.service.ts
git commit -m "feat(stablecoin): arb.service에 getTodayStats / setLive / setStage 추가

PR B 기반:
- getTodayStats: KST 오늘 0시 이후 거래 수 + krwFlowNet 합 (preCheck용)
- setLive: live 토글 (false default → M3 가동 시 true)
- setStage: Canary Stage 1/2/3 일괄 적용 (tradeSize/maxDailyTrades/dailyLossLimit)"
```

---

## Task 2: stablecoin-arb-executor 구현 (TDD)

**Files:**
- Create: `__tests__/services/stablecoin-arb-executor.test.ts`
- Create: `src/services/stablecoin-arb-executor.ts`

- [ ] **Step 1: 테스트 파일 작성 (5 케이스)**

Create `__tests__/services/stablecoin-arb-executor.test.ts`:

```typescript
import { executeArbitrage, type ExecutorResult } from '../../src/services/stablecoin-arb-executor';

// UpbitService mock interface
interface MockUpbit {
  placeBestIoc: jest.Mock;
}

const baseBot = {
  id: 1,
  tradeSizeKrw: 10000,
};

const baseOpp = {
  soldCoin: 'USDT',
  boughtCoin: 'USDC',
  bidSoldKrw: 1486,
  askBoughtKrw: 1485,
  bidSoldSize: 100,
  askBoughtSize: 100,
  spreadBps: 6,
  detectedAt: Date.now(),
};

const baseBalance = { USDT: 100, USDC: 50, USD1: 30 };

const baseBooks = new Map([
  ['KRW-USDT', { market: 'KRW-USDT', bid: { price: 1486, size: 100 }, ask: { price: 1487, size: 100 }, timestamp: 0 }],
  ['KRW-USDC', { market: 'KRW-USDC', bid: { price: 1485, size: 100 }, ask: { price: 1486, size: 100 }, timestamp: 0 }],
]);

function makeUpbit(): MockUpbit {
  return { placeBestIoc: jest.fn() };
}

describe('executeArbitrage', () => {
  it('정상 흐름: leg-1 + leg-2 모두 체결 → ok + markToMarketNet 양수', async () => {
    const upbit = makeUpbit();
    // leg-1: USDT 6.73 매도 → 10000 KRW (수수료 5)
    upbit.placeBestIoc.mockResolvedValueOnce({
      uuid: 'l1', state: 'done', executed_volume: '6.73',
      trades: [{ funds: '10000' }], paid_fee: '5',
    });
    // leg-2: 9995 KRW로 USDC 6.73 매수 (수수료 5)
    upbit.placeBestIoc.mockResolvedValueOnce({
      uuid: 'l2', state: 'cancel', executed_volume: '6.7300',
      trades: [{ funds: '9995' }], paid_fee: '5',
    });

    const result = await executeArbitrage(baseOpp, baseBot, baseBalance, baseBooks, upbit);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.legA.uuid).toBe('l1');
      expect(result.legB.uuid).toBe('l2');
      expect(result.markToMarketNet).toBeGreaterThan(-50); // 수수료 10 이내 손실 또는 흑자
    }
  });

  it('leg-1 zero fill → FAILED, leg-2 호출 안 됨', async () => {
    const upbit = makeUpbit();
    upbit.placeBestIoc.mockResolvedValueOnce({
      uuid: 'l1', state: 'cancel', executed_volume: '0',
      trades: [], paid_fee: '0',
    });

    const result = await executeArbitrage(baseOpp, baseBot, baseBalance, baseBooks, upbit);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/leg-1 zero/);
    }
    expect(upbit.placeBestIoc).toHaveBeenCalledTimes(1);
  });

  it('leg-2 zero → fallback (받은 KRW로 X 재매수), rolledBack=true', async () => {
    const upbit = makeUpbit();
    // leg-1: 매도 성공
    upbit.placeBestIoc.mockResolvedValueOnce({
      uuid: 'l1', state: 'done', executed_volume: '6.73',
      trades: [{ funds: '10000' }], paid_fee: '5',
    });
    // leg-2: 매수 실패
    upbit.placeBestIoc.mockResolvedValueOnce({
      uuid: 'l2', state: 'cancel', executed_volume: '0',
      trades: [], paid_fee: '0',
    });
    // fallback: X(USDT) 재매수 성공
    upbit.placeBestIoc.mockResolvedValueOnce({
      uuid: 'fb', state: 'cancel', executed_volume: '6.7',
      trades: [{ funds: '9990' }], paid_fee: '5',
    });

    const result = await executeArbitrage(baseOpp, baseBot, baseBalance, baseBooks, upbit);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/leg-2/);
      expect(result.rolledBack).toBe(true);
    }
    expect(upbit.placeBestIoc).toHaveBeenCalledTimes(3);
  });

  it('부분 체결: leg-1 50% 체결 → leg-2도 받은 KRW에 비례 축소', async () => {
    const upbit = makeUpbit();
    // leg-1: 50% 체결 (3.36 USDT, 4995 KRW)
    upbit.placeBestIoc.mockResolvedValueOnce({
      uuid: 'l1', state: 'cancel', executed_volume: '3.36',
      trades: [{ funds: '4995' }], paid_fee: '2.5',
    });
    // leg-2: leg-1 받은 KRW로 매수
    upbit.placeBestIoc.mockResolvedValueOnce({
      uuid: 'l2', state: 'cancel', executed_volume: '3.36',
      trades: [{ funds: '4990' }], paid_fee: '2.5',
    });

    const result = await executeArbitrage(baseOpp, baseBot, baseBalance, baseBooks, upbit);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // leg-2 호출 시 buyKrw = 4995 - 2.5 = 4992.5
      const leg2Call = upbit.placeBestIoc.mock.calls[1];
      expect(leg2Call[1]).toBe('bid');
      expect(parseFloat(leg2Call[2].price)).toBeCloseTo(4992.5, 0);
    }
  });

  it('수수료 파싱: paid_fee 누락 시 0으로 fallback', async () => {
    const upbit = makeUpbit();
    upbit.placeBestIoc.mockResolvedValueOnce({
      uuid: 'l1', state: 'done', executed_volume: '6.73',
      trades: [{ funds: '10000' }],
      // paid_fee 필드 누락
    });
    upbit.placeBestIoc.mockResolvedValueOnce({
      uuid: 'l2', state: 'cancel', executed_volume: '6.73',
      trades: [{ funds: '10000' }],
    });

    const result = await executeArbitrage(baseOpp, baseBot, baseBalance, baseBooks, upbit);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.totalFeeKrw).toBe(0);
    }
  });
});
```

- [ ] **Step 2: jest 실행 — RED 확인**

Run:
```bash
cd "D:/ExpressProject/Grid_project/v0-grid-tranasction-backend"
npx jest __tests__/services/stablecoin-arb-executor.test.ts 2>&1 | head -10
```
Expected: "Cannot find module '../../src/services/stablecoin-arb-executor'" 에러

- [ ] **Step 3: executor 구현**

Create `src/services/stablecoin-arb-executor.ts`:

```typescript
import type { ArbOpportunity } from './stablecoin-arb-detector';
import type { OrderbookTop } from './upbit-price-manager';

/** UpbitService의 placeBestIoc 시그니처를 mock 가능하게 분리 */
export interface IocClient {
  placeBestIoc(
    market: string,
    side: 'bid' | 'ask',
    params: { price?: string; volume?: string },
  ): Promise<UpbitOrderResp>;
}

export interface UpbitOrderResp {
  uuid: string;
  state: string;
  executed_volume: string;
  trades?: Array<{ funds: string }>;
  paid_fee?: string;
}

export interface LegResult {
  uuid: string;
  filledVol: number;
  filledKrw: number;
  feeKrw: number;
}

export type ExecutorResult =
  | {
      ok: true;
      markToMarketNet: number;
      krwFlowNet: number;
      realizedSpreadBps: number;
      totalFeeKrw: number;
      legA: LegResult;
      legB: LegResult;
    }
  | {
      ok: false;
      reason: string;
      rolledBack?: boolean;
      legA?: LegResult;
      legB?: LegResult;
    };

const MIN_QTY = 0.0001;

/**
 * 직접 아비트리지 실행 (Leg-1 매도 X → Leg-2 매수 Y).
 *
 * 사전 조건 (호출자가 보장):
 *  - tradingLock 점유 상태
 *  - preCheck.runAll 통과
 *
 * @param opp findBestOpportunity 결과
 * @param bot StablecoinArbBot의 일부 (id, tradeSizeKrw)
 * @param balance 현재 잔고 (코인별 수량)
 * @param books 호가 스냅샷 (mark-to-market net 계산용)
 * @param upbit Upbit IOC 클라이언트 (의존성 주입 — 테스트 mock 가능)
 */
export async function executeArbitrage(
  opp: ArbOpportunity,
  bot: { id: number; tradeSizeKrw: number },
  balance: Record<string, number>,
  books: ReadonlyMap<string, OrderbookTop>,
  upbit: IocClient,
): Promise<ExecutorResult> {
  // 1. 거래량 결정
  const qtyByDepth = Math.min(opp.bidSoldSize, opp.askBoughtSize);
  const qtyByBudget = bot.tradeSizeKrw / opp.askBoughtKrw;
  const qtyByBalance = balance[opp.soldCoin] ?? 0;
  const qty = Math.min(qtyByDepth, qtyByBudget, qtyByBalance);
  if (qty < MIN_QTY) {
    return { ok: false, reason: 'qty too small' };
  }

  // 2. Leg-1: best+ioc 매도 X
  const leg1Resp = await upbit.placeBestIoc(
    `KRW-${opp.soldCoin}`,
    'ask',
    { volume: qty.toFixed(8) },
  );
  const filledQtyL1 = parseFloat(leg1Resp.executed_volume || '0');
  const filledKrwL1 = (leg1Resp.trades || []).reduce(
    (s, t) => s + parseFloat(t.funds),
    0,
  );
  const paidFeeL1 = parseFloat(leg1Resp.paid_fee || '0');
  const legA: LegResult = {
    uuid: leg1Resp.uuid,
    filledVol: filledQtyL1,
    filledKrw: filledKrwL1,
    feeKrw: paidFeeL1,
  };

  if (filledQtyL1 === 0) {
    return { ok: false, reason: 'leg-1 zero fill', legA };
  }

  // 3. Leg-2: 받은 KRW로 best+ioc 매수 Y
  const buyKrw = filledKrwL1 - paidFeeL1;
  const leg2Resp = await upbit.placeBestIoc(
    `KRW-${opp.boughtCoin}`,
    'bid',
    { price: buyKrw.toFixed(2) },
  );
  const filledQtyL2 = parseFloat(leg2Resp.executed_volume || '0');
  const filledKrwL2 = (leg2Resp.trades || []).reduce(
    (s, t) => s + parseFloat(t.funds),
    0,
  );
  const paidFeeL2 = parseFloat(leg2Resp.paid_fee || '0');
  const legB: LegResult = {
    uuid: leg2Resp.uuid,
    filledVol: filledQtyL2,
    filledKrw: filledKrwL2,
    feeKrw: paidFeeL2,
  };

  if (filledQtyL2 === 0) {
    // 4. Fallback: 받은 KRW로 X 재매수 (원위치 복구)
    await upbit.placeBestIoc(
      `KRW-${opp.soldCoin}`,
      'bid',
      { price: buyKrw.toFixed(2) },
    );
    return {
      ok: false,
      reason: 'leg-2 zero fill, recovered to X',
      rolledBack: true,
      legA,
      legB,
    };
  }

  // 5. P&L 계산
  const totalFeeKrw = paidFeeL1 + paidFeeL2;
  const krwFlowNet = filledKrwL1 - filledKrwL2 - totalFeeKrw;

  const bookX = books.get(`KRW-${opp.soldCoin}`);
  const bookY = books.get(`KRW-${opp.boughtCoin}`);
  const midX = bookX ? (bookX.bid.price + bookX.ask.price) / 2 : opp.bidSoldKrw;
  const midY = bookY ? (bookY.bid.price + bookY.ask.price) / 2 : opp.askBoughtKrw;
  const markToMarketNet =
    filledQtyL2 * midY - filledQtyL1 * midX - totalFeeKrw;

  const realizedSpreadBps = Math.floor(
    (opp.bidSoldKrw / opp.askBoughtKrw - 1) * 10000,
  );

  return {
    ok: true,
    markToMarketNet,
    krwFlowNet,
    realizedSpreadBps,
    totalFeeKrw,
    legA,
    legB,
  };
}
```

- [ ] **Step 4: jest GREEN 확인**

Run:
```bash
cd "D:/ExpressProject/Grid_project/v0-grid-tranasction-backend"
npx jest __tests__/services/stablecoin-arb-executor.test.ts 2>&1 | tail -15
```
Expected: "Tests: 5 passed, 5 total"

- [ ] **Step 5: tsc + commit**

```bash
npx tsc --noEmit
git add src/services/stablecoin-arb-executor.ts __tests__/services/stablecoin-arb-executor.test.ts
git commit -m "feat(stablecoin): 직접 아비트리지 executor 추가

leg-1(X 매도) + leg-2(Y 매수) + fallback(받은 KRW로 X 재매수).
P&L 두 값 추적: markToMarketNet (주, 자산 변환 포함) + krwFlowNet (보조).
의존성 주입(IocClient)로 mock 테스트 가능.

5 단위 테스트:
- 정상 양 leg 체결
- leg-1 zero fill (leg-2 호출 안 됨)
- leg-2 zero fill (fallback 실행, rolledBack=true)
- 부분 체결 (leg-2 buyKrw = leg-1 받은 KRW - 수수료)
- paid_fee 누락 시 0 fallback"
```

---

## Task 3: balance 캐시 모듈

**Files:**
- Create: `src/services/upbit-balance-cache.ts`
- Create: `__tests__/services/upbit-balance-cache.test.ts`

- [ ] **Step 1: 테스트 작성 (3 케이스)**

Create `__tests__/services/upbit-balance-cache.test.ts`:

```typescript
import { BalanceCache } from '../../src/services/upbit-balance-cache';

describe('BalanceCache', () => {
  it('첫 호출은 fetcher 호출, 두번째 호출은 캐시 반환', async () => {
    const fetcher = jest.fn().mockResolvedValue([
      { currency: 'USDT', balance: '10', locked: '0' },
    ]);
    const cache = new BalanceCache({ ttlMs: 5000, fetcher });

    const r1 = await cache.get();
    const r2 = await cache.get();

    expect(r1).toEqual({ USDT: 10 });
    expect(r2).toEqual({ USDT: 10 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('TTL 경과 후 fetcher 재호출', async () => {
    const fetcher = jest.fn().mockResolvedValue([{ currency: 'USDT', balance: '5', locked: '0' }]);
    const cache = new BalanceCache({ ttlMs: 5000, fetcher });

    jest.useFakeTimers();
    await cache.get();
    jest.advanceTimersByTime(5001);
    await cache.get();
    jest.useRealTimers();

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('invalidate 호출 시 즉시 만료', async () => {
    const fetcher = jest.fn().mockResolvedValue([{ currency: 'USDT', balance: '5', locked: '0' }]);
    const cache = new BalanceCache({ ttlMs: 5000, fetcher });

    await cache.get();
    cache.invalidate();
    await cache.get();

    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: jest RED 확인**

Run: `npx jest __tests__/services/upbit-balance-cache.test.ts 2>&1 | head -10`

- [ ] **Step 3: 구현**

Create `src/services/upbit-balance-cache.ts`:

```typescript
/**
 * Upbit 잔고 캐시 — rate limit 방지 + 거래 직후 invalidate.
 *
 * Upbit getAccounts 응답 형식:
 *   [{ currency: 'USDT', balance: '10.5', locked: '0' }, ...]
 *
 * 캐시는 { [currency]: number } 형태로 변환 (locked 제외, available만).
 */

interface AccountRow {
  currency: string;
  balance: string;
  locked: string;
}

export class BalanceCache {
  private ttlMs: number;
  private fetcher: () => Promise<AccountRow[]>;
  private cached: Record<string, number> | null = null;
  private cachedAt = 0;

  constructor(opts: { ttlMs: number; fetcher: () => Promise<AccountRow[]> }) {
    this.ttlMs = opts.ttlMs;
    this.fetcher = opts.fetcher;
  }

  async get(): Promise<Record<string, number>> {
    if (this.cached && Date.now() - this.cachedAt < this.ttlMs) {
      return this.cached;
    }
    const rows = await this.fetcher();
    const map: Record<string, number> = {};
    for (const row of rows) {
      map[row.currency] = parseFloat(row.balance);
    }
    this.cached = map;
    this.cachedAt = Date.now();
    return map;
  }

  invalidate(): void {
    this.cached = null;
    this.cachedAt = 0;
  }
}
```

- [ ] **Step 4: jest GREEN 확인**

Run: `npx jest __tests__/services/upbit-balance-cache.test.ts 2>&1 | tail -10`
Expected: "Tests: 3 passed, 3 total"

- [ ] **Step 5: commit**

```bash
git add src/services/upbit-balance-cache.ts __tests__/services/upbit-balance-cache.test.ts
git commit -m "feat(stablecoin): Upbit 잔고 캐시 (5초 TTL + invalidate)

executor 진입 시 잔고 조회 → 매번 API 호출하면 rate limit.
TTL 캐시 + 거래 직후 invalidate로 fresh-on-demand.
3 단위 테스트 (캐시 hit / TTL 만료 / invalidate)"
```

---

## Task 4: StablecoinArbAgent.evaluate 통합

**Files:**
- Modify: `src/agents/stablecoin-arb-agent.ts`

- [ ] **Step 1: import 추가**

`stablecoin-arb-agent.ts` 상단 import 블록에 추가:

```typescript
import { tradingLock } from '../services/stablecoin-trading-lock';
import { runAll as preCheckAll } from '../services/stablecoin-pre-check';
import { executeArbitrage } from '../services/stablecoin-arb-executor';
import { BalanceCache } from '../services/upbit-balance-cache';
import { UpbitService } from '../services/upbit.service';
import { getCredentials } from '../services/credential.service'; // 위치 확인 필요
import { ArbTradeStatus } from '.prisma/client-stablecoin';
```

(credential 서비스 위치는 코드베이스 확인 후 정정 — `src/services/credential.service.ts` 또는 `src/utils/credential-helper.ts`)

- [ ] **Step 2: balanceCache 인스턴스 멤버 추가 + onStart에서 초기화**

class StablecoinArbAgent에 추가:

```typescript
  private balanceCache: BalanceCache | null = null;
  private upbitClient: UpbitService | null = null;
```

`onStart` 끝에 추가 (subscribe + listener 등록 후):

```typescript
    // live 거래용 Upbit 클라이언트 + 잔고 캐시 lazy init은 첫 evaluate에서.
    // 여기서 안 함 — credential은 봇별일 수 있어 evaluate 안에서.
```

- [ ] **Step 3: evaluate 함수 전면 교체**

기존 evaluate를 다음으로 교체 (주석 포함):

```typescript
  private async evaluate(): Promise<void> {
    if (this.evaluateInFlight) return;
    this.evaluateInFlight = true;

    try {
      const bots = await prisma.stablecoinArbBot.findMany({
        where: { enabled: true, killSwitch: false },
      });
      if (bots.length === 0) return;

      const books = getAllStablecoinOrderbooks();

      for (const bot of bots) {
        const coinsEnabled = (bot.coinsEnabled as string[]) || [];
        if (coinsEnabled.length < 2) continue;

        const opp = findBestOpportunity(books, coinsEnabled, bot.entryThresholdBps);
        if (!opp) continue;

        // M2: detection-only — 기존 흐름
        if (!bot.live) {
          try {
            await arbService.logOpportunity({
              botId: bot.id,
              detectedAt: new Date(opp.detectedAt),
              soldCoin: opp.soldCoin,
              boughtCoin: opp.boughtCoin,
              bidSoldKrw: opp.bidSoldKrw,
              askBoughtKrw: opp.askBoughtKrw,
              spreadBps: opp.spreadBps,
              executed: false,
              skipReason: 'detection_only_mode',
            });
          } catch (err: any) {
            console.error(`[StablecoinArbAgent] bot ${bot.id} logOpportunity 실패:`, err.message);
          }
          continue;
        }

        // M3: live 거래 흐름
        const lockHolder = `arb-bot-${bot.id}`;
        if (!tradingLock.tryAcquire(lockHolder)) {
          // 다른 거래 진행 중 → 이번 update skip (다음 호가에서 재시도)
          continue;
        }

        try {
          // pre-check 진입
          const balance = await this.getBalanceFor(bot.userId);
          const todayStats = await arbService.getTodayStats(bot.id);
          const qtyByBudget = bot.tradeSizeKrw / opp.askBoughtKrw;
          const qty = Math.min(opp.bidSoldSize, opp.askBoughtSize, qtyByBudget);

          const pre = preCheckAll(
            {
              id: bot.id,
              killSwitch: bot.killSwitch,
              maxDailyTrades: bot.maxDailyTrades,
              dailyLossLimitKrw: bot.dailyLossLimitKrw,
              depegBps: bot.depegBps,
            },
            opp,
            books,
            balance,
            todayStats,
            qty,
          );

          if (!pre.ok) {
            await arbService.logOpportunity({
              botId: bot.id, detectedAt: new Date(opp.detectedAt),
              soldCoin: opp.soldCoin, boughtCoin: opp.boughtCoin,
              bidSoldKrw: opp.bidSoldKrw, askBoughtKrw: opp.askBoughtKrw,
              spreadBps: opp.spreadBps,
              executed: false, skipReason: pre.reason,
            });
            continue;
          }

          // executor 실행
          const upbit = this.upbitClient!;  // getBalanceFor에서 init 보장
          const result = await executeArbitrage(opp, bot, balance, books, upbit);

          // 잔고 캐시 invalidate (거래 직후 fresh)
          this.balanceCache?.invalidate();

          // Trade row 기록
          await this.recordTradeFromResult(bot.id, opp, result);

          // Bot 통계 업데이트
          if (result.ok) {
            await prisma.stablecoinArbBot.update({
              where: { id: bot.id },
              data: {
                totalTrades: { increment: 1 },
                lastExecutedAt: new Date(),
                // totalProfitUsd 업데이트는 환율 모듈 도입 후 (PR D 또는 별도)
              },
            });
          }
        } finally {
          tradingLock.release(lockHolder);
        }
      }
    } catch (err: any) {
      this.metrics.errors++;
      this.metrics.lastError = err.message;
      console.error('[StablecoinArbAgent] evaluate error:', err.message);
    } finally {
      this.evaluateInFlight = false;
    }
  }

  /** 사용자별 잔고 캐시 (process-local, 봇 1명당 1 클라이언트로 lazy init) */
  private async getBalanceFor(userId: number): Promise<Record<string, number>> {
    if (!this.upbitClient) {
      const creds = await getCredentials(userId, 'upbit');  // 시그니처 확인 필요
      this.upbitClient = new UpbitService(creds);
    }
    if (!this.balanceCache) {
      this.balanceCache = new BalanceCache({
        ttlMs: 5000,
        fetcher: () => this.upbitClient!.getAccounts(),
      });
    }
    return await this.balanceCache.get();
  }

  /** ExecutorResult를 StablecoinArbTrade row로 기록 */
  private async recordTradeFromResult(
    botId: number,
    opp: ReturnType<typeof findBestOpportunity> & {} extends infer T ? T : never,
    result: Awaited<ReturnType<typeof executeArbitrage>>,
  ): Promise<void> {
    if (!opp) return;
    const baseData = {
      botId,
      soldCoin: opp.soldCoin,
      boughtCoin: opp.boughtCoin,
      detectedAt: new Date(opp.detectedAt),
      bidSoldKrw: opp.bidSoldKrw,
      askBoughtKrw: opp.askBoughtKrw,
      expectedSpreadBps: opp.spreadBps,
      plannedSizeCoin: 0,  // qty는 executor 안에서 결정 — 별도 추적은 추후
    };

    if (result.ok) {
      await prisma.stablecoinArbTrade.create({
        data: {
          ...baseData,
          status: ArbTradeStatus.COMPLETED,
          leg1OrderUuid: result.legA.uuid,
          leg1FilledVol: result.legA.filledVol,
          leg1ReceivedKrw: result.legA.filledKrw,
          leg1FeeKrw: result.legA.feeKrw,
          leg1CompletedAt: new Date(),
          leg2OrderUuid: result.legB.uuid,
          leg2FilledVol: result.legB.filledVol,
          leg2SpentKrw: result.legB.filledKrw,
          leg2FeeKrw: result.legB.feeKrw,
          leg2CompletedAt: new Date(),
          realizedSpreadBps: result.realizedSpreadBps,
          krwFlowNetKrw: result.krwFlowNet,
          totalFeeKrw: result.totalFeeKrw,
          completedAt: new Date(),
        },
      });
    } else if (result.rolledBack) {
      await prisma.stablecoinArbTrade.create({
        data: {
          ...baseData,
          status: ArbTradeStatus.FALLBACK_DONE,
          leg1OrderUuid: result.legA?.uuid ?? null,
          leg1FilledVol: result.legA?.filledVol ?? null,
          leg1ReceivedKrw: result.legA?.filledKrw ?? null,
          leg1FeeKrw: result.legA?.feeKrw ?? null,
          leg2OrderUuid: result.legB?.uuid ?? null,
          leg2FilledVol: result.legB?.filledVol ?? null,
          error: result.reason,
          completedAt: new Date(),
        },
      });
    } else {
      await prisma.stablecoinArbTrade.create({
        data: {
          ...baseData,
          status: ArbTradeStatus.FAILED,
          leg1OrderUuid: result.legA?.uuid ?? null,
          leg1FilledVol: result.legA?.filledVol ?? null,
          error: result.reason,
          completedAt: new Date(),
        },
      });
    }
  }
```

- [ ] **Step 4: tsc 통과 확인**

Run: `npx tsc --noEmit 2>&1 | head -20`

만약 에러 발생 시:
- `getCredentials` import 경로 — `grep -r "export.*getCredentials\|getCredentialsFor" src/`로 정확한 위치 확인
- 시그니처 mismatch — credential service 코드 확인

해결 후 GREEN.

- [ ] **Step 5: commit**

```bash
git add src/agents/stablecoin-arb-agent.ts
git commit -m "feat(stablecoin): StablecoinArbAgent에 live 거래 routing 추가

bot.live=false: 기존 detection-only 흐름 유지
bot.live=true: tradingLock + preCheck + executor + Trade 기록
- balanceCache 5초 TTL + 거래 직후 invalidate
- ExecutorResult → ArbTradeStatus.COMPLETED/FALLBACK_DONE/FAILED 매핑"
```

---

## Task 5: Admin API — live 토글 + Stage 승급

**Files:**
- Modify: `src/controllers/stablecoin-admin.controller.ts`
- Modify: `src/routes/stablecoin-admin.ts` (위치 확인 필요 — `grep -r "/api/admin/stablecoin" src/routes/`)
- Modify: `__tests__/controllers/stablecoin-admin.controller.test.ts`

- [ ] **Step 1: postLive endpoint 추가**

`stablecoin-admin.controller.ts` 끝에 추가:

```typescript
/**
 * POST /api/admin/stablecoin/bot/live
 * Body: { live: boolean, confirm?: 'I_UNDERSTAND_LIVE_TRADING' }
 *
 * live=true 전환은 실거래 시작 → confirm 필수.
 */
export const postLive = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const live = req.body?.live;
    const confirm = req.body?.confirm;

    if (typeof live !== 'boolean') {
      throw new AppError('Invalid body: live must be boolean', 400);
    }
    if (live && confirm !== 'I_UNDERSTAND_LIVE_TRADING') {
      throw new AppError('live=true requires confirm: "I_UNDERSTAND_LIVE_TRADING"', 400);
    }

    const updated = await arbService.setLive(userId, live);
    res.json({
      ...updated,
      totalProfitUsd: updated.totalProfitUsd.toString(),
      perCoinMinUsd: updated.perCoinMinUsd.toString(),
      perCoinMaxUsd: updated.perCoinMaxUsd.toString(),
    });
  } catch (error: any) {
    if (error.code === 'P2025') return next(new AppError('Bot not found', 404));
    next(error);
  }
};
```

- [ ] **Step 2: postStage endpoint 추가**

```typescript
/**
 * POST /api/admin/stablecoin/bot/stage
 * Body: { stage: 1 | 2 | 3 }
 */
export const postStage = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const stage = req.body?.stage;
    if (![1, 2, 3].includes(stage)) {
      throw new AppError('Invalid body: stage must be 1, 2, or 3', 400);
    }

    const updated = await arbService.setStage(userId, stage as 1 | 2 | 3);
    res.json({
      ...updated,
      totalProfitUsd: updated.totalProfitUsd.toString(),
      perCoinMinUsd: updated.perCoinMinUsd.toString(),
      perCoinMaxUsd: updated.perCoinMaxUsd.toString(),
    });
  } catch (error: any) {
    if (error.code === 'P2025') return next(new AppError('Bot not found', 404));
    next(error);
  }
};
```

- [ ] **Step 3: route 등록**

`src/routes/stablecoin-admin.ts` (또는 stablecoin admin이 등록된 파일)에 라우트 추가:

```typescript
router.post('/bot/live', authenticate, requireAdmin, postLive);
router.post('/bot/stage', authenticate, requireAdmin, postStage);
```

(정확한 파일 + 미들웨어 import는 기존 endpoint들 어떻게 등록됐는지 보고 동일 패턴)

- [ ] **Step 4: 테스트 추가**

`__tests__/controllers/stablecoin-admin.controller.test.ts`에 추가:

```typescript
describe('postLive', () => {
  it('live=false → 토글', async () => {
    (arbService.setLive as jest.Mock).mockResolvedValueOnce(makeMockBot({ live: false }));
    req.body = { live: false };
    await postLive(req as AuthRequest, res as Response, next);
    expect(arbService.setLive).toHaveBeenCalledWith(1, false);
  });

  it('live=true + confirm 누락 → 400', async () => {
    req.body = { live: true };
    await postLive(req as AuthRequest, res as Response, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('live=true + confirm 정확 → 토글', async () => {
    (arbService.setLive as jest.Mock).mockResolvedValueOnce(makeMockBot({ live: true }));
    req.body = { live: true, confirm: 'I_UNDERSTAND_LIVE_TRADING' };
    await postLive(req as AuthRequest, res as Response, next);
    expect(arbService.setLive).toHaveBeenCalledWith(1, true);
  });
});

describe('postStage', () => {
  it('stage=1 → setStage 호출', async () => {
    (arbService.setStage as jest.Mock).mockResolvedValueOnce(makeMockBot({}));
    req.body = { stage: 1 };
    await postStage(req as AuthRequest, res as Response, next);
    expect(arbService.setStage).toHaveBeenCalledWith(1, 1);
  });

  it('stage=4 (invalid) → 400', async () => {
    req.body = { stage: 4 };
    await postStage(req as AuthRequest, res as Response, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });
});
```

(makeMockBot 헬퍼는 기존 테스트의 패턴 활용 — 없으면 inline 객체)

- [ ] **Step 5: jest 통과 + commit**

```bash
npx jest __tests__/controllers/stablecoin-admin.controller.test.ts 2>&1 | tail -10
# Expected: 모든 테스트 통과 (기존 17 + 신규 5 = 22)

git add src/controllers/stablecoin-admin.controller.ts src/routes/stablecoin-admin.ts __tests__/controllers/stablecoin-admin.controller.test.ts
git commit -m "feat(stablecoin): live 토글 + Stage 승급 API

POST /api/admin/stablecoin/bot/live (confirm:I_UNDERSTAND_LIVE_TRADING 필수)
POST /api/admin/stablecoin/bot/stage (1/2/3)
5 신규 테스트 통과"
```

---

## Task 6: Admin UI — live 토글 + Stage 표시 + confirm dialog

**Files:**
- Modify: `v0-grid-transaction-frontend/lib/api.ts` (함수 + 타입 추가)
- Modify: `v0-grid-transaction-frontend/app/admin/stablecoin/_components/BotStatusCard.tsx`

> **참고**: Frontend 디렉토리는 백엔드 작업 디렉토리 밖. 별도 터미널 또는 cd 변경 필요.

- [ ] **Step 1: lib/api.ts에 fetch 함수 추가**

`lib/api.ts`의 stablecoin 관련 함수 그룹 끝에 추가:

```typescript
export const setStablecoinBotLive = async (
  live: boolean,
  confirm?: string,
): Promise<StablecoinBot> => {
  const response = await fetch(`${API_BASE_URL}/api/admin/stablecoin/bot/live`, {
    method: 'POST',
    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ live, confirm }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message || `live 토글 실패: ${response.status}`);
  }
  return response.json();
};

export const setStablecoinBotStage = async (
  stage: 1 | 2 | 3,
): Promise<StablecoinBot> => {
  const response = await fetch(`${API_BASE_URL}/api/admin/stablecoin/bot/stage`, {
    method: 'POST',
    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message || `Stage 변경 실패: ${response.status}`);
  }
  return response.json();
};
```

- [ ] **Step 2: BotStatusCard에 live 토글 + Stage 표시 + 승급 버튼**

`BotStatusCard.tsx` 수정 — 핵심 추가:

```tsx
"use client"

import { useState } from "react"
import { setStablecoinBotLive, setStablecoinBotStage } from "@/lib/api"
// ... 기존 imports

// 컴포넌트 내부:
const [confirmDialog, setConfirmDialog] = useState<null | 'live'>(null);

const handleLiveToggle = async (newLive: boolean) => {
  if (newLive) {
    setConfirmDialog('live');  // 큰 확인 다이얼로그
    return;
  }
  await setStablecoinBotLive(false);
  refetch();
};

const handleConfirmLive = async () => {
  await setStablecoinBotLive(true, 'I_UNDERSTAND_LIVE_TRADING');
  setConfirmDialog(null);
  refetch();
};

const handleStageChange = async (stage: 1 | 2 | 3) => {
  await setStablecoinBotStage(stage);
  refetch();
};

// JSX 핵심:
<div className="space-y-2">
  <div className="flex items-center justify-between">
    <span className="text-sm font-medium">live 거래</span>
    <Switch
      checked={data?.live ?? false}
      onCheckedChange={handleLiveToggle}
    />
  </div>
  <div className="flex items-center gap-2">
    <span className="text-sm">Stage:</span>
    <Badge>
      {data?.tradeSizeKrw === 10000 ? '1' :
       data?.tradeSizeKrw === 20000 ? '2' :
       data?.tradeSizeKrw === 50000 ? '3' : '?'}
    </Badge>
    <Button size="sm" variant="outline" onClick={() => handleStageChange(2)}>Stage 2 승급</Button>
    <Button size="sm" variant="outline" onClick={() => handleStageChange(3)}>Stage 3 승급</Button>
  </div>
</div>

{confirmDialog === 'live' && (
  <Dialog open onOpenChange={() => setConfirmDialog(null)}>
    <DialogContent className="border-red-500">
      <DialogHeader>
        <DialogTitle className="text-red-600">⚠️ 실거래 시작</DialogTitle>
        <DialogDescription>
          live 모드 활성화 = 실제 Upbit 잔고로 매매 시작.
          현재 Stage 1: 1만원/거래, 일 3건, 손실 한도 1만원.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={() => setConfirmDialog(null)}>취소</Button>
        <Button variant="destructive" onClick={handleConfirmLive}>실거래 시작</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
)}
```

(StablecoinBot 타입에 `live: boolean` 필드 추가 필요)

- [ ] **Step 3: lib/api.ts의 StablecoinBot interface에 live 추가**

```typescript
export interface StablecoinBot {
  // ... 기존 필드
  live: boolean;
}
```

- [ ] **Step 4: frontend 빌드 확인**

```bash
cd "D:/ExpressProject/Grid_project/v0-grid-transaction-frontend"
npm run build 2>&1 | tail -15
```
Expected: 빌드 성공

- [ ] **Step 5: commit + push (frontend는 별도 repo 또는 별도 PR)**

frontend repo가 별도이므로 commit + push도 별도. PR 분리.

```bash
cd "D:/ExpressProject/Grid_project/v0-grid-transaction-frontend"
git checkout -b feat/stablecoin-live-toggle
git add lib/api.ts app/admin/stablecoin/_components/BotStatusCard.tsx
git commit -m "feat(stablecoin): live 토글 + Stage 승급 UI

- BotStatusCard에 live Switch + 큰 confirm dialog (실거래 시작 경고)
- Stage 1/2/3 표시 + 승급 버튼
- API: setStablecoinBotLive (confirm string 필수), setStablecoinBotStage"
git push -u origin feat/stablecoin-live-toggle
```

---

## Task 7: PR 생성 + 사용자 승인 후 머지 + 운영 검증

**Files:** (없음 — git 작업)

- [ ] **Step 1: 백엔드 통합 테스트 최종**

```bash
cd "D:/ExpressProject/Grid_project/v0-grid-tranasction-backend"
npx tsc --noEmit
npx jest __tests__/services __tests__/controllers/stablecoin-admin.controller.test.ts 2>&1 | tail -10
```
Expected: tsc 0 errors + 30+ 테스트 통과 (기존 + 신규)

- [ ] **Step 2: 백엔드 PR 생성**

```bash
git push -u origin feat/stablecoin-trading-pr-b
gh pr create --base main --head feat/stablecoin-trading-pr-b \
  --title "feat(stablecoin): PR B — 직접 아비트리지 executor + agent 통합 + Admin API" \
  --body "<<spec/plan 링크 + 변경 요약 + Test plan>>"
```

- [ ] **Step 3: 프론트 PR 생성 (별도)**

```bash
cd "D:/ExpressProject/Grid_project/v0-grid-transaction-frontend"
gh pr create --title "feat(stablecoin): live 토글 + Stage UI" --body "백엔드 PR과 페어"
```

- [ ] **Step 4: STOP — 사용자 review 요청**

두 PR 모두 사용자가 review. 백엔드 먼저 머지 → 프론트 머지.

- [ ] **Step 5: 사용자 승인 후 머지 (백엔드 → 프론트 순)**

- [ ] **Step 6: 운영 검증**

```bash
# 컨테이너 재시작 + 6 에이전트 정상
ssh -i "C:/pem/54.180.188.8.pem" -o StrictHostKeyChecking=no ubuntu@54.180.188.8 \
  "docker inspect grid-bot --format '{{.State.StartedAt}}'"
curl -s http://54.180.188.8:3010/api/health
curl -s http://54.180.188.8:3010/api/agents | python -c "..."
# Expected: 6 에이전트 running, errors=0

# bot.live는 여전히 false (기본값) — 실거래 안 일어남
# 사용자가 admin 페이지에서 live 토글 시도 → confirm dialog 표시 → 토글 가능
```

---

## Self-Review

### 1. Spec coverage

| Spec 섹션 | Plan task |
|---|---|
| §3 직접 arb executor 흐름 | Task 2 |
| §3.3 Upbit 응답 파싱 (executed_volume / trades.funds / paid_fee) | Task 2 Step 3 (executor 구현) |
| §10 Admin API — live 토글 + Stage 승급 | Task 5 |
| §11 Admin UI — live 토글 + Stage + confirm | Task 6 |
| §13 PR B 범위 | Task 1~7 전체 |
| §14.2 미결정 #2 (잔고 캐시 5초) | Task 3 |

**미커버 (PR C/D 위임)**:
- Maker-Taker live executor → PR C
- Maker bot CRUD UI → PR C
- Auto kill switch trigger → PR C에서 추가
- canary Stage 1으로 자동 setup → PR D
- 통합 mock Upbit + DB E2E → PR D 전 추가 검증

### 2. Placeholder scan

- "<<spec/plan 링크 + 변경 요약 + Test plan>>" Task 7 Step 2 — PR 생성 시점 placeholder. 실행 시 채움. 의도적.
- "위치 확인 필요" — credential service / route 파일 위치는 코드베이스 grep으로 실행 단계에서 확인. 의도적 (정찰 필요).
- 이 외 placeholder 0건.

### 3. Type consistency

- `ExecutorResult.ok=true` → `markToMarketNet`, `krwFlowNet`, `realizedSpreadBps`, `totalFeeKrw`, `legA`, `legB` ✅
- `ExecutorResult.ok=false` → `reason`, optional `rolledBack`, `legA`, `legB` ✅
- `IocClient.placeBestIoc(market, side, params)` → 실제 UpbitService 시그니처와 일치 ✅
- `BalanceCache.get()` 반환 = `Record<string, number>` → executor의 `balance` 인자 타입과 일치 ✅
- `ArbTradeStatus.COMPLETED/FALLBACK_DONE/FAILED` → 기존 prisma enum (PR A 변경 무관) ✅

### 4. 트랩 회피

- Mock 시그니처 = 실제 함수 시그니처 (세션 9~10 trap #3): Task 2 테스트의 MockUpbit이 IocClient interface 그대로. `placeBestIoc(market, side, params)` 시그니처 일치 ✅
- credential 위치/시그니처는 실제 grep으로 확인 (Task 4 Step 1, Step 4 명시) ✅
- frontend 디렉토리 분리 — Task 6에서 명시 + 별도 PR ✅

---

## 다음 단계

PR B 머지 후 별도 brainstorming/writing-plans 사이클 (PR C):
- 범위: maker-taker-live-executor + agent 분기 + maker bot CRUD UI + auto kill switch
- 위험도: 중 (live=false 기본)
- 예상 task: 8~10개
