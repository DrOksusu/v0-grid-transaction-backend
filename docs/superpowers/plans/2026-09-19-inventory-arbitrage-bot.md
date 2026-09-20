# 재고형(Inventory) 아비트리지 봇 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 업비트↔빗썸 크로스 스프레드를 감지해, 완전자동(autoExecute) 모드에서 비싼 곳 매도 + 싼 곳 매수를 동시 실행하여 코인 개수를 보존한 채 원화 차익을 얻는다. 실거래 자동 주문 봇 — 기본 OFF·canary·부분체결 flatten 방어가 설계 중심.

**Architecture:** `InventoryArbAgent`(REST 폴링, BaseAgent) → `inventory-arb.service`(오케스트레이션) → 순수 함수 `SpreadDetector`/`FeasibilityGate` + `InventoryArbExecutor`(양쪽 동시 주문 + flatten). 주문은 기존 `ExchangeLeg`(UpbitLeg/BithumbLeg)에 위임. 데이터는 메인 DB(`mainPrisma`)의 `InventoryArbBot`/`InventoryArbTrade`.

**Tech Stack:** Express 5, TypeScript, Prisma(MySQL, 메인 DB), jest. 기존 재사용: `src/services/exchange-leg.ts`, `src/services/kakao-notify.service.ts`, `ExchangeClient.getOrderbookTop()`.

---

## 설계 확정 사항 (구현 전 필독)

이 계획은 아래 결정과 제약 위에 세워졌다. 태스크를 벗어나 임의 변경 금지.

1. **완전자동 중심(사용자 결정 2026-09-19).** `autoExecute=true` = 감지 즉시 실행(canary 상한). `autoExecute=false`(반자동) = **감지·카톡 알림·`detected` 행 기록만, 주문 실행 없음.** 승인 라운드트립 UI는 이번 범위 밖(후속).
2. **DB = 메인 DB.** 다른 모든 자동매매 봇과 동일하게 `mainPrisma`(`import mainPrisma from '../config/database'`). 새 DB 만들지 않음.
3. **부분체결 flatten이 유일한 실질 안전망.** REST 폴링은 감지↔발주 사이 staleness가 내재하므로, 한쪽만/부분 체결 시 즉시 시장가 상쇄로 개수 복원이 핵심. **flatten 실패는 터미널 상태** → killSwitch ON + 긴급 카톡 + 봇 정지, **재시도 루프 금지**.
4. **수량 매칭은 등식이 아니라 tolerance band.** 빗썸 매수 수수료가 코인 차감이면 full-fill에도 `buyQty < 주문량`. `buyQty === sellQty` 비교는 모든 빗썸 매수를 부분체결로 오판한다. 밴드(기본 1%) 안이면 체결로 간주. 첫 canary 거래로 실제 코인차감 여부 측정.
5. **dust < 최소주문(5000 KRW).** 상쇄분이 5000 KRW 미만이면 flatten 주문이 안 나간다(exchange-leg.ts 5000 하한). dust 잔여는 수용 + 로그 + 알림으로 처리(터미널 아님).
6. **record-before-fire.** leg 발주 **전에** pending 행을 만들고 이후 갱신. 크래시로 발주 후 기록 전 죽어도 추적 가능.
7. ~~호가는 top-level만 사용~~ → **2026-09-20 다단계 depth 구현 완료.** `orderbook-depth.ts`가 공개 REST로 다단계 호가 조회, detector가 마진 스프레드 ≥ minSpreadBps 구간까지 수량 누적(`maxQtyByDepth`), priceHint는 소비한 최악 레벨가(예산 안전). 레벨 없으면 top-level 폴백.
8. **가격 이상(anomaly) 가드.** 스프레드가 비현실적으로 크면(`spreadBps > anomalyMaxBps`, 기본 2000=20%) 티커/호가 오류 의심 → skip.

---

## File Structure

| 파일 | 책임 | 신규/수정 |
|---|---|---|
| `prisma/schema.prisma` | `InventoryArbBot` / `InventoryArbTrade` 모델 (메인 DB) | 수정 |
| `src/services/inventory-arb/spread-detector.ts` | 순수: 양쪽 호가 → 크로스 스프레드/방향/depth 물량 | 신규 |
| `src/services/inventory-arb/feasibility-gate.ts` | 순수: 임계·재고·잔고·한도·anomaly 게이트 → 최종 qty | 신규 |
| `src/services/inventory-arb/executor.ts` | 양쪽 동시 주문 + 부분체결 flatten (ExchangeLeg 위임) | 신규 |
| `src/services/inventory-arb/types.ts` | 공통 타입 (BookTop, ArbDirection, 결과 유니온) | 신규 |
| `src/services/inventory-arb.service.ts` | 오케스트레이션: 봇 조회→감지→게이트→(자동 실행 or 알림)→기록 | 신규 |
| `src/agents/inventory-arb-agent.ts` | BaseAgent, REST 폴링 사이클 → service.scanOnce() | 신규 |
| `src/controllers/inventory-arb.controller.ts` | CRUD + enabled/autoExecute/killSwitch 토글 | 신규 |
| `src/routes/inventory-arb.ts` | 라우트 정의 (authenticate 적용) | 신규 |
| `src/agents/index.ts` | 에이전트 export | 수정 |
| `src/index.ts` | 에이전트 register | 수정 |
| `src/routes/index.ts` | 라우트 mount | 수정 |
| `__tests__/services/inventory-arb-*.test.ts` | jest 단위 테스트 | 신규 |

각 파일 단일 책임. 순수 함수(detector/gate)와 부수효과(executor/service) 분리로 테스트 용이.

---

## Task 1: 공통 타입 정의

**Files:**
- Create: `src/services/inventory-arb/types.ts`

- [ ] **Step 1: 타입 파일 작성**

```typescript
// 재고형 아비트리지 봇 공통 타입

/** 거래소 최우선 호가 (getOrderbookTop 결과와 동일 구조) */
export interface BookTop {
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
}

export type ExchangeName = 'upbit' | 'bithumb';

/** 실행 방향: 어디서 사서 어디서 파는가 */
export type ArbDirection = 'buy_upbit_sell_bithumb' | 'buy_bithumb_sell_upbit';

/** SpreadDetector 결과 — 수익 가능한 크로스 스프레드 1건 */
export interface SpreadOpportunity {
  direction: ArbDirection;
  buyExchange: ExchangeName;
  sellExchange: ExchangeName;
  buyPrice: number; // 매수 거래소 ask (즉시 매수 체결가)
  sellPrice: number; // 매도 거래소 bid (즉시 매도 체결가)
  spreadBps: number; // (sellPrice / buyPrice - 1) * 10000
  maxQtyByDepth: number; // min(매수측 askQty, 매도측 bidQty)
}

/** FeasibilityGate 입력 */
export interface FeasibilityInput {
  opp: SpreadOpportunity;
  minSpreadBps: number;
  anomalyMaxBps: number;
  maxOrderKrw: number;
  dailyMaxKrw: number | null;
  dailyMaxCount: number | null;
  todayNotionalKrw: number; // 오늘 이미 집행한 notional 합
  todayCount: number; // 오늘 이미 집행한 건수
  sellCoinBalance: number; // 매도 거래소의 해당 코인 가용 잔고
  buyKrwBalance: number; // 매수 거래소의 KRW 가용 잔고
  buyFeeBps: number;
}

/** FeasibilityGate 결과 */
export interface FeasibilityResult {
  ok: boolean;
  qty: number; // 확정 주문 수량 (ok=false면 0)
  notionalKrw: number; // qty * buyPrice
  reason?: string;
}

/** Executor 결과 유니온 */
export type ExecutorResult =
  | {
      kind: 'filled';
      buyQty: number;
      sellQty: number;
      buyGrossKrw: number;
      sellGrossKrw: number;
      feeKrw: number;
      netKrw: number;
      note: string;
    }
  | {
      kind: 'partial_flattened';
      buyQty: number;
      sellQty: number;
      flattenSide: 'sell' | 'buy';
      flattenQty: number;
      buyGrossKrw: number;
      sellGrossKrw: number;
      feeKrw: number;
      netKrw: number;
      note: string;
    }
  | { kind: 'partial_hold'; imbalanceQty: number; note: string }
  | { kind: 'flatten_failed'; imbalanceQty: number; note: string } // 터미널 → killSwitch
  | { kind: 'failed'; reason: string };
```

- [ ] **Step 2: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 에러 0개 (타입만 정의, 사용처 없음)

- [ ] **Step 3: Commit**

```bash
git add src/services/inventory-arb/types.ts
git commit -m "feat: 재고형 아비 봇 공통 타입 정의"
```

---

## Task 2: SpreadDetector (순수 함수)

**Files:**
- Create: `src/services/inventory-arb/spread-detector.ts`
- Test: `__tests__/services/inventory-arb-spread-detector.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

```typescript
import { detectOpportunity } from '../../src/services/inventory-arb/spread-detector';
import type { BookTop } from '../../src/services/inventory-arb/types';

const book = (bid: number, ask: number, bidQty = 100, askQty = 100): BookTop => ({
  bid, ask, bidQty, askQty,
});

describe('detectOpportunity', () => {
  it('빗썸 bid > 업비트 ask 이면 buy_upbit_sell_bithumb 반환', () => {
    const upbit = book(999, 1000, 50, 40); // 업비트에서 1000에 매수
    const bithumb = book(1010, 1011, 30, 20); // 빗썸에서 1010에 매도
    const opp = detectOpportunity(upbit, bithumb);
    expect(opp).not.toBeNull();
    expect(opp!.direction).toBe('buy_upbit_sell_bithumb');
    expect(opp!.buyPrice).toBe(1000); // 업비트 ask
    expect(opp!.sellPrice).toBe(1010); // 빗썸 bid
    expect(opp!.spreadBps).toBe(Math.floor((1010 / 1000 - 1) * 10000)); // 100bp
    expect(opp!.maxQtyByDepth).toBe(30); // min(업비트 askQty=40, 빗썸 bidQty=30)
  });

  it('업비트 bid > 빗썸 ask 이면 buy_bithumb_sell_upbit 반환', () => {
    const upbit = book(1010, 1011, 30, 20);
    const bithumb = book(999, 1000, 50, 40);
    const opp = detectOpportunity(upbit, bithumb);
    expect(opp!.direction).toBe('buy_bithumb_sell_upbit');
    expect(opp!.buyPrice).toBe(1000); // 빗썸 ask
    expect(opp!.sellPrice).toBe(1010); // 업비트 bid
    expect(opp!.maxQtyByDepth).toBe(20); // min(빗썸 askQty=40, 업비트 bidQty=30) => 실제 min(40,30)=30? 아래 주석 참조
  });

  it('크로스 스프레드 없으면(양쪽 정상) null', () => {
    const upbit = book(999, 1001, 50, 50);
    const bithumb = book(999, 1001, 50, 50);
    expect(detectOpportunity(upbit, bithumb)).toBeNull();
  });

  it('호가가 0 이하이면 null', () => {
    expect(detectOpportunity(book(0, 0), book(1010, 1011))).toBeNull();
  });
});
```

> 주의: 위 두 번째 테스트의 `maxQtyByDepth` 기대값은 구현 규칙 "min(매수측 askQty, 매도측 bidQty)"로 계산한다. buy_bithumb_sell_upbit면 매수측=빗썸 askQty(40), 매도측=업비트 bidQty(30) → 30. Step 1 코드의 기대값을 `30`으로 수정해 작성할 것.

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest inventory-arb-spread-detector -t detectOpportunity`
Expected: FAIL — "Cannot find module .../spread-detector"

- [ ] **Step 3: 구현 작성**

```typescript
// 순수 함수: 업비트·빗썸 최우선 호가 → 수익 가능한 크로스 스프레드 1건 (없으면 null)
import type { BookTop, SpreadOpportunity } from './types';

function validBook(b: BookTop): boolean {
  return b.bid > 0 && b.ask > 0 && b.bidQty > 0 && b.askQty > 0;
}

/**
 * 크로스 스프레드 감지. 두 방향 중 수익(sellPrice > buyPrice)인 쪽을 반환.
 * 두 방향 동시 수익은 정상 시장에서 불가능하나, 방어적으로 spread 큰 쪽 선택.
 */
export function detectOpportunity(upbit: BookTop, bithumb: BookTop): SpreadOpportunity | null {
  if (!validBook(upbit) || !validBook(bithumb)) return null;

  const candidates: SpreadOpportunity[] = [];

  // 방향 1: 업비트에서 사서(ask) 빗썸에서 판다(bid)
  if (bithumb.bid > upbit.ask) {
    candidates.push({
      direction: 'buy_upbit_sell_bithumb',
      buyExchange: 'upbit',
      sellExchange: 'bithumb',
      buyPrice: upbit.ask,
      sellPrice: bithumb.bid,
      spreadBps: Math.floor((bithumb.bid / upbit.ask - 1) * 10000),
      maxQtyByDepth: Math.min(upbit.askQty, bithumb.bidQty),
    });
  }

  // 방향 2: 빗썸에서 사서(ask) 업비트에서 판다(bid)
  if (upbit.bid > bithumb.ask) {
    candidates.push({
      direction: 'buy_bithumb_sell_upbit',
      buyExchange: 'bithumb',
      sellExchange: 'upbit',
      buyPrice: bithumb.ask,
      sellPrice: upbit.bid,
      spreadBps: Math.floor((upbit.bid / bithumb.ask - 1) * 10000),
      maxQtyByDepth: Math.min(bithumb.askQty, upbit.bidQty),
    });
  }

  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.spreadBps - a.spreadBps)[0];
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest inventory-arb-spread-detector`
Expected: PASS (4개)

- [ ] **Step 5: Commit**

```bash
git add src/services/inventory-arb/spread-detector.ts __tests__/services/inventory-arb-spread-detector.test.ts
git commit -m "feat: 재고형 아비 SpreadDetector 순수 함수"
```

---

## Task 3: FeasibilityGate (순수 함수)

**Files:**
- Create: `src/services/inventory-arb/feasibility-gate.ts`
- Test: `__tests__/services/inventory-arb-feasibility-gate.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

```typescript
import { evaluateFeasibility } from '../../src/services/inventory-arb/feasibility-gate';
import type { FeasibilityInput, SpreadOpportunity } from '../../src/services/inventory-arb/types';

const opp: SpreadOpportunity = {
  direction: 'buy_upbit_sell_bithumb',
  buyExchange: 'upbit',
  sellExchange: 'bithumb',
  buyPrice: 1000,
  sellPrice: 1010,
  spreadBps: 100,
  maxQtyByDepth: 50,
};

const base: FeasibilityInput = {
  opp,
  minSpreadBps: 30,
  anomalyMaxBps: 2000,
  maxOrderKrw: 20000, // 20 coin @1000
  dailyMaxKrw: null,
  dailyMaxCount: null,
  todayNotionalKrw: 0,
  todayCount: 0,
  sellCoinBalance: 1000,
  buyKrwBalance: 1_000_000,
  buyFeeBps: 5,
};

describe('evaluateFeasibility', () => {
  it('스프레드가 임계 미만이면 거부', () => {
    const r = evaluateFeasibility({ ...base, opp: { ...opp, spreadBps: 10 } });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('spread');
  });

  it('스프레드가 anomaly 상한 초과면 거부', () => {
    const r = evaluateFeasibility({ ...base, opp: { ...opp, spreadBps: 3000 } });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('anomaly');
  });

  it('정상: qty = min(depth, maxOrderKrw/price, 재고, KRW예산)', () => {
    const r = evaluateFeasibility(base);
    // maxOrderKrw 20000 / 1000 = 20; depth 50; 재고 1000; KRW예산 충분 → 20
    expect(r.ok).toBe(true);
    expect(r.qty).toBe(20);
    expect(r.notionalKrw).toBe(20000);
  });

  it('매도 거래소 코인 재고가 부족하면 그만큼만', () => {
    const r = evaluateFeasibility({ ...base, sellCoinBalance: 7 });
    expect(r.qty).toBe(7);
  });

  it('매수 거래소 KRW 예산이 부족하면 그만큼만 (수수료 포함)', () => {
    // KRW 5025 / (1000 * 1.0005) = 5.02248875... → 소수점 8자리 floor (암호화폐 수량은 소수 허용)
    const r = evaluateFeasibility({ ...base, buyKrwBalance: 5025 });
    expect(r.qty).toBeCloseTo(5.02248875, 8);
  });

  it('최종 주문액이 최소주문(5000) 미만이면 거부', () => {
    const r = evaluateFeasibility({ ...base, sellCoinBalance: 3 }); // 3*1000=3000 < 5000
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('min order');
  });

  it('일일 notional 한도 잔여만큼 cap', () => {
    const r = evaluateFeasibility({ ...base, dailyMaxKrw: 30000, todayNotionalKrw: 22000 });
    // 잔여 8000 / 1000 = 8
    expect(r.qty).toBe(8);
  });

  it('일일 건수 한도 도달 시 거부', () => {
    const r = evaluateFeasibility({ ...base, dailyMaxCount: 3, todayCount: 3 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('daily count');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest inventory-arb-feasibility-gate`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현 작성**

```typescript
// 순수 함수: 스프레드/anomaly/재고/잔고/일일한도 → 최종 주문 수량 결정
import type { FeasibilityInput, FeasibilityResult } from './types';

const MIN_ORDER_KRW = 5000; // 업비트·빗썸 공통 최소 주문금액

export function evaluateFeasibility(input: FeasibilityInput): FeasibilityResult {
  const {
    opp, minSpreadBps, anomalyMaxBps, maxOrderKrw, dailyMaxKrw, dailyMaxCount,
    todayNotionalKrw, todayCount, sellCoinBalance, buyKrwBalance, buyFeeBps,
  } = input;

  const fail = (reason: string): FeasibilityResult => ({ ok: false, qty: 0, notionalKrw: 0, reason });

  // 0. 가격 유효성 (독립 호출 방어 — detector가 보장하나 게이트 자체 불변식 강제)
  if (opp.buyPrice <= 0) return fail(`invalid buyPrice ${opp.buyPrice}`);

  // 1. 스프레드 게이트
  if (opp.spreadBps < minSpreadBps) {
    return fail(`spread ${opp.spreadBps}bp < min ${minSpreadBps}bp`);
  }
  // 2. anomaly 가드
  if (opp.spreadBps > anomalyMaxBps) {
    return fail(`anomaly: spread ${opp.spreadBps}bp > max ${anomalyMaxBps}bp`);
  }
  // 3. 일일 건수 한도
  if (dailyMaxCount != null && todayCount >= dailyMaxCount) {
    return fail(`daily count limit reached (${todayCount}/${dailyMaxCount})`);
  }

  // 4. KRW 예산 한도 계산 (per-order + daily 잔여 중 작은 값)
  let krwBudget = maxOrderKrw;
  if (dailyMaxKrw != null) {
    const remaining = dailyMaxKrw - todayNotionalKrw;
    if (remaining <= 0) return fail(`daily notional limit reached (used ${todayNotionalKrw}/${dailyMaxKrw})`);
    krwBudget = Math.min(krwBudget, remaining);
  }

  // 5. qty = min(depth, KRW예산/가격, 매도재고, 매수KRW/가격(수수료포함))
  const feeFactor = 1 + buyFeeBps / 10000;
  const qtyByBudget = krwBudget / opp.buyPrice;
  const qtyByKrwBalance = buyKrwBalance / (opp.buyPrice * feeFactor);
  const rawQty = Math.min(opp.maxQtyByDepth, qtyByBudget, sellCoinBalance, qtyByKrwBalance);

  // 소수점 8자리로 floor (거래소 수량 정밀도)
  const qty = Math.floor(rawQty * 1e8) / 1e8;
  const notionalKrw = qty * opp.buyPrice;

  // 6. 최소주문 검사
  if (notionalKrw < MIN_ORDER_KRW) {
    return fail(`notional ${Math.round(notionalKrw)} < min order ${MIN_ORDER_KRW}`);
  }

  return { ok: true, qty, notionalKrw };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest inventory-arb-feasibility-gate`
Expected: PASS (8개)

- [ ] **Step 5: Commit**

```bash
git add src/services/inventory-arb/feasibility-gate.ts __tests__/services/inventory-arb-feasibility-gate.test.ts
git commit -m "feat: 재고형 아비 FeasibilityGate 순수 함수"
```

---

## Task 4: InventoryArbExecutor — 동시 주문 + 부분체결 flatten (최고 위험, TDD 최우선)

> **이 태스크가 이 봇의 심장이자 최대 손실원.** flatten 경로를 mocked ExchangeLeg로 철저히 먼저 테스트한다. 재시도 루프 없음. flatten 실패 = 터미널.

**Files:**
- Create: `src/services/inventory-arb/executor.ts`
- Test: `__tests__/services/inventory-arb-executor.test.ts`

- [ ] **Step 1: 실패 테스트 작성 (14개 케이스 — flatten/터미널/dust/hold/leg예외/flatten예외)**

```typescript
import { executeArb } from '../../src/services/inventory-arb/executor';
import type { ExchangeLeg } from '../../src/services/exchange-leg';

// 체결 결과를 시나리오로 주입하는 mock ExchangeLeg
function mockLeg(overrides: Partial<Record<keyof ExchangeLeg, any>>): ExchangeLeg {
  const notImpl = () => {
    throw new Error('not implemented in test');
  };
  return {
    sellIoc: overrides.sellIoc ?? (async () => null),
    buyIoc: overrides.buyIoc ?? (async () => null),
    buyGtc: notImpl,
    placeMakerBid: notImpl,
    pollOrder: notImpl,
    placeMakerAsk: notImpl,
    cancelOrder: notImpl,
  } as ExchangeLeg;
}

const PRICE = 1000;
const QTY = 10;

describe('executeArb', () => {
  it('양쪽 완전 체결 → filled, netKrw = sell - buy - fee', async () => {
    const sellLeg = mockLeg({ sellIoc: async () => ({ filledQty: 10, grossKrw: 10100, feeKrw: 4 }) });
    const buyLeg = mockLeg({ buyIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }) });
    const r = await executeArb({ buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010, fallbackMode: 'market_flatten' });
    expect(r.kind).toBe('filled');
    if (r.kind === 'filled') expect(r.netKrw).toBeCloseTo(10100 - 10000 - 9, 6);
  });

  it('fee-in-coin으로 buyQty 9.98 (dust 범위) → filled (부분체결 오판 금지)', async () => {
    const sellLeg = mockLeg({ sellIoc: async () => ({ filledQty: 10, grossKrw: 10100, feeKrw: 4 }) });
    const buyLeg = mockLeg({ buyIoc: async () => ({ filledQty: 9.98, grossKrw: 10000, feeKrw: 0 }) });
    // imbalance 0.02 × 1010 = 20.2 KRW < 5000 → dust 수용
    const r = await executeArb({ buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010, fallbackMode: 'market_flatten' });
    expect(r.kind).toBe('filled');
  });

  // flatten/hold 경로: imbalance × price ≥ 5000 KRW 여야 dust 단락을 피함 (imbalance 6 × 1000 = 6000)
  it('net long (buy 10, sell 4) → 초과 6을 buyExchange에서 시장가 매도로 flatten', async () => {
    const sellCalls: any[] = [];
    const sellLeg = mockLeg({ sellIoc: async () => ({ filledQty: 4, grossKrw: 4040, feeKrw: 2 }) });
    const buyLeg = mockLeg({
      buyIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }),
      // buyLeg에서 flatten 매도 발생 — 6개 매도
      sellIoc: async (sym: string, q: number) => {
        sellCalls.push({ sym, q });
        return { filledQty: 6, grossKrw: 6000, feeKrw: 2 };
      },
    });
    const r = await executeArb({ buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010, fallbackMode: 'market_flatten' });
    expect(r.kind).toBe('partial_flattened');
    if (r.kind === 'partial_flattened') {
      expect(r.flattenSide).toBe('sell');
      expect(r.flattenQty).toBeCloseTo(6, 6);
    }
    expect(sellCalls[0].q).toBeCloseTo(6, 6);
  });

  it('net short (buy 4, sell 10) → 부족 6을 sellExchange에서 시장가 매수로 flatten', async () => {
    const buyCalls: any[] = [];
    const sellLeg = mockLeg({
      sellIoc: async () => ({ filledQty: 10, grossKrw: 10100, feeKrw: 4 }),
      // sellLeg(=sellExchange)에서 flatten 매수 발생
      buyIoc: async (sym: string, q: number) => {
        buyCalls.push({ sym, q });
        return { filledQty: 6, grossKrw: 6060, feeKrw: 2 };
      },
    });
    const buyLeg = mockLeg({ buyIoc: async () => ({ filledQty: 4, grossKrw: 4000, feeKrw: 3 }) });
    const r = await executeArb({ buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010, fallbackMode: 'market_flatten' });
    expect(r.kind).toBe('partial_flattened');
    if (r.kind === 'partial_flattened') expect(r.flattenSide).toBe('buy');
    expect(buyCalls[0].q).toBeCloseTo(6, 6);
  });

  it('flatten 주문이 실패(null)하면 → flatten_failed (터미널)', async () => {
    const sellLeg = mockLeg({ sellIoc: async () => ({ filledQty: 4, grossKrw: 4040, feeKrw: 2 }) });
    const buyLeg = mockLeg({
      buyIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }),
      sellIoc: async () => null, // flatten 실패
    });
    const r = await executeArb({ buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010, fallbackMode: 'market_flatten' });
    expect(r.kind).toBe('flatten_failed');
    if (r.kind === 'flatten_failed') expect(r.imbalanceQty).toBeCloseTo(6, 6);
  });

  it('net short flatten 매수가 실패(null)하면 → flatten_failed (터미널)', async () => {
    const sellLeg = mockLeg({
      sellIoc: async () => ({ filledQty: 10, grossKrw: 10100, feeKrw: 4 }),
      buyIoc: async () => null, // flatten 매수 실패
    });
    const buyLeg = mockLeg({ buyIoc: async () => ({ filledQty: 4, grossKrw: 4000, feeKrw: 3 }) });
    const r = await executeArb({ buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010, fallbackMode: 'market_flatten' });
    expect(r.kind).toBe('flatten_failed');
    if (r.kind === 'flatten_failed') expect(r.imbalanceQty).toBeCloseTo(-6, 6);
  });

  it('net long flatten 매도가 throw하면 → flatten_failed (터미널, 예외도 안전 매핑)', async () => {
    const sellLeg = mockLeg({ sellIoc: async () => ({ filledQty: 4, grossKrw: 4040, feeKrw: 2 }) });
    const buyLeg = mockLeg({
      buyIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }),
      sellIoc: async () => {
        throw new Error('exchange 5xx');
      },
    });
    const r = await executeArb({ buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010, fallbackMode: 'market_flatten' });
    expect(r.kind).toBe('flatten_failed');
  });

  it('net short flatten 매수가 throw하면 → flatten_failed (터미널, 예외도 안전 매핑)', async () => {
    const sellLeg = mockLeg({
      sellIoc: async () => ({ filledQty: 10, grossKrw: 10100, feeKrw: 4 }),
      buyIoc: async () => {
        throw new Error('network');
      },
    });
    const buyLeg = mockLeg({ buyIoc: async () => ({ filledQty: 4, grossKrw: 4000, feeKrw: 3 }) });
    const r = await executeArb({ buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010, fallbackMode: 'market_flatten' });
    expect(r.kind).toBe('flatten_failed');
  });

  it('flatten이 목표 미달 체결(6 중 3)하면 → flatten_failed (터미널)', async () => {
    const sellLeg = mockLeg({ sellIoc: async () => ({ filledQty: 4, grossKrw: 4040, feeKrw: 2 }) });
    const buyLeg = mockLeg({
      buyIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }),
      sellIoc: async () => ({ filledQty: 3, grossKrw: 3000, feeKrw: 1 }), // 6 중 3만 체결 (< 99%)
    });
    const r = await executeArb({ buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010, fallbackMode: 'market_flatten' });
    expect(r.kind).toBe('flatten_failed');
  });

  it('flatten이 손실을 실현해도 partial_flattened로 정확히 기록 (netKrw 음수)', async () => {
    // buy 10@1000(gross 10000), sell 4@1010(gross 4040), flatten sell 6을 990/개(gross 5940)에 매도
    // netKrw = 4040 + 5940 - 10000 - fees(9) = -29
    const sellLeg = mockLeg({ sellIoc: async () => ({ filledQty: 4, grossKrw: 4040, feeKrw: 2 }) });
    const buyLeg = mockLeg({
      buyIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }),
      sellIoc: async () => ({ filledQty: 6, grossKrw: 5940, feeKrw: 2 }),
    });
    const r = await executeArb({ buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010, fallbackMode: 'market_flatten' });
    expect(r.kind).toBe('partial_flattened');
    if (r.kind === 'partial_flattened') expect(r.netKrw).toBeCloseTo(4040 + 5940 - 10000 - 9, 6);
  });

  it('한쪽 leg가 throw인데 반대편이 체결되면 → flatten_failed (체결상태 불명, 터미널)', async () => {
    const sellLeg = mockLeg({
      sellIoc: async () => {
        throw new Error('network');
      },
    });
    const buyLeg = mockLeg({ buyIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }) });
    const r = await executeArb({ buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010, fallbackMode: 'market_flatten' });
    expect(r.kind).toBe('flatten_failed');
  });

  it('imbalance가 dust(< 5000 KRW)면 flatten 없이 filled + dust 로그', async () => {
    const sellLeg = mockLeg({ sellIoc: async () => ({ filledQty: 9, grossKrw: 9090, feeKrw: 4 }) });
    const buyLeg = mockLeg({ buyIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }) });
    // imbalance 1 × 1000 = 1000 KRW < 5000 → dust
    const r = await executeArb({ buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010, fallbackMode: 'market_flatten' });
    expect(r.kind).toBe('filled');
    if (r.kind === 'filled') expect(r.note).toContain('dust');
  });

  it('fallback=hold + imbalance면 partial_hold', async () => {
    const sellLeg = mockLeg({ sellIoc: async () => ({ filledQty: 4, grossKrw: 4040, feeKrw: 2 }) });
    const buyLeg = mockLeg({ buyIoc: async () => ({ filledQty: 10, grossKrw: 10000, feeKrw: 5 }) });
    // imbalance 6 × 1000 = 6000 > 5000 (dust 아님) → hold 모드에서 partial_hold
    const r = await executeArb({ buyLeg, sellLeg, symbol: 'XRP', qty: QTY, buyPrice: PRICE, sellPrice: 1010, fallbackMode: 'hold' });
    expect(r.kind).toBe('partial_hold');
  });

  it('양쪽 모두 미체결(null) → failed', async () => {
    const r = await executeArb({
      buyLeg: mockLeg({}),
      sellLeg: mockLeg({}),
      symbol: 'XRP',
      qty: QTY,
      buyPrice: PRICE,
      sellPrice: 1010,
      fallbackMode: 'market_flatten',
    });
    expect(r.kind).toBe('failed');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest inventory-arb-executor`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현 작성**

```typescript
// 재고형 아비 실행 엔진: 양쪽 동시 IOC + 부분체결 flatten
// - flatten 실패 = 터미널(flatten_failed) → 호출자가 killSwitch + 긴급 알림
// - 재시도 루프 없음
import type { ExchangeLeg } from '../exchange-leg';
import type { ExecutorResult } from './types';

const MIN_ORDER_KRW = 5000; // 업비트·빗썸 공통 최소 주문금액. 이 미만 imbalance는 상쇄(flatten) 불가 → dust 수용
const FLATTEN_UNDERFILL_TOL = 0.01; // flatten 주문이 목표의 99% 이상 체결되면 성공 간주

export interface ExecuteArbInput {
  buyLeg: ExchangeLeg; // 매수 거래소
  sellLeg: ExchangeLeg; // 매도 거래소
  symbol: string; // base 심볼 (예: 'XRP')
  qty: number; // 목표 수량
  buyPrice: number; // 매수 거래소 ask (priceHint)
  sellPrice: number; // 매도 거래소 bid (priceHint)
  fallbackMode: 'market_flatten' | 'hold';
}

function fillQty(r: { filledQty: number } | null): number {
  return r?.filledQty ?? 0;
}

export async function executeArb(input: ExecuteArbInput): Promise<ExecutorResult> {
  const { buyLeg, sellLeg, symbol, qty, buyPrice, sellPrice, fallbackMode } = input;

  // 1. 양쪽 동시 발주 (record-before-fire는 호출자가 처리)
  const [sellSettled, buySettled] = await Promise.allSettled([
    sellLeg.sellIoc(symbol, qty, sellPrice),
    buyLeg.buyIoc(symbol, qty, buyPrice, undefined),
  ]);

  const sellRejected = sellSettled.status === 'rejected';
  const buyRejected = buySettled.status === 'rejected';
  const sellRes = sellSettled.status === 'fulfilled' ? sellSettled.value : null;
  const buyRes = buySettled.status === 'fulfilled' ? buySettled.value : null;

  const sellQty = fillQty(sellRes);
  const buyQty = fillQty(buyRes);

  // 2. 한쪽 leg가 throw(rejected)인데 반대편이 체결됨 = 체결 상태 불명 + 방향노출 가능성.
  //    rejected를 0으로 가정하고 flatten하면 이미 체결됐을 수 있어 이중 노출 위험 → 터미널 승격(사람 확인).
  //    (REST staleness 잔여 리스크 — 사후 리컨실은 오케스트레이터/후속 과제)
  if ((sellRejected && buyQty > 0) || (buyRejected && sellQty > 0)) {
    return {
      kind: 'flatten_failed',
      imbalanceQty: buyQty - sellQty,
      note: `leg 예외(sellRejected=${sellRejected} buyRejected=${buyRejected}) + 반대편 체결 — 체결상태 불명, 수동 확인 필요`,
    };
  }

  // 3. 양쪽 미체결
  if (sellQty === 0 && buyQty === 0) {
    return { kind: 'failed', reason: `both legs unfilled (sellRejected=${sellRejected} buyRejected=${buyRejected})` };
  }

  const buyGrossKrw = buyRes?.grossKrw ?? 0;
  const sellGrossKrw = sellRes?.grossKrw ?? 0;
  const legFeeKrw = (buyRes?.feeKrw ?? 0) + (sellRes?.feeKrw ?? 0);

  // 4. 개수 불균형 (netImbalance > 0 = 매수과다 net long, < 0 = 매도과다 net short)
  const netImbalance = buyQty - sellQty;
  const absImbalance = Math.abs(netImbalance);
  const referencePrice = netImbalance > 0 ? buyPrice : sellPrice;

  // 5. 완전 일치 또는 상쇄 불가한 소액(dust: 최소주문 미만) → filled 수용.
  //    fee-in-coin으로 인한 미세 불일치도 여기서 흡수한다(절대 KRW 기준 — 비율 밴드는 대형 주문에서 과다 흡수 위험이라 미사용).
  if (absImbalance === 0 || absImbalance * referencePrice < MIN_ORDER_KRW) {
    const netKrw = sellGrossKrw - buyGrossKrw - legFeeKrw;
    return {
      kind: 'filled',
      buyQty, sellQty, buyGrossKrw, sellGrossKrw, feeKrw: legFeeKrw,
      netKrw: +netKrw.toFixed(6),
      note: absImbalance === 0
        ? 'exact match'
        : `dust imbalance ${absImbalance} accepted (< ${MIN_ORDER_KRW} KRW)`,
    };
  }

  // 6. hold 모드 → 재고로 보류
  if (fallbackMode === 'hold') {
    return { kind: 'partial_hold', imbalanceQty: netImbalance, note: `hold imbalance=${netImbalance}` };
  }

  // 7. market_flatten — 상쇄 대상 물량/현금은 방금 체결로 확보됨(사전 잔고 가드 불필요; imbalance ≤ 방금 체결량).
  //    flatten 가능 여부는 실제 주문 결과(null/미달)로만 판정한다.
  const roundedImbalance = Math.floor(absImbalance * 1e8) / 1e8;
  if (netImbalance > 0) {
    // net long: 매수 거래소에 초과 코인 → 매수 거래소에서 시장가 매도로 상쇄
    // flatten 주문은 bare await 금지 — throw(네트워크/거래소 오류) 시에도 터미널로 매핑
    // (IOC 메서드는 pollOrder와 달리 예외를 삼키지 않고 던진다)
    let flat: { filledQty: number; grossKrw: number; feeKrw: number } | null;
    try {
      flat = await buyLeg.sellIoc(symbol, roundedImbalance, buyPrice);
    } catch (err: any) {
      return { kind: 'flatten_failed', imbalanceQty: netImbalance, note: `flatten sell threw: ${err?.message ?? err}` };
    }
    if (!flat || flat.filledQty < roundedImbalance * (1 - FLATTEN_UNDERFILL_TOL)) {
      return { kind: 'flatten_failed', imbalanceQty: netImbalance, note: `flatten sell failed (filled=${flat?.filledQty ?? 0}/${roundedImbalance})` };
    }
    const feeKrw = legFeeKrw + (flat.feeKrw ?? 0);
    const netKrw = sellGrossKrw + flat.grossKrw - buyGrossKrw - feeKrw;
    return {
      kind: 'partial_flattened',
      buyQty, sellQty, flattenSide: 'sell', flattenQty: roundedImbalance,
      buyGrossKrw, sellGrossKrw, feeKrw, netKrw: +netKrw.toFixed(6),
      note: `flattened net long ${roundedImbalance} via sell on buyExchange`,
    };
  } else {
    // net short: 매도 거래소에서 과다 매도 → 매도 거래소에서 시장가 매수로 복원
    // net long과 동일하게 throw도 터미널로 매핑
    // 시장가 매수는 ask를 무는데 priceHint(예산 기준)가 bid(sellPrice)면 예산 부족으로 미달→오탐 flatten_failed.
    // 5% 헤드룸을 실어 스프레드 5% 이내면 전량 매수 가능(net long 매도엔 불필요 — 수량 직접 지정).
    const flattenBuyPriceHint = sellPrice * 1.05;
    let flat: { filledQty: number; grossKrw: number; feeKrw: number } | null;
    try {
      flat = await sellLeg.buyIoc(symbol, roundedImbalance, flattenBuyPriceHint, undefined);
    } catch (err: any) {
      return { kind: 'flatten_failed', imbalanceQty: netImbalance, note: `flatten buy threw: ${err?.message ?? err}` };
    }
    if (!flat || flat.filledQty < roundedImbalance * (1 - FLATTEN_UNDERFILL_TOL)) {
      return { kind: 'flatten_failed', imbalanceQty: netImbalance, note: `flatten buy failed (filled=${flat?.filledQty ?? 0}/${roundedImbalance})` };
    }
    const feeKrw = legFeeKrw + (flat.feeKrw ?? 0);
    // 되산 것은 비용 → sell 수익에서 차감
    const netKrw = sellGrossKrw - buyGrossKrw - flat.grossKrw - feeKrw;
    return {
      kind: 'partial_flattened',
      buyQty, sellQty, flattenSide: 'buy', flattenQty: roundedImbalance,
      buyGrossKrw, sellGrossKrw, feeKrw, netKrw: +netKrw.toFixed(6),
      note: `flattened net short ${roundedImbalance} via buy on sellExchange`,
    };
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest inventory-arb-executor`
Expected: PASS (8개)

- [ ] **Step 5: Commit**

```bash
git add src/services/inventory-arb/executor.ts __tests__/services/inventory-arb-executor.test.ts
git commit -m "feat: 재고형 아비 Executor 동시주문+flatten (핵심 안전망)"
```

---

## Task 5: Prisma 모델 추가 (메인 DB) + 마이그레이션

**Files:**
- Modify: `prisma/schema.prisma` (파일 끝에 모델 2개 추가)

- [ ] **Step 1: 모델 추가**

`prisma/schema.prisma` 파일 끝에 아래를 추가한다. (datasource/generator는 기존 그대로 — 메인 DB 사용)

```prisma
model InventoryArbBot {
  id            Int      @id @default(autoincrement())
  userId        Int
  symbol        String                              // base 심볼 (예: "XRP")
  minSpreadBps  Int      @default(30)               // 진입 임계 (0.30%)
  anomalyMaxBps Int      @default(2000)             // 가격 이상 상한 (20%) — 초과 시 skip
  maxOrderKrw   Float                               // 1회 최대 주문 규모(notional)
  dailyMaxKrw   Float?                              // 일일 notional 한도
  dailyMaxCount Int?                                // 일일 건수 한도
  fallbackMode  String   @default("market_flatten") // "market_flatten" | "hold"
  autoExecute   Boolean  @default(false)            // false=반자동(알림만), true=완전자동(즉시 실행)
  enabled       Boolean  @default(false)            // canary OFF 기본
  killSwitch    Boolean  @default(false)
  buyFeeBps     Int      @default(5)                // 매수 수수료(bp) — 예산 계산용
  lastResumeAt  DateTime?                           // enabled false→true 전환 시각 (canary 관찰 기준)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@index([userId, enabled])
  @@map("inventory_arb_bots")
}

model InventoryArbTrade {
  id            Int      @id @default(autoincrement())
  botId         Int
  symbol        String
  direction     String   // "buy_upbit_sell_bithumb" | "buy_bithumb_sell_upbit"
  qty           Float
  buyExchange   String
  buyPrice      Float
  sellExchange  String
  sellPrice     Float
  notionalKrw   Float    @default(0) // qty * buyPrice — 일일 한도 집계 기준
  grossKrw      Float    @default(0) // 매도gross - 매수gross (수수료 전)
  feeKrw        Float    @default(0)
  netKrw        Float    @default(0)
  status        String   // "detected" | "filled" | "partial_flattened" | "partial_hold" | "flatten_failed" | "failed"
  note          String?  @db.Text
  detectedAt    DateTime @default(now())
  executedAt    DateTime?

  @@index([botId, executedAt])
  @@index([botId, status])
  @@map("inventory_arb_trades")
}
```

- [ ] **Step 2: 마이그레이션 실행 (dev DB — Bash 도구로 직접)**

> DB 스키마 변경은 사용자에게 맡기지 말고 직접 실행(글로벌 규칙). 로컬 `.env`의 `DATABASE_URL`이 **dev DB**를 가리키는지 먼저 확인(production 금지).

Run: `npx prisma migrate dev --name add_inventory_arb_bot`
Expected: 마이그레이션 파일 생성 + dev DB에 `inventory_arb_bots`, `inventory_arb_trades` 테이블 생성 + prisma client 재생성 성공

- [ ] **Step 3: 타입 체크 (client 재생성 확인)**

Run: `npx tsc --noEmit`
Expected: 에러 0개 — `mainPrisma.inventoryArbBot` / `inventoryArbTrade` 접근 가능

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: InventoryArbBot/InventoryArbTrade 모델 추가 (메인 DB)"
```

---

## Task 6: 오케스트레이션 서비스 — 봇별 감지→게이트→실행/알림→기록

**Files:**
- Create: `src/services/inventory-arb.service.ts`
- Test: `__tests__/services/inventory-arb-service.test.ts`

> 이 서비스는 DB·거래소 클라이언트·카톡을 다루므로, 테스트는 **순수 결정 로직**(자동실행 여부, killSwitch/enabled 게이트, flatten_failed 후처리 지시)만 뽑아 검증한다. 실제 실행 배선은 Task 8 통합 스모크에서 확인.

- [ ] **Step 1: 실패 테스트 작성 (결정 헬퍼)**

```typescript
import { decideAction, buildEmergencyMessage } from '../../src/services/inventory-arb.service';

describe('decideAction', () => {
  const bot = { enabled: true, killSwitch: false, autoExecute: true };

  it('killSwitch면 skip', () => {
    expect(decideAction({ ...bot, killSwitch: true }).action).toBe('skip');
  });
  it('enabled=false면 skip', () => {
    expect(decideAction({ ...bot, enabled: false }).action).toBe('skip');
  });
  it('autoExecute=true면 execute', () => {
    expect(decideAction(bot).action).toBe('execute');
  });
  it('autoExecute=false면 notify (반자동 = 알림만)', () => {
    expect(decideAction({ ...bot, autoExecute: false }).action).toBe('notify');
  });
});

describe('buildEmergencyMessage', () => {
  it('flatten_failed 정보를 포함', () => {
    const msg = buildEmergencyMessage('XRP', 4, 'net long but ...');
    expect(msg).toContain('XRP');
    expect(msg).toContain('killSwitch');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest inventory-arb-service`
Expected: FAIL — 모듈/함수 없음

- [ ] **Step 3: 구현 작성**

아래는 완전한 서비스 구조다. `getOrderbookTop`, credential 로드(`mainPrisma.credential` + `decrypt`), 잔고 조회, 카톡은 기존 패턴(Task 참조: maker-taker-simulator-agent.ts의 `getUpbitClientFor`/`getBithumbClientFor`)을 따른다.

```typescript
import mainPrisma from '../config/database';
import { decrypt } from '../utils/encryption';
import { UpbitService } from './upbit.service';
import { BithumbClient } from './exchange/bithumb-client';
import { UpbitLeg, BithumbLeg, type ExchangeLeg } from './exchange-leg';
import { detectOpportunity } from './inventory-arb/spread-detector';
import { evaluateFeasibility } from './inventory-arb/feasibility-gate';
import { executeArb } from './inventory-arb/executor';
import type { BookTop, ExchangeName, ExecutorResult, SpreadOpportunity } from './inventory-arb/types';
import { kakaoNotifyService } from './kakao-notify.service';

// ── 순수 결정 헬퍼 (테스트 대상) ──────────────────────────────────────────
export function decideAction(bot: { enabled: boolean; killSwitch: boolean; autoExecute: boolean }):
  { action: 'skip' | 'execute' | 'notify' } {
  if (bot.killSwitch || !bot.enabled) return { action: 'skip' };
  return { action: bot.autoExecute ? 'execute' : 'notify' };
}

export function buildEmergencyMessage(symbol: string, imbalanceQty: number, note: string): string {
  return `🚨 재고형 아비 flatten 실패 — ${symbol} 방향노출 ${imbalanceQty} 잔존!\n봇 killSwitch ON + 정지됨. 수동 확인 필요.\n(${note})`;
}

// ── 동시성 락: 같은 봇 중복 실행 방지 ────────────────────────────────────
const inFlightBots = new Set<number>();

class InventoryArbService {
  private upbitClients = new Map<number, UpbitService>();
  private bithumbClients = new Map<number, BithumbClient>();

  /** 에이전트가 사이클마다 호출 */
  async scanOnce(): Promise<void> {
    const bots = await mainPrisma.inventoryArbBot.findMany({ where: { enabled: true, killSwitch: false } });
    for (const bot of bots) {
      if (inFlightBots.has(bot.id)) continue;
      inFlightBots.add(bot.id);
      try {
        await this.processBot(bot);
      } catch (err: any) {
        console.error(`[InventoryArb] bot ${bot.id} 처리 실패:`, err.message);
      } finally {
        inFlightBots.delete(bot.id);
      }
    }
  }

  private async processBot(bot: any): Promise<void> {
    // 1. 양쪽 호가 (top-level REST) — spec §6 대비 축소(선행조건: canary 확대 전 full-depth)
    const upbitClient = await this.getUpbit(bot.userId);
    const bithumbClient = await this.getBithumb(bot.userId);
    const [upbitTop, bithumbTop] = await Promise.all([
      upbitClient.getOrderbookTop(bot.symbol),
      bithumbClient.getOrderbookTop(bot.symbol),
    ]);
    if (!upbitTop || !bithumbTop) return;

    const upbitBook: BookTop = { bid: upbitTop.bid, ask: upbitTop.ask, bidQty: upbitTop.bidQty, askQty: upbitTop.askQty };
    const bithumbBook: BookTop = { bid: bithumbTop.bid, ask: bithumbTop.ask, bidQty: bithumbTop.bidQty, askQty: bithumbTop.askQty };

    // 2. 감지
    const opp = detectOpportunity(upbitBook, bithumbBook);
    if (!opp) return;

    // 3. 잔고 조회 (게이트 사이징용 — 매도측 코인, 매수측 KRW)
    const { sellCoinBalance, buyKrwBalance } =
      await this.fetchBalances(bot, opp, upbitClient, bithumbClient);

    // 4. 오늘 집행량
    const { todayNotionalKrw, todayCount } = await this.fetchTodayUsage(bot.id);

    // 5. 게이트
    const feas = evaluateFeasibility({
      opp, minSpreadBps: bot.minSpreadBps, anomalyMaxBps: bot.anomalyMaxBps,
      maxOrderKrw: bot.maxOrderKrw, dailyMaxKrw: bot.dailyMaxKrw, dailyMaxCount: bot.dailyMaxCount,
      todayNotionalKrw, todayCount, sellCoinBalance, buyKrwBalance, buyFeeBps: bot.buyFeeBps,
    });
    if (!feas.ok) {
      console.log(`[InventoryArb] bot ${bot.id} gate: ${feas.reason}`);
      return;
    }

    // 6. 실행 여부 결정
    const decision = decideAction(bot);
    if (decision.action === 'notify') {
      await this.notifyOpportunity(bot, opp, feas);
      await this.recordDetected(bot, opp, feas);
      return;
    }

    // 7. record-before-fire
    const trade = await mainPrisma.inventoryArbTrade.create({
      data: {
        botId: bot.id, symbol: bot.symbol, direction: opp.direction, qty: feas.qty,
        buyExchange: opp.buyExchange, buyPrice: opp.buyPrice,
        sellExchange: opp.sellExchange, sellPrice: opp.sellPrice,
        notionalKrw: feas.notionalKrw, status: 'detected', note: `pre-fire spread=${opp.spreadBps}bp`,
      },
    });

    // 8. ExchangeLeg 매핑
    const { buyLeg, sellLeg } = this.buildLegs(opp, upbitClient, bithumbClient);

    // 9. 실행 (flatten 가능 여부는 executor가 실제 주문 결과로 판정 — 사전 잔고 전달 불필요)
    const result = await executeArb({
      buyLeg, sellLeg, symbol: bot.symbol, qty: feas.qty,
      buyPrice: opp.buyPrice, sellPrice: opp.sellPrice, fallbackMode: bot.fallbackMode,
    });

    // 10. 결과 기록 + 후처리
    await this.persistResult(bot, trade.id, opp, feas, result);
  }

  private async persistResult(bot: any, tradeId: number, opp: SpreadOpportunity, feas: any, result: ExecutorResult): Promise<void> {
    const now = new Date();
    const base = { status: result.kind, executedAt: now };
    if (result.kind === 'filled' || result.kind === 'partial_flattened') {
      // grossKrw는 flatten leg까지 반영해 net과 일관되게(gross - fee = net) 기록
      const gross = result.netKrw + result.feeKrw;
      await mainPrisma.inventoryArbTrade.update({
        where: { id: tradeId },
        data: { ...base, grossKrw: +gross.toFixed(4), feeKrw: +result.feeKrw.toFixed(4), netKrw: +result.netKrw.toFixed(4), note: result.note },
      });
      await this.notifyResult(bot, opp, result);
    } else if (result.kind === 'flatten_failed') {
      // 터미널: killSwitch ON + 봇 정지 + 긴급 카톡. 재시도 금지.
      // 각 부수효과를 독립 try/catch로 실행 — DB 오류가 정지/알림을 서로 삼키지 않도록(안전망 보장).
      // 순서: 정지(killSwitch) → 알림(카톡) → 기록(trade).
      try {
        await mainPrisma.inventoryArbBot.update({ where: { id: bot.id }, data: { killSwitch: true, enabled: false } });
      } catch (e: any) {
        console.error(`[InventoryArb] bot ${bot.id} killSwitch 설정 실패:`, e.message);
      }
      try {
        await kakaoNotifyService.sendToMe(buildEmergencyMessage(bot.symbol, result.imbalanceQty, result.note));
      } catch (e: any) {
        console.error(`[InventoryArb] bot ${bot.id} 긴급 카톡 발송 실패:`, e.message);
      }
      try {
        await mainPrisma.inventoryArbTrade.update({ where: { id: tradeId }, data: { ...base, note: result.note } });
      } catch (e: any) {
        console.error(`[InventoryArb] bot ${bot.id} trade#${tradeId} 기록 실패:`, e.message);
      }
    } else {
      // partial_hold | failed
      await mainPrisma.inventoryArbTrade.update({ where: { id: tradeId }, data: { ...base, note: result.kind === 'partial_hold' ? result.note : result.reason } });
    }
  }

  // ── 아래 헬퍼는 maker-taker-simulator-agent.ts 패턴을 그대로 따른다 ──
  private async getUpbit(userId: number): Promise<UpbitService> {
    const cached = this.upbitClients.get(userId);
    if (cached) return cached;
    const cred = await mainPrisma.credential.findFirst({ where: { userId, exchange: 'upbit' } });
    if (!cred) throw new Error(`Upbit credential not found: userId=${userId}`);
    const svc = new UpbitService({ accessKey: decrypt(cred.apiKey), secretKey: decrypt(cred.secretKey) });
    this.upbitClients.set(userId, svc);
    return svc;
  }

  private async getBithumb(userId: number): Promise<BithumbClient> {
    const cached = this.bithumbClients.get(userId);
    if (cached) return cached;
    const cred = await mainPrisma.credential.findFirst({ where: { userId, exchange: 'bithumb' } });
    if (!cred) throw new Error(`Bithumb credential not found: userId=${userId}`);
    const c = new BithumbClient({ accessKey: decrypt(cred.apiKey), secretKey: decrypt(cred.secretKey) });
    this.bithumbClients.set(userId, c);
    return c;
  }

  private buildLegs(opp: SpreadOpportunity, upbit: UpbitService, bithumb: BithumbClient): { buyLeg: ExchangeLeg; sellLeg: ExchangeLeg } {
    const upbitLeg = new UpbitLeg(upbit);
    const bithumbLeg = new BithumbLeg(bithumb);
    return opp.buyExchange === 'upbit'
      ? { buyLeg: upbitLeg, sellLeg: bithumbLeg }
      : { buyLeg: bithumbLeg, sellLeg: upbitLeg };
  }

  private async fetchBalances(bot: any, opp: SpreadOpportunity, upbit: UpbitService, bithumb: BithumbClient):
    Promise<{ sellCoinBalance: number; buyKrwBalance: number }> {
    // 게이트 사이징용 잔고만 조회. flatten 잔고는 executor가 실제 주문 결과로 판정하므로 불필요.
    // 업비트: getAccounts() → {currency, balance}; 빗썸: getBalances() → {available}
    const upbitAccounts = await upbit.getAccounts(); // any[]
    const upbitBal = (cur: string) => Number(upbitAccounts.find((a: any) => a.currency === cur)?.balance ?? 0);
    const bithumbBalances = await bithumb.getBalances(); // Record<string,{available}>
    const bithumbBal = (cur: string) => bithumbBalances[cur]?.available ?? 0;

    const coinOf = (ex: ExchangeName, type: 'coin' | 'krw') =>
      ex === 'upbit'
        ? (type === 'coin' ? upbitBal(bot.symbol) : upbitBal('KRW'))
        : (type === 'coin' ? bithumbBal(bot.symbol) : bithumbBal('KRW'));

    return {
      sellCoinBalance: coinOf(opp.sellExchange, 'coin'), // 매도측 코인 재고 (매도 사이징)
      buyKrwBalance: coinOf(opp.buyExchange, 'krw'), // 매수측 KRW (매수 사이징)
    };
  }

  private async fetchTodayUsage(botId: number): Promise<{ todayNotionalKrw: number; todayCount: number }> {
    // 일일 한도 창은 KST 자정 기준으로 명시 계산 — 컨테이너 TZ가 UTC여도 안전(서버시계 의존 금지).
    const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
    const kstNow = new Date(Date.now() + KST_OFFSET_MS);
    kstNow.setUTCHours(0, 0, 0, 0);
    const start = new Date(kstNow.getTime() - KST_OFFSET_MS);
    const rows = await mainPrisma.inventoryArbTrade.findMany({
      where: { botId, executedAt: { gte: start }, status: { in: ['filled', 'partial_flattened'] } },
      select: { notionalKrw: true },
    });
    return { todayNotionalKrw: rows.reduce((s, r) => s + r.notionalKrw, 0), todayCount: rows.length };
  }

  private async recordDetected(bot: any, opp: SpreadOpportunity, feas: any): Promise<void> {
    await mainPrisma.inventoryArbTrade.create({
      data: {
        botId: bot.id, symbol: bot.symbol, direction: opp.direction, qty: feas.qty,
        buyExchange: opp.buyExchange, buyPrice: opp.buyPrice, sellExchange: opp.sellExchange, sellPrice: opp.sellPrice,
        notionalKrw: feas.notionalKrw, status: 'detected', note: `반자동 감지 spread=${opp.spreadBps}bp (미실행)`,
      },
    });
  }

  private async notifyOpportunity(bot: any, opp: SpreadOpportunity, feas: any): Promise<void> {
    const msg = `🔔 재고형 아비 기회 · ${bot.symbol}\n방향: ${opp.direction}\n스프레드: ${opp.spreadBps}bp\n예상 물량: ${feas.qty} (≈${Math.round(feas.notionalKrw)} KRW)\n※ 반자동 모드 — 실행 안 함`;
    try { await kakaoNotifyService.sendToMe(msg); } catch (e: any) { console.error('[InventoryArb] 카톡 실패:', e.message); }
  }

  private async notifyResult(bot: any, opp: SpreadOpportunity, result: ExecutorResult): Promise<void> {
    if (result.kind !== 'filled' && result.kind !== 'partial_flattened') return;
    const tag = result.kind === 'partial_flattened' ? '⚠️부분체결→flatten' : '✅체결';
    const msg = `${tag} 재고형 아비 · ${bot.symbol}\n${opp.direction} netKrw=${result.netKrw}\n${result.note}`;
    try { await kakaoNotifyService.sendToMe(msg); } catch (e: any) { console.error('[InventoryArb] 카톡 실패:', e.message); }
  }
}

export const inventoryArbService = new InventoryArbService();
```

> 구현 시 검증 필요: `UpbitService.getAccounts()` 반환 형태(currency/balance 필드명)와 `BithumbClient.getBalances()` 반환 형태를 실제 코드에서 확인해 `fetchBalances`를 맞출 것. maker-taker-simulator-agent.ts `getBithumbAvailableBalances`(line 1118~)가 `getBalances()` → `{available}` 사용을 확인해 준다. 업비트는 `upbitClient.getAccounts()`가 배열.

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest inventory-arb-service`
Expected: PASS (5개)

- [ ] **Step 5: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 에러 0개

- [ ] **Step 6: Commit**

```bash
git add src/services/inventory-arb.service.ts __tests__/services/inventory-arb-service.test.ts
git commit -m "feat: 재고형 아비 오케스트레이션 서비스"
```

---

## Task 7: InventoryArbAgent (BaseAgent, REST 폴링)

**Files:**
- Create: `src/agents/inventory-arb-agent.ts`

- [ ] **Step 1: 에이전트 작성**

```typescript
import { BaseAgent } from './base-agent';
import { inventoryArbService } from '../services/inventory-arb.service';

/**
 * 재고형 아비트리지 에이전트 (spec 2026-09-19)
 * - 업비트↔빗썸 크로스 스프레드 감지 → 완전자동 실행 or 반자동 알림
 * - REST 폴링 5초 주기 (BaseAgent 순차 setTimeout 루프)
 * - ⚠️ 실거래 자동 주문. 기본 OFF(enabled=false) + canary.
 */
export class InventoryArbAgent extends BaseAgent {
  constructor() {
    super({
      id: 'inventory-arb',
      name: 'InventoryArbAgent',
      description: '재고형 아비트리지 (업비트↔빗썸 크로스 스프레드, 완전자동/반자동)',
      cycleIntervalMs: 5000,
    });
  }

  protected async onStart(): Promise<void> {
    console.log('[InventoryArbAgent] 시작 — 5초 주기 폴링 (기본 봇 OFF)');
  }

  protected async onStop(): Promise<void> {
    console.log('[InventoryArbAgent] 정지');
  }

  protected async onCycle(): Promise<void> {
    await inventoryArbService.scanOnce();
  }
}

export const inventoryArbAgent = new InventoryArbAgent();
```

- [ ] **Step 2: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 에러 0개

- [ ] **Step 3: Commit**

```bash
git add src/agents/inventory-arb-agent.ts
git commit -m "feat: InventoryArbAgent 5초 폴링 에이전트"
```

---

## Task 8: 컨트롤러 + 라우트 (CRUD + 토글)

**Files:**
- Create: `src/controllers/inventory-arb.controller.ts`
- Create: `src/routes/inventory-arb.ts`

- [ ] **Step 1: 컨트롤러 작성**

> `req.user`는 `authenticate` 미들웨어가 주입(기존 bot.controller.ts 패턴 확인). 아래는 표준 CRUD + 토글.

```typescript
import { Request, Response, NextFunction } from 'express';
import mainPrisma from '../config/database';

function userId(req: Request): number {
  return (req as any).user.id;
}

export async function createBot(req: Request, res: Response, next: NextFunction) {
  try {
    const { symbol, minSpreadBps, anomalyMaxBps, maxOrderKrw, dailyMaxKrw, dailyMaxCount, fallbackMode, buyFeeBps } = req.body;
    if (!symbol || typeof maxOrderKrw !== 'number') {
      return res.status(400).json({ error: 'symbol, maxOrderKrw 필수' });
    }
    const bot = await mainPrisma.inventoryArbBot.create({
      data: {
        userId: userId(req), symbol: String(symbol).toUpperCase(),
        minSpreadBps: minSpreadBps ?? 30, anomalyMaxBps: anomalyMaxBps ?? 2000,
        maxOrderKrw, dailyMaxKrw: dailyMaxKrw ?? null, dailyMaxCount: dailyMaxCount ?? null,
        fallbackMode: fallbackMode === 'hold' ? 'hold' : 'market_flatten',
        buyFeeBps: buyFeeBps ?? 5,
        // enabled/autoExecute/killSwitch는 스키마 기본값(전부 안전측) 사용 — 생성 시 켜지 않음
      },
    });
    res.status(201).json(bot);
  } catch (e) { next(e); }
}

export async function getBots(req: Request, res: Response, next: NextFunction) {
  try {
    const bots = await mainPrisma.inventoryArbBot.findMany({ where: { userId: userId(req) }, orderBy: { id: 'desc' } });
    res.json(bots);
  } catch (e) { next(e); }
}

export async function getTrades(req: Request, res: Response, next: NextFunction) {
  try {
    const botId = Number(req.params.id);
    const bot = await mainPrisma.inventoryArbBot.findFirst({ where: { id: botId, userId: userId(req) } });
    if (!bot) return res.status(404).json({ error: 'not found' });
    const trades = await mainPrisma.inventoryArbTrade.findMany({ where: { botId }, orderBy: { id: 'desc' }, take: 100 });
    res.json(trades);
  } catch (e) { next(e); }
}

export async function updateBot(req: Request, res: Response, next: NextFunction) {
  try {
    const botId = Number(req.params.id);
    const bot = await mainPrisma.inventoryArbBot.findFirst({ where: { id: botId, userId: userId(req) } });
    if (!bot) return res.status(404).json({ error: 'not found' });

    const allowed = ['minSpreadBps', 'anomalyMaxBps', 'maxOrderKrw', 'dailyMaxKrw', 'dailyMaxCount', 'fallbackMode', 'buyFeeBps', 'autoExecute', 'enabled', 'killSwitch'] as const;
    const data: Record<string, any> = {};
    for (const k of allowed) if (k in req.body) data[k] = req.body[k];

    // enabled false→true 전환 시 lastResumeAt 기록 (canary 관찰 기준)
    if (data.enabled === true && !bot.enabled) data.lastResumeAt = new Date();

    const updated = await mainPrisma.inventoryArbBot.update({ where: { id: botId }, data });
    res.json(updated);
  } catch (e) { next(e); }
}

export async function deleteBot(req: Request, res: Response, next: NextFunction) {
  try {
    const botId = Number(req.params.id);
    const bot = await mainPrisma.inventoryArbBot.findFirst({ where: { id: botId, userId: userId(req) } });
    if (!bot) return res.status(404).json({ error: 'not found' });
    await mainPrisma.inventoryArbTrade.deleteMany({ where: { botId } });
    await mainPrisma.inventoryArbBot.delete({ where: { id: botId } });
    res.status(204).end();
  } catch (e) { next(e); }
}
```

- [ ] **Step 2: 라우트 작성**

```typescript
import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import { createBot, getBots, getTrades, updateBot, deleteBot } from '../controllers/inventory-arb.controller';

const router = Router();
router.use(authenticate);

router.post('/', createBot);
router.get('/', getBots);
router.get('/:id/trades', getTrades);
router.put('/:id', updateBot);
router.delete('/:id', deleteBot);

export default router;
```

- [ ] **Step 3: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 에러 0개

> 검증: `import { authenticate } from '../middlewares/auth'`가 실제 export 이름과 맞는지, `req.user` 형태가 맞는지 bot.controller.ts / routes/bots.ts에서 확인 후 필요 시 맞출 것.

- [ ] **Step 4: Commit**

```bash
git add src/controllers/inventory-arb.controller.ts src/routes/inventory-arb.ts
git commit -m "feat: 재고형 아비 봇 CRUD 컨트롤러/라우트"
```

---

## Task 9: 배선 — 에이전트 등록 + 라우트 mount + export

**Files:**
- Modify: `src/agents/index.ts`
- Modify: `src/index.ts`
- Modify: `src/routes/index.ts`

- [ ] **Step 1: `src/agents/index.ts`에 export 추가**

기존 export 목록 끝에 추가:

```typescript
export { InventoryArbAgent, inventoryArbAgent } from './inventory-arb-agent';
```

- [ ] **Step 2: `src/index.ts`에 register 추가**

기존 `agentManager.register(new MultiExchangeArbAgent());` 다음 줄에 추가(import도 상단에 추가):

```typescript
// 상단 import 영역
import { InventoryArbAgent } from './agents/inventory-arb-agent';
// register 영역 (다른 register 아래)
agentManager.register(new InventoryArbAgent());
```

- [ ] **Step 3: `src/routes/index.ts`에 mount 추가**

기존 라우트 mount 영역에 추가(import도):

```typescript
import inventoryArbRoutes from './inventory-arb';
// mount 영역
router.use('/inventory-arb', inventoryArbRoutes);
```

- [ ] **Step 4: 타입 체크 + 빌드**

Run: `npx tsc --noEmit`
Expected: 에러 0개

Run: `npm run build`
Expected: 컴파일 성공 (0 errors)

- [ ] **Step 5: Commit**

```bash
git add src/agents/index.ts src/index.ts src/routes/index.ts
git commit -m "feat: 재고형 아비 에이전트 등록 + 라우트 mount"
```

---

## Task 10: 전체 테스트 + 서버 기동 스모크

**Files:** (없음 — 검증만)

- [ ] **Step 1: 전체 jest 실행**

Run: `npm test`
Expected: 신규 테스트 25개(detector 4 + gate 8 + executor 8 + service 5) 포함 전체 PASS, 기존 테스트 회귀 없음

- [ ] **Step 2: 서버 기동 확인 (dev)**

Run: `npm run dev` (수 초 후 Ctrl+C)
Expected: `[InventoryArbAgent] 시작 — 5초 주기 폴링` 로그 출력 + 크래시 없음. 봇이 0개이므로 scanOnce는 즉시 반환.

- [ ] **Step 3: 커버리지 확인(선택)**

Run: `npm run test:coverage -- inventory-arb`
Expected: inventory-arb 모듈 커버리지 80%+ (순수 함수는 100%에 근접)

- [ ] **Step 4: 최종 Commit (필요 시 문서/정리)**

```bash
git add -A
git commit -m "test: 재고형 아비 전체 테스트 통과 확인" --allow-empty
```

---

## Self-Review 결과 (계획 작성자 체크)

- **Spec 커버리지:** §3 원리→Task 2/4, §6 데이터흐름→Task 6, §7 부분체결 fallback→Task 4(핵심), §8 안전장치(enabled/killSwitch/한도/anomaly/재고precheck)→Task 3+6+8, §9 모델→Task 5, §11 테스트→Task 2/3/4/6. **§8 입출금중단 감지는 이번 계획에서 제외**(follow-up) — 재고형은 전송 불필요라 canary 단계에선 재고 소진 정지로 갈음. 아래 "범위 밖" 참조.
- **Placeholder:** 없음(모든 코드 스텝에 실제 코드).
- **타입 일관성:** `detectOpportunity`/`evaluateFeasibility`/`executeArb` 시그니처가 Task 6 service 호출부와 일치. `ExecutorResult` 유니온 kind가 executor·service·types에서 동일.

## 범위 밖 (이번 계획 제외 — 구현 후 follow-up)
- **입출금 중단(wallet_state) 감지 자동 정지** (spec §8): 재고 소진 리스크 경고용. `multi-arb-wallet-status.service` 재사용해 후속 추가.
- ~~full-depth REST 사이징~~ → **2026-09-20 구현 완료** (`orderbook-depth.ts` + detector depth walk).
- **반자동 승인 UI/엔드포인트**: 사용자 결정으로 완전자동 중심 → 승인 라운드트립 후속.
- **크래시 복구(고아 포지션 재조정)**: record-before-fire로 추적은 가능하나 자동 복구는 canary(사람 감시)에서 후속.
- **사후 리컨실(reconciler)** (리뷰 I1/잔여): 양쪽 leg가 모두 throw(rejected)했는데 실제로는 한쪽이 체결됐을 수 있는 경우(`failed`로 보고되나 노출 잔존 가능) — 사이클 후 잔고 대조로 감지. **executor의 `failed`에는 자동 재시도 금지**(이중 실행 위험). canary 확대 전 선행 권장.
- **dust 누적 running-total 알림** (리뷰 Minor): 개별 dust(<5000 KRW)는 수용하지만 다건 누적 시 방향 재고가 쌓임 → 누적 임계 초과 시 알림/수동 리밸런싱 유도.
- **프론트엔드 감시목록/설정 UI**: 별도 프론트 계획(터미널 2).

## ⚠️ 배포·운영 주의 (구현 완료 후)
1. 첫 배포 시 **모든 봇 enabled=false, autoExecute=false** 확인. canary는 사람이 명시적으로 소액(maxOrderKrw 1만 등)으로 토글.
2. 첫 live 체결은 반드시 사람이 검증 — 특히 **빗썸 매수 수수료 코인 차감 여부**(tolerance band 밴드값 재조정 근거).
3. `fetchTodayUsage`의 자정 기준은 서버 timezone. 배포 서버 `date +%Z` 확인(글로벌 규칙 — UTC면 KST 자정과 어긋남).
4. 이 최고위험 기능은 구현 착수/완료 시 **사용자 눈으로 executor.ts + service persistResult를 한 번 리뷰** 권장.
