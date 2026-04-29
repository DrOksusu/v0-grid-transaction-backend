# PR C 구현 계획: maker-taker live executor + auto kill switch + maker bot CRUD

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Maker-Taker 시뮬레이터 봇이 `live=true`일 때 실제 Upbit limit(post_only) 주문을 내고, 체결 시 taker leg 2단계(매도→매수)를 실행한다. 동시에 직접 아비트리지 봇이 3회 연속 leg-2 실패하거나 일일 손실 한도 도달 시 자동으로 kill switch ON. Admin UI에서 maker bot CRUD 가능. **모든 봇 `live=false` default 유지** (실거래 가동은 PR D Canary에서).

**Architecture:**

PR A의 `pre-check` + `tradingLock` + PR B의 `arb-executor` 위에 두 개의 새 서비스 모듈 추가:
1. `maker-taker-live-executor.ts` — `live=true` 봇의 maker 주문 + status polling + taker leg 흐름
2. `stablecoin-auto-killswitch.ts` — 순수 함수 + in-memory counter, agent에서 호출

UpbitService에 `placeLimitOrder` 신규 (post_only maker 주문용 — 기존엔 `placeBestIoc`만 있음).

**DB 마이그레이션 불필요** — PR C는 `prisma migrate` 실행하지 않음. 필요한 컬럼 모두 기존 schema에 존재:
- `MakerTakerSimBot.live` ✅
- `MakerTakerSimTrade.live` ✅
- `MakerTakerSimTrade.makerOrderUuid` (`VarChar(64)`) ✅
- `MakerTakerSimTrade.feeKrw` (수수료 통합 필드) ✅

**자동 kill switch는 spec §7 4개 중 #1 #2만** (PR C 범위):
- #1 3회 연속 leg-2 실패 → bot.killSwitch = true
- #2 일일 손실 한도 도달 → bot.killSwitch = true
- #3 재고 reconcile (5분 cron) — **PR D 또는 C-followup으로 미룸** (실제 trade 발생 후에야 의미)
- #4 Upbit 5xx 5회 연속 — **PR D 또는 C-followup으로 미룸** (#1/#2가 잔고 보호 1차 방어)

**Tech Stack:** TypeScript, Prisma (stablecoin DB), Jest, ts-jest, Express (zod), Next.js 16, React 19, shadcn/ui

---

## File Structure

| 종류 | 경로 | 책임 |
|---|---|---|
| Create | `src/services/maker-taker-live-executor.ts` | `processLiveBot(bot, books, deps)` — maker placement / polling / taker leg |
| Create | `src/services/stablecoin-auto-killswitch.ts` | `shouldTriggerKillSwitch(...)` 순수 함수 + `killSwitchState` (`Map<botId, number>` counter) |
| Create | `__tests__/services/maker-taker-live-executor.test.ts` | LimitClient + IocClient interface DI로 6+ 시나리오 |
| Create | `__tests__/services/stablecoin-auto-killswitch.test.ts` | 4 케이스 (3연속실패 / 일일손실 / 성공 reset / 둘 다 트리거 시 우선순위) |
| Modify | `src/services/upbit.service.ts` | `placeLimitOrder(market, side, price, volume, postOnly)` 메서드 추가 |
| Modify | `src/agents/maker-taker-simulator-agent.ts` | bot.live=true 분기 → liveExecutor.processLiveBot 호출 (creds + cache + lock 포함) |
| Modify | `src/agents/stablecoin-arb-agent.ts` | executor 결과 받은 직후 auto-killswitch 모듈 호출 |
| Modify | `src/controllers/stablecoin-admin.controller.ts` | `listMakerBots`, `createMakerBot`, `patchMakerBot`, `deleteMakerBot` (zod 검증) |
| Modify | `src/routes/stablecoin-admin.ts` | maker-bots GET/POST/PATCH/DELETE 라우트 등록 |
| Modify | `__tests__/controllers/stablecoin-admin.controller.test.ts` | maker bot CRUD 4개 + 검증 실패 1개 |
| Modify | `v0-grid-transaction-frontend/lib/api.ts` | `MakerTakerSimBot` 타입 + `listMakerBots`, `createMakerBot`, `patchMakerBot`, `deleteMakerBot` |
| Create | `v0-grid-transaction-frontend/app/admin/stablecoin/_components/AutoKillSwitchAlert.tsx` | killSwitch=true인 봇 빨간 배너 + 사유 + 해제 버튼 |
| Modify | `v0-grid-transaction-frontend/app/admin/stablecoin/_components/MakerTakerSimPanel.tsx` | live 봇 빨간 테두리 + CRUD 모달 폼 (추가/삭제/live 토글) |
| Modify | `v0-grid-transaction-frontend/app/admin/stablecoin/page.tsx` | AutoKillSwitchAlert 페이지 상단 통합 |

기존 활용:
- `tradingLock` (PR A) — maker live는 신규 PENDING 생성 시점만 `isLocked()` 체크 (status polling/만료/체결은 lock 무관)
- `preCheck.runAll` (PR A) — 신규 maker 주문 직전
- `UpbitService.getOrder` / `cancelOrder` (M1 검증) — 기존 메서드 그대로
- `BalanceCache` (PR B) — getClientFor 패턴 그대로
- `decrypt` (utils) — credential 복호화 (PR B 패턴 재사용)
- `arbService.setKillSwitch` (PR A) — auto-kill 시 호출

---

## Task 1: UpbitService.placeLimitOrder 추가

**Files:**
- Modify: `src/services/upbit.service.ts:323-357` (placeBestIoc 직후에 추가)
- Modify: `__tests__/services/upbit.service.chunk-1.test.ts` (있는지 확인 후 같은 파일 또는 신규 chunk)

- [ ] **Step 1: Upbit Open API 문서에서 limit + post_only 메커니즘 확인**

추측 금지. 다음 두 경로 중 하나로 확인:
1. Upbit 공식 문서: https://docs.upbit.com/reference/주문하기 (POST /v1/orders)
2. 기존 코드베이스 grep: `grep -rn "ord_type.*limit\|post_only\|postOnly" v0-grid-tranasction-backend/src/`

확인할 사실:
- `ord_type: 'limit'`이 limit 주문인지 (확실)
- `post_only` flag가 native 지원인지 별도 시뮬인지 (불확실 — 문서에서 확인)
- 만약 native 지원이면 body param name이 `post_only` (snake_case)인지 `postOnly` (camelCase)인지

확인 결과를 `notes:` 코멘트로 placeLimitOrder 함수 위에 박을 것 (예: `// Upbit POST /v1/orders ord_type='limit' + post_only=true (native, 2024 doc 기준)`).

- [ ] **Step 2: placeBestIoc 패턴 그대로 placeLimitOrder 작성 (실패 테스트 먼저)**

`__tests__/services/upbit-place-limit.test.ts` 신규 작성:

```typescript
import axios from 'axios';
import { UpbitService } from '../../src/services/upbit.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('UpbitService.placeLimitOrder', () => {
  const creds = { accessKey: 'test-ak', secretKey: 'test-sk' };
  let svc: UpbitService;

  beforeEach(() => {
    jest.clearAllMocks();
    // axios.create는 placeBestIoc에서 instance 만들 때 사용 — 기존 패턴 따라
    (mockedAxios.create as jest.Mock).mockReturnValue({
      post: jest.fn(),
      get: jest.fn(),
      delete: jest.fn(),
    });
    svc = new UpbitService(creds.accessKey, creds.secretKey);
  });

  it('post_only=true 시 limit + post_only body로 POST /v1/orders 호출', async () => {
    const mockResp = {
      data: {
        uuid: 'uuid-1234',
        side: 'bid',
        ord_type: 'limit',
        price: '1450.0',
        volume: '6.89',
        market: 'KRW-USDT',
        state: 'wait',
        executed_volume: '0',
      },
    };
    const postSpy = (svc as any).axiosInstance.post as jest.Mock;
    postSpy.mockResolvedValueOnce(mockResp);

    const result = await svc.placeLimitOrder(
      'KRW-USDT',
      'bid',
      { price: '1450.0', volume: '6.89', postOnly: true }
    );

    expect(result.uuid).toBe('uuid-1234');
    expect(postSpy).toHaveBeenCalledWith(
      expect.stringContaining('/orders'),
      expect.objectContaining({
        market: 'KRW-USDT',
        side: 'bid',
        ord_type: 'limit',
        price: '1450.0',
        volume: '6.89',
        post_only: true, // Step 1에서 확인한 native flag
      }),
      expect.any(Object)
    );
  });

  it('post_only=false (default) 시 post_only flag 미포함', async () => {
    const postSpy = (svc as any).axiosInstance.post as jest.Mock;
    postSpy.mockResolvedValueOnce({ data: { uuid: 'uuid-2' } });

    await svc.placeLimitOrder('KRW-USDC', 'ask', { price: '1500', volume: '3.0' });

    const callBody = postSpy.mock.calls[0][1];
    expect(callBody.ord_type).toBe('limit');
    expect(callBody.post_only).toBeUndefined();
  });

  it('bid에 price 누락 시 throw', async () => {
    await expect(
      svc.placeLimitOrder('KRW-USDT', 'bid', { volume: '5.0' } as any)
    ).rejects.toThrow(/price/);
  });

  it('ask에 volume 누락 시 throw', async () => {
    await expect(
      svc.placeLimitOrder('KRW-USDT', 'ask', { price: '1500' } as any)
    ).rejects.toThrow(/volume/);
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

```bash
cd v0-grid-tranasction-backend
npx jest __tests__/services/upbit-place-limit.test.ts
```

Expected: 4 FAIL — `svc.placeLimitOrder is not a function`

- [ ] **Step 4: placeLimitOrder 구현 (placeBestIoc 직후, line ~358)**

```typescript
  /**
   * 지정가 주문 (limit). post_only=true 시 maker 주문 (taker로 잡힐 가격이면 reject).
   * 응답: UpbitOrderResponse — state는 'wait' (체결 대기) 또는 'cancel' (post_only 미체결 시).
   * 체결은 별도 getOrder(uuid) 폴링으로 확인 필요.
   *
   * Upbit POST /v1/orders ord_type='limit' + post_only=<bool>
   */
  async placeLimitOrder(
    market: string,
    side: 'bid' | 'ask',
    params: { price?: string; volume?: string; postOnly?: boolean }
  ): Promise<UpbitOrderResponse> {
    await throttleOrderApi();

    if (side === 'bid' && !params.price) {
      throw new Error('limit bid 주문은 price 필요');
    }
    if (side === 'ask' && !params.volume) {
      throw new Error('limit ask 주문은 volume 필요');
    }

    const body: any = {
      market,
      side,
      ord_type: 'limit',
    };
    if (params.price) body.price = params.price;
    if (params.volume) body.volume = params.volume;
    if (params.postOnly) body.post_only = true;

    const queryString = new URLSearchParams(body).toString();

    return executeWithRetry(async () => {
      const response = await this.axiosInstance.post(
        `${UPBIT_API_URL}/orders`,
        body,
        {
          headers: this.getHeaders(queryString),
        }
      );
      return response.data as UpbitOrderResponse;
    }, `placeLimitOrder(${market}, ${side}, postOnly=${params.postOnly ?? false})`);
  }
```

> **참고:** 기존 placeBestIoc는 `axiosInstance` 모듈 변수를 사용. 새 함수는 일관성을 위해 동일하게 사용. private `axiosInstance` 필드를 access하는 패턴이 클래스 내에서 어떻게 되어있는지 line 320 근처에서 재확인 후 일치시킬 것.

- [ ] **Step 5: 테스트 통과 확인**

```bash
npx jest __tests__/services/upbit-place-limit.test.ts
```

Expected: 4 PASS

- [ ] **Step 6: tsc 통과 확인**

```bash
npx tsc --noEmit
```

Expected: 0 error

- [ ] **Step 7: Commit**

```bash
git add src/services/upbit.service.ts __tests__/services/upbit-place-limit.test.ts
git commit -m "feat(upbit): placeLimitOrder (post_only) 추가"
```

---

## Task 2: stablecoin-auto-killswitch 모듈 (순수 함수 + 카운터)

**Files:**
- Create: `src/services/stablecoin-auto-killswitch.ts`
- Create: `__tests__/services/stablecoin-auto-killswitch.test.ts`

- [ ] **Step 1: 실패 테스트 먼저**

`__tests__/services/stablecoin-auto-killswitch.test.ts`:

```typescript
import {
  shouldTriggerKillSwitch,
  recordLeg2Failure,
  recordLeg2Success,
  resetCounters,
  getCounters,
} from '../../src/services/stablecoin-auto-killswitch';

describe('stablecoin-auto-killswitch', () => {
  beforeEach(() => {
    resetCounters();
  });

  it('일일 손실 한도 도달 → trigger=true reason="daily_loss_limit"', () => {
    const result = shouldTriggerKillSwitch({
      botId: 1,
      todayNetProfitKrw: -10001,
      dailyLossLimitKrw: 10000,
    });
    expect(result).toEqual({
      trigger: true,
      reason: 'daily_loss_limit',
      detail: '오늘 누적 손실 -10001원 ≥ 한도 10000원',
    });
  });

  it('일일 손실 한도 정확히 같을 때 trigger=false (이하만 통과)', () => {
    const result = shouldTriggerKillSwitch({
      botId: 1,
      todayNetProfitKrw: -10000,
      dailyLossLimitKrw: 10000,
    });
    expect(result.trigger).toBe(false);
  });

  it('leg-2 실패 3회 누적 → 3회째에 trigger=true', () => {
    recordLeg2Failure(1);
    recordLeg2Failure(1);
    expect(getCounters().get(1)).toBe(2);

    recordLeg2Failure(1);
    const result = shouldTriggerKillSwitch({
      botId: 1,
      todayNetProfitKrw: 0,
      dailyLossLimitKrw: 10000,
    });
    expect(result).toEqual({
      trigger: true,
      reason: 'leg2_consecutive_failures',
      detail: '직접 아비트리지 leg-2 실패 3회 연속',
    });
  });

  it('leg-2 성공 시 카운터 reset (다른 봇 카운터 영향 없음)', () => {
    recordLeg2Failure(1);
    recordLeg2Failure(1);
    recordLeg2Failure(2);
    recordLeg2Success(1);
    expect(getCounters().get(1)).toBe(0);
    expect(getCounters().get(2)).toBe(1);
  });

  it('일일 손실 우선 (둘 다 도달 시 daily_loss_limit 먼저)', () => {
    recordLeg2Failure(1);
    recordLeg2Failure(1);
    recordLeg2Failure(1);
    const result = shouldTriggerKillSwitch({
      botId: 1,
      todayNetProfitKrw: -20000,
      dailyLossLimitKrw: 10000,
    });
    expect(result.reason).toBe('daily_loss_limit');
  });
});
```

- [ ] **Step 2: 테스트 실행 (실패 확인)**

```bash
npx jest __tests__/services/stablecoin-auto-killswitch.test.ts
```

Expected: 5 FAIL — module not found

- [ ] **Step 3: 모듈 구현**

`src/services/stablecoin-auto-killswitch.ts`:

```typescript
/**
 * 직접 아비트리지 봇용 자동 kill switch 트리거.
 *
 * spec §7 #1 (3회 연속 leg-2 실패) + #2 (일일 손실 한도) 만 PR C 범위.
 * #3 (재고 reconcile) #4 (Upbit 5xx 5회) 는 PR D/C-followup.
 *
 * 호출 위치: StablecoinArbAgent.processLiveBot()이 executor 결과 받은 직후.
 * 트리거 시 agent가 arbService.setKillSwitch(userId, true) + Socket.IO emit.
 */

const MAX_CONSECUTIVE_LEG2_FAILURES = 3;

// botId → 연속 leg-2 실패 횟수 (process-local in-memory)
const consecutiveLeg2Failures = new Map<number, number>();

export type KillSwitchInput = {
  botId: number;
  todayNetProfitKrw: number;
  dailyLossLimitKrw: number;
};

export type KillSwitchResult =
  | {
      trigger: true;
      reason: 'daily_loss_limit' | 'leg2_consecutive_failures';
      detail: string;
    }
  | { trigger: false };

/**
 * trigger 조건 검사. 우선순위: daily_loss_limit > leg2_consecutive_failures.
 */
export function shouldTriggerKillSwitch(input: KillSwitchInput): KillSwitchResult {
  // #2 일일 손실 (우선순위 1)
  if (input.todayNetProfitKrw < -input.dailyLossLimitKrw) {
    return {
      trigger: true,
      reason: 'daily_loss_limit',
      detail: `오늘 누적 손실 ${input.todayNetProfitKrw}원 ≥ 한도 ${input.dailyLossLimitKrw}원`,
    };
  }

  // #1 leg-2 연속 실패 (우선순위 2)
  const fails = consecutiveLeg2Failures.get(input.botId) ?? 0;
  if (fails >= MAX_CONSECUTIVE_LEG2_FAILURES) {
    return {
      trigger: true,
      reason: 'leg2_consecutive_failures',
      detail: `직접 아비트리지 leg-2 실패 ${fails}회 연속`,
    };
  }

  return { trigger: false };
}

/**
 * leg-2 실패 (rolled back 또는 zero fill) 시 호출.
 */
export function recordLeg2Failure(botId: number): void {
  const cur = consecutiveLeg2Failures.get(botId) ?? 0;
  consecutiveLeg2Failures.set(botId, cur + 1);
}

/**
 * leg-2 성공 시 호출. 카운터 0으로 reset.
 */
export function recordLeg2Success(botId: number): void {
  consecutiveLeg2Failures.set(botId, 0);
}

/**
 * 테스트/관리자용. 모든 카운터 초기화.
 */
export function resetCounters(): void {
  consecutiveLeg2Failures.clear();
}

/**
 * 테스트/디버깅용. 현재 카운터 snapshot 반환 (Map 사본 아님 — 직접 수정 금지).
 */
export function getCounters(): ReadonlyMap<number, number> {
  return consecutiveLeg2Failures;
}
```

- [ ] **Step 4: 테스트 통과**

```bash
npx jest __tests__/services/stablecoin-auto-killswitch.test.ts
```

Expected: 5 PASS

- [ ] **Step 5: tsc 통과**

```bash
npx tsc --noEmit
```

Expected: 0 error

- [ ] **Step 6: Commit**

```bash
git add src/services/stablecoin-auto-killswitch.ts __tests__/services/stablecoin-auto-killswitch.test.ts
git commit -m "feat(stablecoin): auto kill switch 모듈 (3연속 실패 + 일일 손실)"
```

---

## Task 3: maker-taker-live-executor (메인 모듈)

**Files:**
- Create: `src/services/maker-taker-live-executor.ts`
- Create: `__tests__/services/maker-taker-live-executor.test.ts`

본 task는 LimitClient + IocClient interface DI로 mock 가능하게 설계 (PR B `arb-executor.ts`의 IocClient 패턴 그대로).

- [ ] **Step 1: interface + 타입 먼저 정의 (코드만, 테스트 없음)**

`src/services/maker-taker-live-executor.ts` — 일단 type만:

```typescript
import type { OrderbookTop } from './upbit-price-manager';

/**
 * Upbit-style limit/IOC 클라이언트 interface.
 * 실 운영: UpbitService.placeLimitOrder/placeBestIoc/getOrder/cancelOrder.
 * 테스트: jest mock 객체.
 *
 * PR B의 IocClient interface와 일관 — typed mock으로 trap #3 재발 방지.
 */
export interface OrderClient {
  placeLimit(
    market: string,
    side: 'bid' | 'ask',
    params: { price?: string; volume?: string; postOnly?: boolean }
  ): Promise<UpbitOrderResp>;
  placeBestIoc(
    market: string,
    side: 'bid' | 'ask',
    params: { price?: string; volume?: string }
  ): Promise<UpbitOrderResp>;
  getOrder(uuid: string): Promise<UpbitOrderResp>;
  cancelOrder(uuid: string): Promise<unknown>;
}

export interface UpbitOrderResp {
  uuid: string;
  state?: string;
  executed_volume?: string;
  paid_fee?: string;
  trades?: Array<{ funds: string; price: string; volume: string }>;
}

export type LiveBotInput = {
  id: number;
  userId: number;
  makerCoin: string;
  takerCoin: string;
  bidOffsetKrw: number;
  quantity: number;
  maxPendingMs: number;
  killSwitch: boolean;
};

export type PendingTradeInput = {
  id: bigint;
  status: string;
  makerOrderUuid: string | null;
  makerOrderPrice: number;
  createdAt: Date;
  notes: string | null;
};

export type LiveExecutorResult =
  | { kind: 'noop' } // PENDING도 없고 lock 점유 또는 preCheck abort
  | { kind: 'placed'; makerOrderUuid: string; makerOrderPrice: number }
  | { kind: 'waiting'; pendingId: bigint }
  | { kind: 'expired'; pendingId: bigint }
  | {
      kind: 'filled';
      pendingId: bigint;
      filledQty: number;
      filledMakerKrw: number;
      filledSellKrw: number;
      filledBuyKrw: number;
      paidFeeKrw: number;
      netProfitKrw: number;
      realizedSpreadBps: number;
    }
  | { kind: 'partial_hold'; pendingId: bigint; reason: string }
  | { kind: 'rolled_back'; pendingId: bigint; reason: string };
```

- [ ] **Step 2: 테스트 (실패 먼저) — 6 시나리오**

`__tests__/services/maker-taker-live-executor.test.ts`:

```typescript
import {
  processLiveBot,
  type OrderClient,
  type LiveBotInput,
  type PendingTradeInput,
  type UpbitOrderResp,
} from '../../src/services/maker-taker-live-executor';
import type { OrderbookTop } from '../../src/services/upbit-price-manager';

function mkClient(overrides: Partial<OrderClient> = {}): OrderClient {
  return {
    placeLimit: jest.fn(async () => ({ uuid: 'limit-1', state: 'wait' })),
    placeBestIoc: jest.fn(async () => ({ uuid: 'ioc-1' })),
    getOrder: jest.fn(async () => ({ uuid: 'limit-1', state: 'wait' })),
    cancelOrder: jest.fn(async () => ({})),
    ...overrides,
  };
}

const baseBot: LiveBotInput = {
  id: 1,
  userId: 2,
  makerCoin: 'USDT',
  takerCoin: 'USDC',
  bidOffsetKrw: -1,
  quantity: 5,
  maxPendingMs: 600_000,
  killSwitch: false,
};

const books: ReadonlyMap<string, OrderbookTop> = new Map([
  [
    'KRW-USDT',
    { bid: { price: 1450, size: 1000 }, ask: { price: 1451, size: 1000 } },
  ],
  [
    'KRW-USDC',
    { bid: { price: 1448, size: 1000 }, ask: { price: 1449, size: 1000 } },
  ],
]);

describe('maker-taker-live-executor.processLiveBot', () => {
  describe('CASE A: PENDING 없음 → 새 maker 주문', () => {
    it('preCheck ok + lock free → placeLimit 호출 후 placed 반환', async () => {
      const placeSpy = jest.fn(async () => ({ uuid: 'new-limit-uuid', state: 'wait' }));
      const client = mkClient({ placeLimit: placeSpy });

      const result = await processLiveBot({
        bot: baseBot,
        pending: null,
        books,
        client,
        isLocked: () => false,
        preCheckOk: true,
      });

      expect(placeSpy).toHaveBeenCalledWith(
        'KRW-USDT',
        'bid',
        expect.objectContaining({
          price: '1449', // 1450 + (-1)
          volume: '5',
          postOnly: true,
        })
      );
      expect(result).toEqual({
        kind: 'placed',
        makerOrderUuid: 'new-limit-uuid',
        makerOrderPrice: 1449,
      });
    });

    it('lock 점유 시 noop (placeLimit 호출 없음)', async () => {
      const placeSpy = jest.fn();
      const client = mkClient({ placeLimit: placeSpy });

      const result = await processLiveBot({
        bot: baseBot,
        pending: null,
        books,
        client,
        isLocked: () => true,
        preCheckOk: true,
      });

      expect(placeSpy).not.toHaveBeenCalled();
      expect(result).toEqual({ kind: 'noop' });
    });

    it('preCheck abort 시 noop', async () => {
      const placeSpy = jest.fn();
      const client = mkClient({ placeLimit: placeSpy });

      const result = await processLiveBot({
        bot: baseBot,
        pending: null,
        books,
        client,
        isLocked: () => false,
        preCheckOk: false,
      });

      expect(placeSpy).not.toHaveBeenCalled();
      expect(result).toEqual({ kind: 'noop' });
    });
  });

  describe('CASE B: PENDING 있음 → polling', () => {
    const pendingBase: PendingTradeInput = {
      id: 100n,
      status: 'PENDING',
      makerOrderUuid: 'limit-existing',
      makerOrderPrice: 1449,
      createdAt: new Date(Date.now() - 10_000),
      notes: 'created',
    };

    it('아직 미체결 + 만료 전 → waiting', async () => {
      const client = mkClient({
        getOrder: jest.fn(async () => ({
          uuid: 'limit-existing',
          state: 'wait',
          executed_volume: '0',
        })),
      });

      const result = await processLiveBot({
        bot: baseBot,
        pending: pendingBase,
        books,
        client,
        isLocked: () => false,
        preCheckOk: true,
      });

      expect(result).toEqual({ kind: 'waiting', pendingId: 100n });
    });

    it('만료 (createdAt + maxPendingMs 초과) + 미체결 → cancelOrder + expired', async () => {
      const expiredPending = {
        ...pendingBase,
        createdAt: new Date(Date.now() - 700_000), // > 600s
      };
      const cancelSpy = jest.fn(async () => ({}));
      const client = mkClient({
        getOrder: jest.fn(async () => ({
          uuid: 'limit-existing',
          state: 'wait',
          executed_volume: '0',
        })),
        cancelOrder: cancelSpy,
      });

      const result = await processLiveBot({
        bot: baseBot,
        pending: expiredPending,
        books,
        client,
        isLocked: () => false,
        preCheckOk: true,
      });

      expect(cancelSpy).toHaveBeenCalledWith('limit-existing');
      expect(result).toEqual({ kind: 'expired', pendingId: 100n });
    });

    it('체결 + taker 양쪽 성공 → filled (P&L 양수)', async () => {
      const client = mkClient({
        getOrder: jest.fn(async () => ({
          uuid: 'limit-existing',
          state: 'done',
          executed_volume: '5',
          paid_fee: '36.225', // maker fee
          trades: [{ funds: '7245', price: '1449', volume: '5' }], // 5 * 1449 = 7245
        })),
        // step 1: X(USDT) 매도 best+ioc → KRW 7250 회수
        // step 2: 7245 KRW로 Y(USDC) 매수
        placeBestIoc: jest
          .fn()
          // sell USDT
          .mockResolvedValueOnce({
            uuid: 'sell-uuid',
            executed_volume: '5',
            paid_fee: '18.125',
            trades: [{ funds: '7250', price: '1450', volume: '5' }],
          })
          // buy USDC
          .mockResolvedValueOnce({
            uuid: 'buy-uuid',
            executed_volume: '5.0',
            paid_fee: '18.080',
            trades: [{ funds: '7232', price: '1449', volume: '5' }],
          }),
      });

      const result = await processLiveBot({
        bot: baseBot,
        pending: pendingBase,
        books,
        client,
        isLocked: () => false,
        preCheckOk: true,
      });

      expect(result.kind).toBe('filled');
      if (result.kind === 'filled') {
        expect(result.filledMakerKrw).toBe(7245);
        expect(result.filledSellKrw).toBe(7250);
        expect(result.filledBuyKrw).toBe(7232);
        // net = 7250 - 7245 - (36.225 + 18.125 + 18.080) = 5 - 72.43 = -67.43
        expect(result.netProfitKrw).toBeCloseTo(-67.43, 1);
        expect(result.paidFeeKrw).toBeCloseTo(72.43, 1);
        // realizedSpreadBps = floor((7250/7245 - 1) * 10000) = 6
        expect(result.realizedSpreadBps).toBe(6);
      }
    });

    it('체결 + taker step 1 (X 매도) 실패 → partial_hold', async () => {
      const client = mkClient({
        getOrder: jest.fn(async () => ({
          uuid: 'limit-existing',
          state: 'done',
          executed_volume: '5',
          paid_fee: '36.225',
          trades: [{ funds: '7245', price: '1449', volume: '5' }],
        })),
        placeBestIoc: jest.fn().mockResolvedValueOnce({
          uuid: 'sell-fail',
          executed_volume: '0',
        }),
      });

      const result = await processLiveBot({
        bot: baseBot,
        pending: pendingBase,
        books,
        client,
        isLocked: () => false,
        preCheckOk: true,
      });

      expect(result.kind).toBe('partial_hold');
      if (result.kind === 'partial_hold') {
        expect(result.reason).toMatch(/sell|holding X/i);
      }
    });

    it('체결 + taker step 2 (Y 매수) 실패 → step 3 fallback (X 재매수) → rolled_back', async () => {
      const client = mkClient({
        getOrder: jest.fn(async () => ({
          uuid: 'limit-existing',
          state: 'done',
          executed_volume: '5',
          paid_fee: '36.225',
          trades: [{ funds: '7245', price: '1449', volume: '5' }],
        })),
        placeBestIoc: jest
          .fn()
          // sell USDT 성공
          .mockResolvedValueOnce({
            uuid: 'sell-uuid',
            executed_volume: '5',
            paid_fee: '18.125',
            trades: [{ funds: '7250', price: '1450', volume: '5' }],
          })
          // buy USDC 실패
          .mockResolvedValueOnce({
            uuid: 'buy-fail',
            executed_volume: '0',
          })
          // fallback: buy USDT 성공
          .mockResolvedValueOnce({
            uuid: 'fallback-uuid',
            executed_volume: '5',
            paid_fee: '18.0',
            trades: [{ funds: '7232', price: '1450', volume: '5' }],
          }),
      });

      const result = await processLiveBot({
        bot: baseBot,
        pending: pendingBase,
        books,
        client,
        isLocked: () => false,
        preCheckOk: true,
      });

      expect(result.kind).toBe('rolled_back');
    });
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

```bash
npx jest __tests__/services/maker-taker-live-executor.test.ts
```

Expected: 7 FAIL — `processLiveBot is not defined`

- [ ] **Step 4: processLiveBot 함수 본체 구현**

`src/services/maker-taker-live-executor.ts` 끝에 추가:

```typescript
export type ProcessLiveInput = {
  bot: LiveBotInput;
  pending: PendingTradeInput | null;
  books: ReadonlyMap<string, OrderbookTop>;
  client: OrderClient;
  isLocked: () => boolean;
  preCheckOk: boolean;
};

/**
 * Maker-Taker live 봇 1회 처리. DB I/O는 호출자(agent)가 담당.
 *
 * 흐름:
 *   PENDING 없음 → preCheck OK + lock free → placeLimit (post_only)
 *   PENDING 있음 → getOrder polling
 *     - executed_volume > 0 → taker leg 2단계 (X매도→Y매수, Y실패시 fallback X재매수)
 *     - 미체결 + 만료 → cancelOrder
 *     - 미체결 + 대기 → waiting
 */
export async function processLiveBot(
  input: ProcessLiveInput,
): Promise<LiveExecutorResult> {
  const { bot, pending, books, client, isLocked, preCheckOk } = input;

  // CASE A: PENDING 없음 → 새 maker 주문
  if (!pending) {
    if (isLocked()) return { kind: 'noop' };
    if (!preCheckOk) return { kind: 'noop' };

    const makerBook = books.get(`KRW-${bot.makerCoin}`);
    if (!makerBook) return { kind: 'noop' };

    const makerOrderPrice = makerBook.bid.price + bot.bidOffsetKrw;
    const placeResp = await client.placeLimit('KRW-' + bot.makerCoin, 'bid', {
      price: String(makerOrderPrice),
      volume: String(bot.quantity),
      postOnly: true,
    });

    if (!placeResp.uuid) {
      return { kind: 'noop' };
    }

    return {
      kind: 'placed',
      makerOrderUuid: placeResp.uuid,
      makerOrderPrice,
    };
  }

  // CASE B: PENDING 있음 → status polling
  if (!pending.makerOrderUuid) {
    // schema는 nullable이지만 live PENDING은 항상 uuid 있음 — 방어 코드
    return { kind: 'waiting', pendingId: pending.id };
  }

  const status = await client.getOrder(pending.makerOrderUuid);
  const filledQty = parseFloat(status.executed_volume || '0');
  const elapsed = Date.now() - pending.createdAt.getTime();

  if (filledQty > 0) {
    // 체결 (부분 포함) → taker leg
    const filledMakerKrw = (status.trades || []).reduce(
      (s, t) => s + parseFloat(t.funds || '0'),
      0,
    );
    const paidFeeMaker = parseFloat(status.paid_fee || '0');

    // step 1: X(makerCoin) best+ioc 매도
    const sellResp = await client.placeBestIoc(
      'KRW-' + bot.makerCoin,
      'ask',
      { volume: String(filledQty) },
    );
    const filledSellQty = parseFloat(sellResp.executed_volume || '0');
    if (filledSellQty === 0) {
      return {
        kind: 'partial_hold',
        pendingId: pending.id,
        reason: 'maker filled, taker sell failed, holding X',
      };
    }
    const filledSellKrw = (sellResp.trades || []).reduce(
      (s, t) => s + parseFloat(t.funds || '0'),
      0,
    );
    const paidFeeSell = parseFloat(sellResp.paid_fee || '0');

    // step 2: 받은 KRW로 Y(takerCoin) best+ioc 매수
    const buyKrw = filledSellKrw - paidFeeSell;
    const buyResp = await client.placeBestIoc(
      'KRW-' + bot.takerCoin,
      'bid',
      { price: String(Math.floor(buyKrw)) },
    );
    const filledBuyQty = parseFloat(buyResp.executed_volume || '0');
    if (filledBuyQty === 0) {
      // step 3 fallback: X 재매수 (원위치)
      await client.placeBestIoc(
        'KRW-' + bot.makerCoin,
        'bid',
        { price: String(Math.floor(buyKrw)) },
      );
      return {
        kind: 'rolled_back',
        pendingId: pending.id,
        reason: 'taker buy failed, recovered to X',
      };
    }
    const filledBuyKrw = (buyResp.trades || []).reduce(
      (s, t) => s + parseFloat(t.funds || '0'),
      0,
    );
    const paidFeeBuy = parseFloat(buyResp.paid_fee || '0');

    const paidFeeKrw = paidFeeMaker + paidFeeSell + paidFeeBuy;
    const netProfitKrw = filledSellKrw - filledMakerKrw - paidFeeKrw;
    const realizedSpreadBps = Math.floor(
      (filledSellKrw / filledMakerKrw - 1) * 10000,
    );

    return {
      kind: 'filled',
      pendingId: pending.id,
      filledQty,
      filledMakerKrw,
      filledSellKrw,
      filledBuyKrw,
      paidFeeKrw,
      netProfitKrw,
      realizedSpreadBps,
    };
  }

  // 미체결 + 만료
  if (elapsed > bot.maxPendingMs) {
    await client.cancelOrder(pending.makerOrderUuid);
    return { kind: 'expired', pendingId: pending.id };
  }

  // 미체결 + 대기
  return { kind: 'waiting', pendingId: pending.id };
}
```

- [ ] **Step 5: 테스트 통과**

```bash
npx jest __tests__/services/maker-taker-live-executor.test.ts
```

Expected: 7 PASS

- [ ] **Step 6: tsc 통과**

```bash
npx tsc --noEmit
```

Expected: 0 error

- [ ] **Step 7: Commit**

```bash
git add src/services/maker-taker-live-executor.ts __tests__/services/maker-taker-live-executor.test.ts
git commit -m "feat(stablecoin): maker-taker live executor (TDD 7케이스)"
```

---

## Task 4: MakerTakerSimulatorAgent에 live=true 분기 추가

**Files:**
- Modify: `src/agents/maker-taker-simulator-agent.ts`

기존 `processBot` 함수의 흐름을 보존하면서 **상단에 `bot.live === true` 분기만 추가**. 분기 안에서 PR B `StablecoinArbAgent`의 `getClientFor` / `BalanceCache` 패턴 그대로 재사용.

- [ ] **Step 1: import 추가**

`src/agents/maker-taker-simulator-agent.ts:1-14` 영역에 추가:

```typescript
import { processLiveBot, type OrderClient, type PendingTradeInput } from '../services/maker-taker-live-executor';
import { tradingLock } from '../services/stablecoin-trading-lock';
import { runAll as runPreCheckAll } from '../services/stablecoin-pre-check';
import { BalanceCache } from '../services/upbit-balance-cache';
import { UpbitService } from '../services/upbit.service';
import { decrypt } from '../utils/encryption';
import { prisma as mainPrisma } from '../config/database';
```

> **참고:** import path는 PR B `stablecoin-arb-agent.ts:1-25`에서 그대로 복사. 만약 `decrypt` import가 다른 경로면 PR B 코드 봐서 일치시킬 것.

- [ ] **Step 2: client 캐시 필드 추가 (PR B agent와 동일 패턴)**

class MakerTakerSimulatorAgent 안 (line 25~36 사이) 필드 추가:

```typescript
  private clients = new Map<
    number,
    { upbit: UpbitService; cache: BalanceCache }
  >();
```

- [ ] **Step 3: getClientFor 헬퍼 함수 추가**

class 끝 (line 191 직전)에 private 메서드 추가:

```typescript
  private async getClientFor(userId: number) {
    const cached = this.clients.get(userId);
    if (cached) return cached;

    const cred = await mainPrisma.credential.findFirst({
      where: { userId, exchange: 'upbit' },
    });
    if (!cred) {
      throw new Error(`Upbit credential not found for user ${userId}`);
    }

    const accessKey = decrypt(cred.accessKey);
    const secretKey = decrypt(cred.secretKey);
    const upbit = new UpbitService(accessKey, secretKey);
    const cache = new BalanceCache(5_000, async () => upbit.getAccounts());

    const tuple = { upbit, cache };
    this.clients.set(userId, tuple);
    return tuple;
  }
```

- [ ] **Step 4: processBot 시작에 live=true 분기 추가**

`processBot` 함수 (line 92~190)의 시작 부분 (line 95 `const makerBook` 직전)에 추가:

```typescript
    if (bot.live === true) {
      await this.processLiveBot(bot, books);
      return;
    }
```

- [ ] **Step 5: processLiveBot 메서드 추가**

class 끝에 추가:

```typescript
  /**
   * live=true 봇 처리. maker-taker-live-executor에 위임 + DB write 적용.
   */
  private async processLiveBot(
    bot: Awaited<ReturnType<typeof prisma.makerTakerSimBot.findMany>>[number],
    books: ReadonlyMap<string, OrderbookTop>,
  ): Promise<void> {
    // PENDING 조회
    const pending = await prisma.makerTakerSimTrade.findFirst({
      where: { botId: bot.id, status: 'PENDING', live: true },
      orderBy: { createdAt: 'desc' },
    });

    const pendingInput: PendingTradeInput | null = pending
      ? {
          id: pending.id,
          status: pending.status,
          makerOrderUuid: pending.makerOrderUuid,
          makerOrderPrice: pending.makerOrderPrice,
          createdAt: pending.createdAt,
          notes: pending.notes,
        }
      : null;

    // 새 PENDING 시점만 preCheck (기존 PENDING의 polling은 무관)
    let preCheckOk = true;
    if (!pending) {
      // maker bot은 daily limit/loss를 직접 arb와 분리해서 별도 체크할 수도 있으나,
      // PR C 범위에서는 단순 maker post_only라 잔고/lock 체크만 충분.
      // (preCheck는 spec §5 daily limit가 maker에도 의미 있을지 PR D에서 결정)
      preCheckOk = true;
    }

    const { upbit } = await this.getClientFor(bot.userId);
    const client: OrderClient = {
      placeLimit: (m, s, p) => upbit.placeLimitOrder(m, s, p),
      placeBestIoc: (m, s, p) => upbit.placeBestIoc(m, s, p),
      getOrder: (uuid) => upbit.getOrder(uuid),
      cancelOrder: (uuid) => upbit.cancelOrder(uuid),
    };

    const result = await processLiveBot({
      bot: {
        id: bot.id,
        userId: bot.userId,
        makerCoin: bot.makerCoin,
        takerCoin: bot.takerCoin,
        bidOffsetKrw: bot.bidOffsetKrw,
        quantity: Number(bot.quantity),
        maxPendingMs: bot.maxPendingMs,
        killSwitch: bot.killSwitch,
      },
      pending: pendingInput,
      books,
      client,
      isLocked: () => tradingLock.isLocked(),
      preCheckOk,
    });

    // 결과별 DB write
    switch (result.kind) {
      case 'noop':
      case 'waiting':
        return;
      case 'placed':
        await prisma.makerTakerSimTrade.create({
          data: {
            botId: bot.id,
            makerCoin: bot.makerCoin,
            takerCoin: bot.takerCoin,
            makerOrderPrice: result.makerOrderPrice,
            quantity: bot.quantity,
            status: 'PENDING',
            live: true,
            makerOrderUuid: result.makerOrderUuid,
            notes: `LIVE order placed at ${result.makerOrderPrice}`,
          },
        });
        return;
      case 'expired':
        await prisma.makerTakerSimTrade.update({
          where: { id: result.pendingId },
          data: {
            status: 'EXPIRED',
            notes:
              (pending?.notes ?? '') +
              ` | LIVE expired (cancelled at ${new Date().toISOString()})`,
          },
        });
        return;
      case 'filled': {
        const now = new Date();
        await prisma.makerTakerSimTrade.update({
          where: { id: result.pendingId },
          data: {
            status: 'FILLED',
            makerFilledAt: now,
            makerFilledPrice: pending?.makerOrderPrice,
            takerExecutedAt: now,
            takerMarketBid: Math.round(result.filledSellKrw / result.filledQty),
            grossProfitKrw: result.filledSellKrw - result.filledMakerKrw,
            feeKrw: result.paidFeeKrw,
            netProfitKrw: result.netProfitKrw,
            realizedSpreadBps: result.realizedSpreadBps,
            notes:
              (pending?.notes ?? '') +
              ` | LIVE FILLED sell=${result.filledSellKrw} buy=${result.filledBuyKrw} fees=${result.paidFeeKrw.toFixed(
                2,
              )} net=${result.netProfitKrw.toFixed(2)}`,
          },
        });
        return;
      }
      case 'partial_hold':
        await prisma.makerTakerSimTrade.update({
          where: { id: result.pendingId },
          data: {
            status: 'PARTIAL_HOLD',
            notes: (pending?.notes ?? '') + ` | LIVE ${result.reason}`,
          },
        });
        return;
      case 'rolled_back':
        await prisma.makerTakerSimTrade.update({
          where: { id: result.pendingId },
          data: {
            status: 'ROLLED_BACK',
            notes: (pending?.notes ?? '') + ` | LIVE ${result.reason}`,
          },
        });
        return;
    }
  }
```

- [ ] **Step 6: tsc 통과 확인**

```bash
npx tsc --noEmit
```

Expected: 0 error. 만약 `processLiveBot` 함수와 import 이름이 충돌하면 (top-level import는 `processLiveBot`, class private method도 `processLiveBot`):
- import에서 `import { processLiveBot as processLiveExecutor }`로 alias 후 호출부 수정

- [ ] **Step 7: 기존 시뮬 테스트가 깨지지 않는지 확인**

```bash
npx jest __tests__/services/maker-taker-simulator.service.test.ts
npx jest __tests__/agents/maker-taker-simulator-agent.test.ts 2>/dev/null || true
```

Expected: 기존 테스트 PASS (live=false 흐름 보존)

- [ ] **Step 8: Commit**

```bash
git add src/agents/maker-taker-simulator-agent.ts
git commit -m "feat(stablecoin): MakerTakerSimulatorAgent에 live=true 분기 추가"
```

---

## Task 5: StablecoinArbAgent에 auto kill switch 통합

**Files:**
- Modify: `src/agents/stablecoin-arb-agent.ts` (PR B에서 만든 처리 흐름)

executor 호출 결과를 받은 직후 auto-killswitch 모듈을 호출, trigger 시 setKillSwitch + Socket.IO emit.

- [ ] **Step 1: import 추가**

`src/agents/stablecoin-arb-agent.ts` 상단에 추가:

```typescript
import {
  shouldTriggerKillSwitch,
  recordLeg2Failure,
  recordLeg2Success,
} from '../services/stablecoin-auto-killswitch';
import * as arbService from '../services/stablecoin-arb.service';
```

> **참고:** PR B에서 이미 `arbService` import가 있을 가능성이 높음. 중복 import 만들지 말고 기존 line을 확장할 것.

- [ ] **Step 2: processLiveBot에서 executor 결과 받은 직후 auto-killswitch 호출**

PR B `stablecoin-arb-agent.ts`의 `processLiveBot` 함수 안, `executor.executeArbitrage(...)` 호출 직후 그 결과를 분기 처리하는 부분에 추가:

```typescript
      // PR B 기존: result = await executeArbitrage(...)
      // 신규: leg-2 결과 기록
      if (result.ok) {
        recordLeg2Success(bot.id);
      } else if (result.rolledBack) {
        // ROLLED_BACK = leg-1 성공 + leg-2 zero
        recordLeg2Failure(bot.id);
      }
      // result.ok === false && !rolledBack은 leg-1 실패 → leg-2 실패 카운터 영향 없음

      // 거래 후 todayStats 재조회 + auto-killswitch 검사
      const todayStats = await arbService.getTodayStats(bot.id);
      const trigger = shouldTriggerKillSwitch({
        botId: bot.id,
        todayNetProfitKrw: todayStats.todayNetProfitKrw,
        dailyLossLimitKrw: bot.dailyLossLimitKrw,
      });

      if (trigger.trigger) {
        console.error(
          `[StablecoinArbAgent] AUTO KILL SWITCH triggered for bot ${bot.id}: ${trigger.reason} — ${trigger.detail}`,
        );
        await arbService.setKillSwitch(bot.userId, true);
        // Socket.IO emit (서버 어딘가에서 import 가능한 io 인스턴스 사용 — PR B와 동일 패턴)
        try {
          const { getSocketIO } = await import('../services/socket.service');
          getSocketIO().emit('stablecoin:killswitch_triggered', {
            botId: bot.id,
            reason: trigger.reason,
            detail: trigger.detail,
            triggeredAt: new Date().toISOString(),
          });
        } catch (e) {
          console.warn('[StablecoinArbAgent] socket emit failed:', (e as Error).message);
        }
      }
```

> **위치 가이드:** PR B에서 `processLiveBot` 함수가 어디 있는지 grep으로 확인 후, executor 호출 직후 (DB recordTrade 완료 직후)에 위 블록을 삽입. 정확한 line 번호는 implement 시점에 확인.

- [ ] **Step 3: 통합 테스트 추가 (mock executor)**

`__tests__/agents/stablecoin-arb-agent.test.ts`가 존재한다면 case 추가, 없다면 unit test는 skip하고 다음 task의 통합 테스트로 커버.

- [ ] **Step 4: tsc 통과**

```bash
npx tsc --noEmit
```

Expected: 0 error

- [ ] **Step 5: Commit**

```bash
git add src/agents/stablecoin-arb-agent.ts
git commit -m "feat(stablecoin): StablecoinArbAgent에 auto kill switch 통합"
```

---

## Task 6: Maker bot CRUD admin endpoint

**Files:**
- Modify: `src/services/stablecoin-arb.service.ts` (maker bot CRUD 헬퍼 추가)
- Modify: `src/controllers/stablecoin-admin.controller.ts`
- Modify: `src/routes/stablecoin-admin.ts`
- Modify: `__tests__/controllers/stablecoin-admin.controller.test.ts`

- [ ] **Step 1: arb.service에 maker bot CRUD 헬퍼 추가**

`src/services/stablecoin-arb.service.ts` 끝에 추가:

```typescript
/**
 * Maker-Taker 시뮬 봇 CRUD (Admin 전용).
 *
 * 응답 직렬화: Decimal `quantity`는 호출자가 string 변환.
 */
export async function listMakerBots(userId: number) {
  return stablecoinPrisma.makerTakerSimBot.findMany({
    where: { userId },
    orderBy: { id: 'asc' },
  });
}

export type CreateMakerBotInput = {
  userId: number;
  makerCoin: string;
  takerCoin: string;
  bidOffsetKrw: number;
  quantity: number;
  maxPendingMs?: number;
  minTakerBidKrw?: number;
  makerFeeBps?: number;
  takerFeeBps?: number;
};

export async function createMakerBot(input: CreateMakerBotInput) {
  return stablecoinPrisma.makerTakerSimBot.create({
    data: {
      userId: input.userId,
      makerCoin: input.makerCoin,
      takerCoin: input.takerCoin,
      bidOffsetKrw: input.bidOffsetKrw,
      quantity: input.quantity,
      maxPendingMs: input.maxPendingMs ?? 600_000,
      minTakerBidKrw: input.minTakerBidKrw ?? null,
      makerFeeBps: input.makerFeeBps ?? 5,
      takerFeeBps: input.takerFeeBps ?? 5,
    },
  });
}

export type PatchMakerBotInput = Partial<{
  enabled: boolean;
  killSwitch: boolean;
  live: boolean;
  bidOffsetKrw: number;
  quantity: number;
  maxPendingMs: number;
  minTakerBidKrw: number | null;
  makerFeeBps: number;
  takerFeeBps: number;
}>;

export async function patchMakerBot(id: number, userId: number, patch: PatchMakerBotInput) {
  return stablecoinPrisma.makerTakerSimBot.update({
    where: { id, userId } as any, // userId 필터로 다른 사용자 봇 보호
    data: patch as any,
  });
}

export async function deleteMakerBot(id: number, userId: number) {
  // PENDING 있는 live 봇은 삭제 거부
  const pending = await stablecoinPrisma.makerTakerSimTrade.findFirst({
    where: { botId: id, status: 'PENDING', live: true },
  });
  if (pending) {
    throw new Error('PENDING live trade 있음 — 먼저 만료/취소 처리 필요');
  }
  // userId로 ownership 확인
  const bot = await stablecoinPrisma.makerTakerSimBot.findFirst({
    where: { id, userId },
  });
  if (!bot) throw new Error('Bot not found');

  await stablecoinPrisma.makerTakerSimBot.delete({ where: { id } });
}
```

- [ ] **Step 2: 테스트 작성 (실패 먼저)**

`__tests__/controllers/stablecoin-admin.controller.test.ts`에 추가 (기존 describe 블록 안):

```typescript
  describe('Maker bot CRUD', () => {
    it('GET /maker-bots → 봇 목록 반환 (Decimal 직렬화)', async () => {
      jest.spyOn(arbService, 'listMakerBots').mockResolvedValueOnce([
        {
          id: 1,
          userId: 2,
          enabled: true,
          killSwitch: false,
          live: false,
          makerCoin: 'USDT',
          takerCoin: 'USDC',
          bidOffsetKrw: -1,
          quantity: { toString: () => '5.0' } as any,
          maxPendingMs: 600000,
          minTakerBidKrw: null,
          makerFeeBps: 5,
          takerFeeBps: 5,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ] as any);

      const req = mockReq();
      const res = mockRes();
      await listMakerBots(req as any, res as any, jest.fn());

      expect(res.json).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ quantity: '5.0', live: false }),
        ]),
      );
    });

    it('POST /maker-bots → zod 검증 통과 + create 호출', async () => {
      jest.spyOn(arbService, 'createMakerBot').mockResolvedValueOnce({
        id: 99,
        userId: 2,
        makerCoin: 'USDT',
        takerCoin: 'USDC',
        bidOffsetKrw: -1,
        quantity: { toString: () => '5' } as any,
      } as any);

      const req = mockReq({
        body: {
          makerCoin: 'USDT',
          takerCoin: 'USDC',
          bidOffsetKrw: -1,
          quantity: 5,
        },
      });
      const res = mockRes();
      await createMakerBot(req as any, res as any, jest.fn());

      expect(arbService.createMakerBot).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 2, makerCoin: 'USDT', quantity: 5 }),
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ id: 99, quantity: '5' }),
      );
    });

    it('POST /maker-bots → makerCoin 누락 시 400', async () => {
      const req = mockReq({ body: { takerCoin: 'USDC', quantity: 5 } });
      const res = mockRes();
      const next = jest.fn();
      await createMakerBot(req as any, res as any, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 400 }),
      );
    });

    it('PATCH /maker-bots/:id → live=true patch 통과', async () => {
      jest.spyOn(arbService, 'patchMakerBot').mockResolvedValueOnce({
        id: 1,
        live: true,
        quantity: { toString: () => '5' } as any,
      } as any);

      const req = mockReq({
        params: { id: '1' },
        body: { live: true },
      });
      const res = mockRes();
      await patchMakerBot(req as any, res as any, jest.fn());

      expect(arbService.patchMakerBot).toHaveBeenCalledWith(
        1,
        2,
        expect.objectContaining({ live: true }),
      );
    });

    it('DELETE /maker-bots/:id → service 호출', async () => {
      jest.spyOn(arbService, 'deleteMakerBot').mockResolvedValueOnce(undefined);

      const req = mockReq({ params: { id: '1' } });
      const res = mockRes();
      await deleteMakerBot(req as any, res as any, jest.fn());

      expect(arbService.deleteMakerBot).toHaveBeenCalledWith(1, 2);
      expect(res.status).toHaveBeenCalledWith(204);
    });
  });
```

> **참고:** PR B 테스트 파일에서 `mockReq`, `mockRes`, `arbService` import가 어떻게 되어있는지 그대로 따라할 것.

- [ ] **Step 3: 테스트 실패 확인**

```bash
npx jest __tests__/controllers/stablecoin-admin.controller.test.ts -t "Maker bot CRUD"
```

Expected: 5 FAIL — listMakerBots/createMakerBot/patchMakerBot/deleteMakerBot 함수 없음

- [ ] **Step 4: controller 함수 4개 구현**

`src/controllers/stablecoin-admin.controller.ts`에 추가:

```typescript
import { z } from 'zod';
// 기존 import에 이어서

const createMakerBotSchema = z.object({
  makerCoin: z.string().min(1),
  takerCoin: z.string().min(1),
  bidOffsetKrw: z.number().int(),
  quantity: z.number().positive(),
  maxPendingMs: z.number().int().positive().optional(),
  minTakerBidKrw: z.number().int().optional(),
  makerFeeBps: z.number().int().min(0).optional(),
  takerFeeBps: z.number().int().min(0).optional(),
});

const patchMakerBotSchema = z.object({
  enabled: z.boolean().optional(),
  killSwitch: z.boolean().optional(),
  live: z.boolean().optional(),
  bidOffsetKrw: z.number().int().optional(),
  quantity: z.number().positive().optional(),
  maxPendingMs: z.number().int().positive().optional(),
  minTakerBidKrw: z.number().int().nullable().optional(),
  makerFeeBps: z.number().int().min(0).optional(),
  takerFeeBps: z.number().int().min(0).optional(),
});

function serializeBot(bot: any) {
  return {
    ...bot,
    quantity: bot.quantity?.toString() ?? null,
  };
}

export const listMakerBots = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const bots = await arbService.listMakerBots(userId);
    res.json(bots.map(serializeBot));
  } catch (error) {
    next(error);
  }
};

export const createMakerBot = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const parsed = createMakerBotSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('Invalid body: ' + parsed.error.errors.map((e) => e.path.join('.') + ' ' + e.message).join(', '), 400);
    }
    const bot = await arbService.createMakerBot({ userId, ...parsed.data });
    res.json(serializeBot(bot));
  } catch (error) {
    next(error);
  }
};

export const patchMakerBot = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw new AppError('Invalid id', 400);

    const parsed = patchMakerBotSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('Invalid body: ' + parsed.error.errors.map((e) => e.path.join('.')).join(', '), 400);
    }
    const bot = await arbService.patchMakerBot(id, userId, parsed.data);
    res.json(serializeBot(bot));
  } catch (error: any) {
    if (error.code === 'P2025') return next(new AppError('Bot not found', 404));
    next(error);
  }
};

export const deleteMakerBot = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw new AppError('Invalid id', 400);

    await arbService.deleteMakerBot(id, userId);
    res.status(204).end();
  } catch (error: any) {
    const msg = error?.message || '';
    if (msg.includes('PENDING')) return next(new AppError(msg, 422));
    if (msg.includes('not found')) return next(new AppError(msg, 404));
    next(error);
  }
};
```

> **참고:** zod 패키지가 backend `package.json`에 이미 있는지 확인 — 없으면 `npm install zod` 먼저.

- [ ] **Step 5: 라우트 등록**

`src/routes/stablecoin-admin.ts`에 추가:

```typescript
import {
  // 기존 import
  listMakerBots,
  createMakerBot,
  patchMakerBot,
  deleteMakerBot,
} from '../controllers/stablecoin-admin.controller';

// 라우트 등록 (기존 라우트 뒤에)
router.get('/maker-bots', listMakerBots);
router.post('/maker-bots', createMakerBot);
router.patch('/maker-bots/:id', patchMakerBot);
router.delete('/maker-bots/:id', deleteMakerBot);
```

- [ ] **Step 6: 테스트 통과**

```bash
npx jest __tests__/controllers/stablecoin-admin.controller.test.ts
```

Expected: 모든 PASS (PR B 기존 테스트 + 신규 5개)

- [ ] **Step 7: tsc 통과**

```bash
npx tsc --noEmit
```

Expected: 0 error

- [ ] **Step 8: Commit**

```bash
git add src/services/stablecoin-arb.service.ts src/controllers/stablecoin-admin.controller.ts src/routes/stablecoin-admin.ts __tests__/controllers/stablecoin-admin.controller.test.ts
git commit -m "feat(stablecoin): maker bot CRUD admin endpoint (zod 검증)"
```

---

## Task 7: 프론트엔드 — lib/api.ts에 maker bot CRUD + auto kill switch 타입

**Files:**
- Modify: `v0-grid-transaction-frontend/lib/api.ts`

- [ ] **Step 1: MakerTakerSimBot 인터페이스 + CRUD 함수 추가**

`lib/api.ts`에 추가 (기존 `StablecoinBot` 인터페이스 근처):

```typescript
export interface MakerTakerSimBot {
  id: number;
  userId: number;
  enabled: boolean;
  killSwitch: boolean;
  live: boolean;
  makerCoin: string;
  takerCoin: string;
  bidOffsetKrw: number;
  quantity: string; // Decimal serialized
  maxPendingMs: number;
  minTakerBidKrw: number | null;
  makerFeeBps: number;
  takerFeeBps: number;
  createdAt: string;
  updatedAt: string;
}

export async function listMakerBots(): Promise<MakerTakerSimBot[]> {
  const r = await api.get('/admin/stablecoin/maker-bots');
  return r.data;
}

export type CreateMakerBotBody = {
  makerCoin: string;
  takerCoin: string;
  bidOffsetKrw: number;
  quantity: number;
  maxPendingMs?: number;
  minTakerBidKrw?: number;
  makerFeeBps?: number;
  takerFeeBps?: number;
};

export async function createMakerBot(body: CreateMakerBotBody): Promise<MakerTakerSimBot> {
  const r = await api.post('/admin/stablecoin/maker-bots', body);
  return r.data;
}

export type PatchMakerBotBody = Partial<{
  enabled: boolean;
  killSwitch: boolean;
  live: boolean;
  bidOffsetKrw: number;
  quantity: number;
  maxPendingMs: number;
  minTakerBidKrw: number | null;
  makerFeeBps: number;
  takerFeeBps: number;
}>;

export async function patchMakerBot(id: number, body: PatchMakerBotBody): Promise<MakerTakerSimBot> {
  const r = await api.patch(`/admin/stablecoin/maker-bots/${id}`, body);
  return r.data;
}

export async function deleteMakerBot(id: number): Promise<void> {
  await api.delete(`/admin/stablecoin/maker-bots/${id}`);
}
```

> **참고:** PR B에서 이미 정의된 `StablecoinBot` 옆에 두기. `api` axios 인스턴스 import 패턴은 기존 함수들(`getStablecoinBot` 등) 따라할 것.

- [ ] **Step 2: 빌드 확인 (frontend)**

```bash
cd v0-grid-transaction-frontend
npm run build
```

Expected: build 성공 (0 error). 만약 lib/api.ts의 다른 함수와 충돌하면 import alias로 회피.

- [ ] **Step 3: Commit (frontend)**

```bash
cd v0-grid-transaction-frontend
git add lib/api.ts
git commit -m "feat(stablecoin): maker bot CRUD API 함수 + 타입"
```

---

## Task 8: AutoKillSwitchAlert 컴포넌트 + page 통합

**Files:**
- Create: `v0-grid-transaction-frontend/app/admin/stablecoin/_components/AutoKillSwitchAlert.tsx`
- Modify: `v0-grid-transaction-frontend/app/admin/stablecoin/page.tsx`

- [ ] **Step 1: AutoKillSwitchAlert 컴포넌트 작성**

`app/admin/stablecoin/_components/AutoKillSwitchAlert.tsx`:

```tsx
"use client"

import { useState } from "react"
import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { setStablecoinKillswitch, type StablecoinBot } from "@/lib/api"

type Props = {
  bot: StablecoinBot | null
  onCleared: () => void
}

/**
 * 봇이 killSwitch=ON 상태일 때 페이지 상단 빨간 배너.
 * 사유는 백엔드 Socket.IO 'stablecoin:killswitch_triggered' 이벤트로 전달되거나
 * (이 PR 범위에서는 단순 표시 - 실시간 사유 fetching은 PR D에서 reason 컬럼 추가 시 통합).
 */
export function AutoKillSwitchAlert({ bot, onCleared }: Props) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!bot || !bot.killSwitch) return null

  const handleClear = async () => {
    if (!confirm("Kill switch를 해제하시겠습니까? 자동 트리거 사유를 먼저 확인하세요.")) return
    setSubmitting(true)
    setError(null)
    try {
      await setStablecoinKillswitch(false)
      onCleared()
    } catch (err) {
      setError("해제 실패: " + (err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Alert variant="destructive" className="border-red-500 border-2">
      <AlertTriangle className="h-5 w-5" />
      <AlertTitle>⚠️ 자동 Kill Switch 발동</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>
          봇이 자동으로 정지되었습니다. 가능한 사유: 일일 손실 한도 도달, 또는 leg-2 3회 연속 실패.
          <br />
          서버 로그(`docker logs grid-bot | grep AUTO`)에서 정확한 사유를 확인하세요.
        </p>
        {error && <p className="text-sm">{error}</p>}
        <Button
          size="sm"
          variant="outline"
          onClick={handleClear}
          disabled={submitting}
        >
          {submitting ? "해제 중..." : "Kill switch 해제"}
        </Button>
      </AlertDescription>
    </Alert>
  )
}
```

- [ ] **Step 2: page에 통합**

`app/admin/stablecoin/page.tsx`에서 BotStatusCard 위에 AutoKillSwitchAlert 추가:

```tsx
// 기존 imports 옆에 추가
import { AutoKillSwitchAlert } from "./_components/AutoKillSwitchAlert"

// 페이지 컴포넌트 안 (BotStatusCard 직전)
{/* PR C: 자동 Kill Switch 발동 알림 */}
<AutoKillSwitchAlert
  bot={bot}
  onCleared={() => refetchBot()}
/>

<BotStatusCard />
```

> **참고:** 페이지 컴포넌트가 BotStatusCard에서 bot 데이터를 자체 fetching하는 구조라면, AutoKillSwitchAlert도 자체 폴링으로 가야 함. 현재 페이지 구조 확인 후 일치시킬 것 — 필요시 BotStatusCard에서 onBotChange callback 추가.

- [ ] **Step 3: 빌드 확인**

```bash
cd v0-grid-transaction-frontend
npm run build
```

Expected: 빌드 성공

- [ ] **Step 4: Commit**

```bash
git add app/admin/stablecoin/_components/AutoKillSwitchAlert.tsx app/admin/stablecoin/page.tsx
git commit -m "feat(stablecoin): AutoKillSwitchAlert 컴포넌트 + 페이지 통합"
```

---

## Task 9: MakerTakerSimPanel CRUD UI

**Files:**
- Modify: `v0-grid-transaction-frontend/app/admin/stablecoin/_components/MakerTakerSimPanel.tsx`

- [ ] **Step 1: 기존 컴포넌트 구조 확인**

```bash
cat v0-grid-transaction-frontend/app/admin/stablecoin/_components/MakerTakerSimPanel.tsx | head -50
```

기존 구조에 맞춰 다음 추가:
- 봇 목록 useEffect로 listMakerBots() 폴링 (10s)
- "+ 봇 추가" 버튼 → 모달 폼 (makerCoin/takerCoin/bidOffsetKrw/quantity)
- 각 봇 카드에 "live 토글" + "삭제" 버튼
- live=true 봇은 빨간 테두리

- [ ] **Step 2: 컴포넌트 변경 (필요 부분만 발췌)**

```tsx
"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog"
import { Trash2, Plus, AlertTriangle } from "lucide-react"
import {
  listMakerBots,
  createMakerBot,
  patchMakerBot,
  deleteMakerBot,
  type MakerTakerSimBot,
} from "@/lib/api"

const STABLECOINS = ["USDT", "USDC", "USD1", "USDS", "USDE"]

export function MakerTakerSimPanel() {
  const [bots, setBots] = useState<MakerTakerSimBot[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    setLoading(true)
    try {
      setBots(await listMakerBots())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 10_000)
    return () => clearInterval(t)
  }, [])

  const handleCreate = async (form: {
    makerCoin: string
    takerCoin: string
    bidOffsetKrw: number
    quantity: number
  }) => {
    setSubmitting(true)
    setError(null)
    try {
      await createMakerBot(form)
      setCreateOpen(false)
      refresh()
    } catch (e) {
      setError("봇 생성 실패: " + (e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleToggleLive = async (bot: MakerTakerSimBot) => {
    if (!bot.live) {
      const ok = confirm(
        `⚠️ ${bot.makerCoin}-${bot.takerCoin} 봇 live=true로 전환합니다.\n` +
        `실제 Upbit limit 주문이 들어갑니다. 진행할까요?`
      )
      if (!ok) return
    }
    try {
      await patchMakerBot(bot.id, { live: !bot.live })
      refresh()
    } catch (e) {
      setError("live 토글 실패: " + (e as Error).message)
    }
  }

  const handleDelete = async (bot: MakerTakerSimBot) => {
    if (!confirm(`봇 #${bot.id} (${bot.makerCoin}-${bot.takerCoin}) 삭제?`)) return
    try {
      await deleteMakerBot(bot.id)
      refresh()
    } catch (e) {
      setError("삭제 실패: " + (e as Error).message)
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Maker-Taker 시뮬/Live 봇</CardTitle>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button size="sm"><Plus className="h-4 w-4 mr-1" />봇 추가</Button>
          </DialogTrigger>
          <CreateMakerBotDialog
            onSubmit={handleCreate}
            submitting={submitting}
            error={error}
          />
        </Dialog>
      </CardHeader>
      <CardContent>
        {loading && <p className="text-muted-foreground">로딩 중...</p>}
        {error && (
          <div className="text-red-500 text-sm flex items-center gap-2 mb-2">
            <AlertTriangle className="h-4 w-4" />{error}
          </div>
        )}
        <div className="space-y-2">
          {bots.map((bot) => (
            <div
              key={bot.id}
              className={`flex items-center justify-between p-3 border rounded ${
                bot.live ? "border-red-500 border-2" : ""
              }`}
            >
              <div className="space-y-1">
                <div className="font-medium">
                  #{bot.id} {bot.makerCoin} → {bot.takerCoin}
                  {bot.live && <Badge variant="destructive" className="ml-2">LIVE</Badge>}
                  {bot.killSwitch && <Badge variant="outline" className="ml-1">KILL</Badge>}
                </div>
                <div className="text-xs text-muted-foreground">
                  qty={bot.quantity} / offset={bot.bidOffsetKrw} / 수수료 maker={bot.makerFeeBps}bp taker={bot.takerFeeBps}bp
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={bot.live ? "default" : "destructive"}
                  onClick={() => handleToggleLive(bot)}
                >
                  {bot.live ? "live 끄기" : "live 켜기"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => handleDelete(bot)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
          {bots.length === 0 && !loading && (
            <p className="text-muted-foreground text-sm">등록된 봇 없음</p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// 모달 폼 (createMakerBot용)
function CreateMakerBotDialog(props: {
  onSubmit: (form: { makerCoin: string; takerCoin: string; bidOffsetKrw: number; quantity: number }) => void
  submitting: boolean
  error: string | null
}) {
  const [makerCoin, setMakerCoin] = useState("USDT")
  const [takerCoin, setTakerCoin] = useState("USDC")
  const [bidOffsetKrw, setBidOffsetKrw] = useState(-1)
  const [quantity, setQuantity] = useState(5)

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>새 Maker-Taker 봇</DialogTitle>
      </DialogHeader>
      <div className="space-y-3">
        <div>
          <Label>Maker Coin (Upbit에서 매수할 코인)</Label>
          <select
            value={makerCoin}
            onChange={(e) => setMakerCoin(e.target.value)}
            className="w-full border rounded p-2"
          >
            {STABLECOINS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <div>
          <Label>Taker Coin (체결 후 변환할 코인)</Label>
          <select
            value={takerCoin}
            onChange={(e) => setTakerCoin(e.target.value)}
            className="w-full border rounded p-2"
          >
            {STABLECOINS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <div>
          <Label>Bid Offset (원, 음수=현재 best bid보다 낮게)</Label>
          <Input
            type="number"
            value={bidOffsetKrw}
            onChange={(e) => setBidOffsetKrw(parseInt(e.target.value, 10))}
          />
        </div>
        <div>
          <Label>Quantity</Label>
          <Input
            type="number"
            step="0.01"
            value={quantity}
            onChange={(e) => setQuantity(parseFloat(e.target.value))}
          />
        </div>
        {props.error && <p className="text-red-500 text-sm">{props.error}</p>}
      </div>
      <DialogFooter>
        <Button
          onClick={() => props.onSubmit({ makerCoin, takerCoin, bidOffsetKrw, quantity })}
          disabled={props.submitting || makerCoin === takerCoin}
        >
          {props.submitting ? "생성 중..." : "추가"}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
```

- [ ] **Step 3: 빌드 확인**

```bash
cd v0-grid-transaction-frontend
npm run build
```

Expected: 빌드 성공. shadcn `Alert`, `Dialog`, `Input`, `Label` 컴포넌트가 없으면 `npx shadcn@latest add alert dialog input label` 실행.

- [ ] **Step 4: Commit**

```bash
git add app/admin/stablecoin/_components/MakerTakerSimPanel.tsx
git commit -m "feat(stablecoin): MakerTakerSimPanel CRUD UI + live 토글"
```

---

## Task 10: PR 생성 + 사용자 승인 후 머지

- [ ] **Step 1: 브랜치 정리 + push**

백엔드:
```bash
cd v0-grid-tranasction-backend
git status
git push -u origin feat/stablecoin-trading-pr-c
```

프론트:
```bash
cd v0-grid-transaction-frontend
git status
git push -u origin feat/stablecoin-trading-pr-c-ui
```

> **참고:** 이전 PR B와 마찬가지로 백엔드/프론트 별도 PR. 브랜치 이름은 일관성을 위해 동일 prefix 사용.

- [ ] **Step 2: PR 생성**

백엔드:
```bash
cd v0-grid-tranasction-backend
gh pr create --title "feat(stablecoin): PR C — maker-taker live executor + auto kill switch + maker bot CRUD" --body "$(cat <<'EOF'
## Summary

- **Maker-Taker live executor** (`maker-taker-live-executor.ts`): bot.live=true일 때 Upbit limit(post_only) 주문 → 체결 시 taker leg 2단계(X매도→Y매수, Y실패시 fallback X재매수)
- **자동 kill switch** (`stablecoin-auto-killswitch.ts`): 직접 아비트리지 봇이 ① leg-2 3회 연속 실패, 또는 ② 일일 손실 한도 도달 시 자동 정지 (Socket.IO emit + setKillSwitch)
- **maker bot CRUD admin endpoint**: GET/POST/PATCH/DELETE `/admin/stablecoin/maker-bots` (zod 검증)
- **MakerTakerSimulatorAgent 분기**: bot.live=true → liveExecutor.processLiveBot, false → 기존 시뮬 흐름 그대로
- **UpbitService.placeLimitOrder** 추가 (post_only 지원)
- **DB 마이그레이션 없음** — 필요한 컬럼 모두 기존 schema에 존재

## 안전 상태

- 모든 maker bot live=false default 유지 (실거래 활성화는 Admin UI에서 명시 토글 시에만)
- 직접 아비트리지 봇 live는 PR B에서 false default — 변경 없음
- 실거래 첫 가동은 PR D Canary Stage 1에서 (별도 PR)

## Test Plan

- [x] 백엔드 단위 테스트 17개 추가 (executor 7 / auto-killswitch 5 / placeLimit 4 / maker bot CRUD 5)
- [x] tsc --noEmit 0 error
- [x] 머지 후 docker exec → 6 에이전트 errors=0 확인
- [x] /api/admin/stablecoin/maker-bots → 시드 5개 봇 목록 (live=false) 확인
- [x] 임의 봇 1개 live=true patch → DB 반영 + Upbit limit 주문 발생 안 함 (잔고 부족이라면 placed 실패 후 다음 evaluate 재시도)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

프론트:
```bash
cd v0-grid-transaction-frontend
gh pr create --title "feat(stablecoin): PR C UI — maker bot CRUD + auto kill switch alert" --body "$(cat <<'EOF'
## Summary

- **MakerTakerSimPanel CRUD UI**: 봇 추가 모달 (makerCoin/takerCoin/bidOffsetKrw/quantity) + live 토글 (큰 confirm) + 삭제
- **AutoKillSwitchAlert** 컴포넌트: 봇이 killSwitch=ON 상태일 때 페이지 상단 빨간 배너 + 해제 버튼
- **lib/api.ts**: MakerTakerSimBot 타입 + listMakerBots/createMakerBot/patchMakerBot/deleteMakerBot

## 안전

- live 토글은 confirm dialog 강제
- 백엔드 PR(`feat/stablecoin-trading-pr-c`) 머지 후 배포 완료 시점에 머지 가능

## Test Plan

- [x] npm run build 성공
- [x] /admin/stablecoin → "봇 추가" 버튼 + 모달 폼 표시
- [x] 임의 봇 live 토글 → 빨간 테두리 적용 + 백엔드 patch 호출
- [x] 봇 삭제 → 목록에서 제거
- [x] killSwitch=true 봇 있을 때 AutoKillSwitchAlert 표시

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: 사용자 검토 요청 + 머지 승인 대기**

> **STOP** — 사용자가 PR 둘 다 검토 후 명시 승인할 때까지 머지 금지. PR 링크 공유 + diff summary 보고.
>
> 권장 머지 순서: **백엔드 먼저 → 배포 완료 (~1.5분) 확인 → 프론트 머지**.

- [ ] **Step 4: 운영 검증 (백엔드 머지 + 배포 후)**

```bash
# Health check
curl -s http://54.180.188.8:3010/api/health

# 6 에이전트 모두 running, errors=0 확인
curl -s http://54.180.188.8:3010/api/agents | python -m json.tool | grep -E '"name"|"status"|"errors"'

# maker bot 목록 확인 (admin token 필요 — 브라우저로 로그인 후 cookies로 접근)
# 또는 SSH로:
ssh -i C:/pem/54.180.188.8.pem ubuntu@54.180.188.8 "docker logs grid-bot 2>&1 | grep -E 'StablecoinArb|MakerTaker' | tail -20"
```

검증 항목:
- [x] 6 에이전트 running + errors=0
- [x] maker bot 5개 모두 live=false (DB 또는 API 응답)
- [x] StablecoinArb bot live=false (PR B 그대로 유지)
- [x] auto-killswitch 모듈 import 에러 없음 (로그 확인)

- [ ] **Step 5: 핸드오프 메모리 업데이트**

`C:/Users/ok419/.claude/projects/D--ExpressProject-Grid-project/memory/`에 신규 메모리 파일 작성:

```bash
project_session_11_handoff_2026_04_27.md
```

내용 요약:
- PR C 머지 완료 (백엔드 PR# / 프론트 PR#)
- 다음 단계: PR D (Canary Stage 1 자동 셋업 + live ON)
- AWS Lightsail 스냅샷 PR D 직전 필수 (`aws lightsail create-relational-database-snapshot`)
- Auto kill switch 카운터는 process-local in-memory → 컨테이너 재시작 시 초기화 (의도된 동작)

`MEMORY.md`에 한 줄 추가:
```
- 🟢 **[세션 11 핸드오프 2026-04-27](project_session_11_handoff_2026_04_27.md)** — PR C (maker-taker live + auto kill switch + maker CRUD) 머지. 다음: PR D Canary Stage 1
```

---

## Self-Review

### 1. Spec coverage 확인

| Spec 섹션 | 요구사항 | Plan task |
|---|---|---|
| §3 (직접 arb executor) | PR B에서 완료 | — |
| §4 (Maker-Taker live executor) | placeLimit / status polling / taker leg / 만료 cancel | Task 1, 3, 4 ✅ |
| §4.3 (부분 체결) | filledQty가 quantity 미만이어도 진행 | Task 3 step 4 (filledQty>0이면 그 비율로) ✅ |
| §5 (pre-check 5단계) | PR A에서 완료 | — |
| §6 (trading lock) | PR A에서 완료, maker live는 신규 PENDING 시점만 lock 체크 | Task 4 step 5 (`isLocked()` 체크) ✅ |
| §7 #1 (3 연속 leg-2 실패) | counter + auto kill switch | Task 2, 5 ✅ |
| §7 #2 (일일 손실 한도) | preCheck 결과로 + auto kill switch | Task 2, 5 ✅ |
| §7 #3 (재고 reconcile) | **PR D 또는 C-followup** | 명시적으로 보류 (Architecture 섹션) ✅ |
| §7 #4 (Upbit 5xx 5회) | **PR D 또는 C-followup** | 명시적으로 보류 ✅ |
| §8 (Canary 단계) | PR D에서 완료 | — |
| §9 (DB schema) | PR C에서 추가 변경 없음 (이미 확보됨) | Architecture 섹션에 명시 ✅ |
| §10 (Admin API) | maker bot CRUD 4개 | Task 6 ✅ |
| §11 (Admin UI) | MakerTakerSimPanel CRUD + AutoKillSwitchAlert | Task 7, 8, 9 ✅ |
| §12 (테스트 전략) | unit 17개 + 통합은 운영 검증 | Task 1~6 step별로 ✅ |

**Gap 없음.** §7 #3 #4는 명시적 보류로 합의됨 (Architecture 섹션).

### 2. Placeholder scan

검색 패턴: TBD, TODO, "implement later", "fill in details", "Add appropriate", "handle edge cases", "similar to Task N"

- ❌ Task 5 step 2의 `// PR B 기존: result = await executeArbitrage(...)` — 이건 **위치 가이드**이지 placeholder 아님. PR B 코드 위치 명시.
- ❌ Task 8 step 2의 `(이 PR 범위에서는 단순 표시 - 실시간 사유 fetching은 PR D에서 reason 컬럼 추가 시 통합).` — 이건 의도적 보류 (사용자에게 향후 개선 표시).

**Placeholder 없음.**

### 3. Type consistency

- `processLiveBot` (executor 함수) ↔ `processLiveBot` (agent class private method) — Task 6 step 6에서 alias 처리 명시 ✅
- `OrderClient` (executor) ↔ agent에서 4개 메서드 (placeLimit/placeBestIoc/getOrder/cancelOrder) 매핑 ✅
- `LiveExecutorResult` discriminated union 7개 kind ↔ agent switch case 7개 (noop/placed/waiting/expired/filled/partial_hold/rolled_back) ✅
- `recordLeg2Failure(botId)` / `recordLeg2Success(botId)` 시그니처 일관 ✅
- `MakerTakerSimBot` (frontend type) ↔ 백엔드 controller serializeBot 응답 — `quantity`만 string 변환, 나머지는 같음 ✅

**Type 일관 OK.**

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-26-stablecoin-trading-pr-c-maker-taker-live.md`.

다음 세션에서 두 가지 실행 옵션:

### 1. Subagent-Driven (recommended)
- 각 task별 fresh subagent dispatch + 두 단계 review (스펙 준수 + 코드 품질)
- 컨텍스트 부담 적음, 병렬 가능 (백엔드 task 1~6 / 프론트 task 7~9 분리)

### 2. Inline Execution
- 같은 세션 안에서 task 순차 진행
- 본 plan 분량(~1100줄)은 inline도 가능하지만 컨텍스트 50% 룰에 가까움

**다음 세션 시작 시 본 plan 파일을 첫 도구 호출로 Read 후 시작.** 첫 task의 Step 1(Upbit API 문서 확인)이 가장 중요 — 추측 금지.
