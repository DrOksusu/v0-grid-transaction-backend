# MEXC USDT 현물 그리드 — 백엔드 구현 플랜 (MVP)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 그리드 엔진을 재사용해 MEXC 현물 USDT 페어(BTCUSDT 등)에서 그리드 매매가 되도록 백엔드를 확장한다(MVP, 관리자 canary).

**Architecture:** 접근 A — `GridTradeClient` 규격을 구현하는 신규 `MexcGridClient`와 `mexcGridPriceManager`를 만들고, `trading.service.ts`의 거래소 분기에 `mexc` 케이스를 가산한다. 기존 upbit/bithumb 경로·357 라이브 KRW 봇은 불변. 손익은 USDT로 기록(스키마 변경 없음).

**Tech Stack:** TypeScript, Express, Prisma(MySQL), axios, MEXC REST `/api/v3/*` (HMAC-SHA256), Jest.

**스펙:** `docs/superpowers/specs/2026-10-07-mexc-usdt-grid-design.md`

**범위:** 백엔드만. 프론트(그리드 폼 MEXC 옵션·USDT 표기)는 별도 플랜/서브에이전트.

---

## 확정 인터페이스 계약 (코드 조사로 확인)

엔진이 `GridTradeClient`에서 읽는 필드 (MexcGridClient가 맞춰야 할 정규화 타깃):
- `buyLimit/sellLimit(market,price,volume)` 반환 → 엔진은 `order.uuid`를 읽어 `gridLevel.orderId`에 저장 (`trading.service.ts:399,410`). → **`{ uuid: string }` 반환.**
- `getFilledOrders(market,limit)` 반환 배열 → 엔진은 각 `order.uuid`로 그리드 매칭 + `order.state === 'done'` 확인 (`:788-790`). → **각 원소 `{ uuid, state:'done', avgFillPrice, filledQty, trades? }`.**
- stale 체크(2단계) bithumb 경로 → `getOrder(orderId)` 반환 `order.status === 'filled' | 'cancelled'` (`:834-840`). → **MEXC는 bithumb식: `getOrder(orderId, symbol)` → `{ status, avgFillPrice, filledQty }`.**
- `processFilledOrder`는 `order.avgFillPrice ?? order.avg_price ?? order.price` 와 `order.filledQty ?? order.executed_volume`, 선택적으로 `order.trades[].created_at`을 읽음 (`:1049-1054,1017-1020`). → MEXC는 `avgFillPrice`/`filledQty` 채움.
- `cancelOrder(uuid)` — 반환 무시.

MEXC REST 사실:
- 주문: `POST /api/v3/order` params `{ symbol, side:'BUY'|'SELL', type:'LIMIT', timeInForce:'GTC', quantity, price }` → 응답 `{ orderId, ... }`. 호출은 `mexcPost(apiKey, secretKey, '/api/v3/order', params)` (exchange-signer).
- 조회: `GET /api/v3/order` params `{ symbol, orderId }` → `{ status, executedQty, cummulativeQuoteQty, price, ... }`. `GET /api/v3/allOrders` params `{ symbol, limit }` → 위 객체 배열. 호출은 `signedGet(MEXC.baseUrl, MEXC.apiKeyHeader, apiKey, secretKey, endpoint, params)`.
- 취소: `DELETE /api/v3/order?{symbol,orderId,timestamp,signature}` + header `X-MEXC-APIKEY` (MexcLeg.cancelOrderQuiet 패턴).
- 정밀도: `GET /api/v3/exchangeInfo?symbol=BTCUSDT`(공개) → `symbols[0].filters`: `PRICE_FILTER.tickSize`, `LOT_SIZE.stepSize`, `NOTIONAL.minNotional`(또는 `MIN_NOTIONAL.minNotional`).
- 상태 매핑: `FILLED`→filled/done, `CANCELED`/`PARTIALLY_CANCELED`/`EXPIRED`/`REJECTED`→cancelled, 그 외(`NEW`,`PARTIALLY_FILLED`)→pending.
- 평균체결가: `cummulativeQuoteQty / executedQty` (executedQty>0일 때).
- 심볼 포맷: grid `bot.ticker`가 이미 `BTCUSDT`(full). MEXC API에 그대로 전달 — **접미사 'USDT' 추가 금지**(MexcLeg.getPricePrecision은 base심볼+USDT라 재사용 불가, 신규 구현).

---

## File Structure

- **Create** `src/services/exchange/mexc-grid-client.ts` — `MexcGridClient`(GridTradeClient 구현 + getOrder). MEXC 주문 I/O·정밀도·정규화. 단일 책임: MEXC 현물 주문 어댑터.
- **Create** `src/services/mexc-grid-price-manager.ts` — MEXC 현재가 폴링+캐시. 단일 책임: MEXC 가격 피드.
- **Modify** `src/services/trading.service.ts` — `getFeeRate`에 mexc; `resolveGridClient` 헬퍼 신설 후 3개 분기점 치환; 현재가 2곳 mexc 분기; stale 폴링에 mexc 분기; start 전 USDT pre-flight.
- **Create** tests: `__tests__/services/mexc-grid-client.test.ts`, `__tests__/services/mexc-grid-price-manager.test.ts`, `__tests__/services/trading-mexc-branch.test.ts`.

---

## Task 1: MexcGridClient 골격 + 심볼 필터(정밀도) 로더

**Files:**
- Create: `src/services/exchange/mexc-grid-client.ts`
- Test: `__tests__/services/mexc-grid-client.test.ts`

- [ ] **Step 1: 실패 테스트 작성** (`__tests__/services/mexc-grid-client.test.ts`)

```typescript
import { roundToStep, roundToTick, meetsMinNotional } from '../../src/services/exchange/mexc-grid-client';

describe('MexcGridClient 정밀도 유틸', () => {
  it('stepSize로 수량 내림(floor)', () => {
    expect(roundToStep(0.123456789, 0.000001)).toBeCloseTo(0.123456, 9);
    expect(roundToStep(1.9999, 0.001)).toBeCloseTo(1.999, 9);
  });
  it('tickSize로 가격 내림(floor)', () => {
    expect(roundToTick(63123.47, 0.01)).toBeCloseTo(63123.47, 6);
    expect(roundToTick(63123.479, 0.1)).toBeCloseTo(63123.4, 6);
  });
  it('minNotional 미만이면 false', () => {
    expect(meetsMinNotional(0.0001, 63000, 5)).toBe(true);   // 6.3 USDT ≥ 5
    expect(meetsMinNotional(0.00001, 63000, 5)).toBe(false); // 0.63 USDT < 5
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest mexc-grid-client -t '정밀도'`
Expected: FAIL — `Cannot find module '.../mexc-grid-client'`

- [ ] **Step 3: 최소 구현** (`src/services/exchange/mexc-grid-client.ts`)

```typescript
// MEXC 현물 그리드 어댑터 — GridTradeClient 규격 구현.
// 재고형 아비용 MexcLeg(IOC)와 별개: 그리드는 GTC 지정가 + 체결 폴링이 필요하다.
import axios from 'axios';
import { MEXC, hmacSign, mexcPost, signedGet } from './exchange-signer';

/** 수량을 stepSize 배수로 내림(floor). 거래소 LOT_SIZE 통과용. */
export function roundToStep(qty: number, step: number): number {
  if (!(step > 0)) return qty;
  return Math.floor(qty / step) * step;
}

/** 가격을 tickSize 배수로 내림(floor). PRICE_FILTER 통과용. */
export function roundToTick(price: number, tick: number): number {
  if (!(tick > 0)) return price;
  return Math.floor(price / tick) * tick;
}

/** qty*price 가 minNotional 이상인지. */
export function meetsMinNotional(qty: number, price: number, minNotional: number): boolean {
  return qty * price >= minNotional;
}

interface SymbolFilters { tickSize: number; stepSize: number; minNotional: number; }

export class MexcGridClient {
  private filtersCache = new Map<string, { at: number; f: SymbolFilters }>();

  constructor(private readonly creds: { apiKey: string; secretKey: string }) {}

  /** exchangeInfo 필터 조회(공개 API, 1시간 캐시). 실패 시 보수적 기본값. */
  async getFilters(symbol: string): Promise<SymbolFilters> {
    const hit = this.filtersCache.get(symbol);
    if (hit && Date.now() - hit.at < 3600_000) return hit.f;
    try {
      const res = await axios.get(`${MEXC.baseUrl}/api/v3/exchangeInfo?symbol=${symbol}`, { timeout: 8000 });
      const info = res.data?.symbols?.[0];
      const filters: any[] = info?.filters ?? [];
      const price = filters.find((x) => x.filterType === 'PRICE_FILTER');
      const lot = filters.find((x) => x.filterType === 'LOT_SIZE');
      const notional = filters.find((x) => x.filterType === 'NOTIONAL' || x.filterType === 'MIN_NOTIONAL');
      const f: SymbolFilters = {
        tickSize: Number(price?.tickSize) || 0.01,
        stepSize: Number(lot?.stepSize) || 0.000001,
        minNotional: Number(notional?.minNotional) || 1,
      };
      this.filtersCache.set(symbol, { at: Date.now(), f });
      return f;
    } catch {
      return { tickSize: 0.01, stepSize: 0.000001, minNotional: 1 };
    }
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest mexc-grid-client -t '정밀도'`
Expected: PASS (3 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/services/exchange/mexc-grid-client.ts __tests__/services/mexc-grid-client.test.ts
git commit -m "feat: MexcGridClient 골격 + 정밀도/minNotional 유틸"
```

---

## Task 2: buyLimit / sellLimit (GTC 지정가, {uuid} 반환)

**Files:**
- Modify: `src/services/exchange/mexc-grid-client.ts`
- Test: `__tests__/services/mexc-grid-client.test.ts`

- [ ] **Step 1: 실패 테스트 작성** (기존 test 파일에 추가)

```typescript
import * as signer from '../../src/services/exchange/exchange-signer';
import { MexcGridClient } from '../../src/services/exchange/mexc-grid-client';

describe('MexcGridClient 주문', () => {
  const client = new MexcGridClient({ apiKey: 'k', secretKey: 's' });
  beforeEach(() => {
    jest.spyOn(client, 'getFilters').mockResolvedValue({ tickSize: 0.01, stepSize: 0.000001, minNotional: 1 });
  });
  afterEach(() => jest.restoreAllMocks());

  it('buyLimit: GTC 지정가 파라미터로 mexcPost 호출하고 {uuid} 반환', async () => {
    const spy = jest.spyOn(signer, 'mexcPost').mockResolvedValue({ orderId: 123456 });
    const r = await client.buyLimit('BTCUSDT', 63123.479, 0.0012345678);
    expect(r).toEqual({ uuid: '123456' });
    const [, , endpoint, params] = spy.mock.calls[0] as any;
    expect(endpoint).toBe('/api/v3/order');
    expect(params.symbol).toBe('BTCUSDT');
    expect(params.side).toBe('BUY');
    expect(params.type).toBe('LIMIT');
    expect(params.timeInForce).toBe('GTC');
    expect(params.price).toBe('63123.47');      // tick 0.01 floor
    expect(params.quantity).toBe('0.001234');   // step 0.000001 floor
  });

  it('sellLimit: side SELL', async () => {
    const spy = jest.spyOn(signer, 'mexcPost').mockResolvedValue({ orderId: 999 });
    const r = await client.sellLimit('BTCUSDT', 64000, 0.002);
    expect(r).toEqual({ uuid: '999' });
    expect((spy.mock.calls[0] as any)[3].side).toBe('SELL');
  });

  it('minNotional 미만이면 주문 안 하고 throw', async () => {
    jest.spyOn(signer, 'mexcPost');
    await expect(client.buyLimit('BTCUSDT', 1, 0.0000001)).rejects.toThrow(/minNotional|최소/);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest mexc-grid-client -t '주문'`
Expected: FAIL — `client.buyLimit is not a function`

- [ ] **Step 3: 구현** (MexcGridClient에 메서드 추가)

```typescript
  private async placeLimit(symbol: string, side: 'BUY' | 'SELL', price: number, volume: number): Promise<{ uuid: string }> {
    const f = await this.getFilters(symbol);
    const p = roundToTick(price, f.tickSize);
    const q = roundToStep(volume, f.stepSize);
    if (!meetsMinNotional(q, p, f.minNotional)) {
      throw new Error(`MEXC minNotional 미만: ${(q * p).toFixed(4)} < ${f.minNotional}`);
    }
    const params: Record<string, string> = {
      symbol,
      side,
      type: 'LIMIT',
      timeInForce: 'GTC',
      quantity: String(q),
      price: String(p),
    };
    const resp = await mexcPost(this.creds.apiKey, this.creds.secretKey, '/api/v3/order', params);
    return { uuid: String(resp.orderId) };
  }

  async buyLimit(market: string, price: number, volume: number): Promise<{ uuid: string }> {
    return this.placeLimit(market, 'BUY', price, volume);
  }

  async sellLimit(market: string, price: number, volume: number): Promise<{ uuid: string }> {
    return this.placeLimit(market, 'SELL', price, volume);
  }
```

> 참고: `String(q)`가 지수표기(e-7 등)로 나오면 MEXC가 거부할 수 있다. stepSize가 1e-6 수준이면 일반적으로 고정소수 문자열이지만, 안전을 위해 `q.toFixed(n)`로 바꾸는 개선은 Task 수행 시 `toFixed(소수자리=stepSize 자리수)`로 처리한다. 테스트의 기대값(`'0.001234'`)은 `String()` 기준이며, toFixed 적용 시 기대값을 `'0.001234'`로 동일하게 맞춘다(6자리).

- [ ] **Step 4: 통과 확인**

Run: `npx jest mexc-grid-client -t '주문'`
Expected: PASS (3 tests)

- [ ] **Step 5: 커밋**

```bash
git add -A && git commit -m "feat: MexcGridClient buyLimit/sellLimit (GTC, {uuid} 반환)"
```

---

## Task 3: getFilledOrders (allOrders → 업비트형 정규화)

**Files:**
- Modify: `src/services/exchange/mexc-grid-client.ts`
- Test: `__tests__/services/mexc-grid-client.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

```typescript
describe('MexcGridClient getFilledOrders 정규화', () => {
  const client = new MexcGridClient({ apiKey: 'k', secretKey: 's' });
  afterEach(() => jest.restoreAllMocks());

  it('FILLED 주문을 {uuid,state:done,avgFillPrice,filledQty}로 정규화', async () => {
    jest.spyOn(signer, 'signedGet').mockResolvedValue([
      { orderId: 1, status: 'FILLED', executedQty: '0.002', cummulativeQuoteQty: '126.0', price: '63000', updateTime: 1730000000000 },
      { orderId: 2, status: 'NEW', executedQty: '0', cummulativeQuoteQty: '0', price: '62000' },
    ]);
    const r = await client.getFilledOrders('BTCUSDT', 100);
    expect(r).toHaveLength(1);
    expect(r[0].uuid).toBe('1');
    expect(r[0].state).toBe('done');
    expect(r[0].filledQty).toBeCloseTo(0.002, 9);
    expect(r[0].avgFillPrice).toBeCloseTo(63000, 6); // 126.0/0.002
    expect(r[0].trades[0].created_at).toBeTruthy();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest mexc-grid-client -t 'getFilledOrders'`
Expected: FAIL — `client.getFilledOrders is not a function`

- [ ] **Step 3: 구현**

```typescript
  /** MEXC 체결건을 업비트형({uuid,state:'done',avgFillPrice,filledQty,trades})으로 정규화. */
  async getFilledOrders(market?: string, limit: number = 100): Promise<any[]> {
    if (!market) return []; // MEXC allOrders는 symbol 필수
    const data = await signedGet(
      MEXC.baseUrl, MEXC.apiKeyHeader, this.creds.apiKey, this.creds.secretKey,
      '/api/v3/allOrders', { symbol: market, limit: String(Math.min(limit, 100)) },
    );
    const rows: any[] = Array.isArray(data) ? data : [];
    return rows
      .filter((o) => String(o.status) === 'FILLED')
      .map((o) => {
        const qty = parseFloat(o.executedQty ?? '0');
        const quote = parseFloat(o.cummulativeQuoteQty ?? '0');
        const avg = qty > 0 ? quote / qty : parseFloat(o.price ?? '0');
        const ts = Number(o.updateTime ?? o.time ?? Date.now());
        return { uuid: String(o.orderId), state: 'done', avgFillPrice: avg, filledQty: qty, trades: [{ created_at: new Date(ts).toISOString() }] };
      });
  }
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest mexc-grid-client -t 'getFilledOrders'`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add -A && git commit -m "feat: MexcGridClient getFilledOrders 업비트형 정규화"
```

---

## Task 4: getOrder(stale용) + cancelOrder(DELETE)

**Files:**
- Modify: `src/services/exchange/mexc-grid-client.ts`
- Test: `__tests__/services/mexc-grid-client.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

```typescript
describe('MexcGridClient getOrder/cancelOrder', () => {
  const client = new MexcGridClient({ apiKey: 'k', secretKey: 's' });
  afterEach(() => jest.restoreAllMocks());

  it('getOrder: FILLED→status filled + avgFillPrice/filledQty', async () => {
    jest.spyOn(signer, 'signedGet').mockResolvedValue({ orderId: 7, status: 'FILLED', executedQty: '0.001', cummulativeQuoteQty: '63.0', price: '63000' });
    const o = await client.getOrder('7', 'BTCUSDT');
    expect(o.status).toBe('filled');
    expect(o.filledQty).toBeCloseTo(0.001, 9);
    expect(o.avgFillPrice).toBeCloseTo(63000, 6);
  });

  it('getOrder: CANCELED→status cancelled', async () => {
    jest.spyOn(signer, 'signedGet').mockResolvedValue({ orderId: 8, status: 'CANCELED', executedQty: '0', cummulativeQuoteQty: '0' });
    const o = await client.getOrder('8', 'BTCUSDT');
    expect(o.status).toBe('cancelled');
  });

  it('cancelOrder: 실패해도 throw 안 함(이미 종료 가능)', async () => {
    jest.spyOn(axios, 'delete').mockRejectedValue(new Error('order not found'));
    await expect(client.cancelOrder('9', 'BTCUSDT')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest mexc-grid-client -t 'getOrder/cancelOrder'`
Expected: FAIL — `client.getOrder is not a function`

- [ ] **Step 3: 구현**

```typescript
  /** 단건 주문 조회 → bithumb식 {status:'filled'|'cancelled'|'pending', avgFillPrice, filledQty}. */
  async getOrder(orderId: string, symbol: string): Promise<{ status: string; avgFillPrice: number; filledQty: number }> {
    const data = await signedGet(
      MEXC.baseUrl, MEXC.apiKeyHeader, this.creds.apiKey, this.creds.secretKey,
      '/api/v3/order', { symbol, orderId },
    );
    const qty = parseFloat(data.executedQty ?? '0');
    const quote = parseFloat(data.cummulativeQuoteQty ?? '0');
    const raw = String(data.status ?? '');
    const status = raw === 'FILLED' ? 'filled'
      : ['CANCELED', 'PARTIALLY_CANCELED', 'EXPIRED', 'REJECTED'].includes(raw) ? 'cancelled'
      : 'pending';
    return { status, avgFillPrice: qty > 0 ? quote / qty : parseFloat(data.price ?? '0'), filledQty: qty };
  }

  /** 미체결 취소(DELETE /api/v3/order). 이미 종료된 주문일 수 있어 실패는 무시. */
  async cancelOrder(orderId: string, symbol?: string): Promise<void> {
    if (!symbol) return; // MEXC는 symbol 필수
    try {
      const timestamp = Date.now().toString();
      const allParams = { symbol, orderId, timestamp };
      const signature = hmacSign(this.creds.secretKey, allParams);
      const qs = new URLSearchParams({ ...allParams, signature }).toString();
      await axios.delete(`${MEXC.baseUrl}/api/v3/order?${qs}`, {
        headers: { [MEXC.apiKeyHeader]: this.creds.apiKey },
        timeout: 8000,
      });
    } catch {
      // 이미 종료된 주문일 수 있음 — 무시
    }
  }
```

> 참고: `GridTradeClient`의 `cancelOrder(uuid)`는 1-인자지만, MEXC는 symbol이 필요하다. 엔진의 그리드 취소 호출 지점에서 `grid.bot.ticker`를 2번째 인자로 넘기도록 Task 6에서 처리한다(upbit/bithumb는 2번째 인자 무시).

- [ ] **Step 4: 통과 확인**

Run: `npx jest mexc-grid-client -t 'getOrder/cancelOrder'`
Expected: PASS (3 tests)

- [ ] **Step 5: 커밋**

```bash
git add -A && git commit -m "feat: MexcGridClient getOrder(stale)+cancelOrder(DELETE)"
```

---

## Task 5: mexcGridPriceManager (현재가 폴링+캐시)

**Files:**
- Create: `src/services/mexc-grid-price-manager.ts`
- Test: `__tests__/services/mexc-grid-price-manager.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

```typescript
import axios from 'axios';
import { mexcGridPriceManager } from '../../src/services/mexc-grid-price-manager';

describe('mexcGridPriceManager', () => {
  afterEach(() => jest.restoreAllMocks());
  it('ticker/price 응답을 숫자로 반환', async () => {
    jest.spyOn(axios, 'get').mockResolvedValue({ data: { price: '63123.45' } });
    const p = await mexcGridPriceManager.getPriceWithFallback('BTCUSDT');
    expect(p).toBeCloseTo(63123.45, 2);
  });
  it('2초 내 재조회는 캐시 사용(axios 1회만)', async () => {
    const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: { price: '100' } });
    await mexcGridPriceManager.getPriceWithFallback('ETHUSDT');
    await mexcGridPriceManager.getPriceWithFallback('ETHUSDT');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest mexc-grid-price-manager`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: 구현** (`src/services/mexc-grid-price-manager.ts`)

```typescript
// MEXC 현물 현재가 피드(그리드용). MVP는 REST 폴링 + 2초 캐시. 실시간 WS는 후속.
import axios from 'axios';
import { MEXC } from './exchange/exchange-signer';

const CACHE_MS = 2000;

class MexcGridPriceManager {
  private cache = new Map<string, { at: number; price: number }>();

  /** 심볼(BTCUSDT) 현재가. 2초 캐시. 실패 시 직전 캐시가 있으면 반환, 없으면 throw. */
  async getPriceWithFallback(ticker: string): Promise<number> {
    const hit = this.cache.get(ticker);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.price;
    try {
      const res = await axios.get(`${MEXC.baseUrl}/api/v3/ticker/price?symbol=${ticker}`, { timeout: 8000 });
      const price = parseFloat(res.data?.price ?? '0');
      if (!(price > 0)) throw new Error(`MEXC 현재가 이상: ${res.data?.price}`);
      this.cache.set(ticker, { at: Date.now(), price });
      return price;
    } catch (e) {
      if (hit) return hit.price; // 폴백: 직전값
      throw e;
    }
  }
}

export const mexcGridPriceManager = new MexcGridPriceManager();
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest mexc-grid-price-manager`
Expected: PASS (2 tests)

- [ ] **Step 5: 커밋**

```bash
git add -A && git commit -m "feat: mexcGridPriceManager 현재가 폴링+캐시"
```

---

## Task 6: trading.service 분기 — resolveGridClient + getFeeRate + 현재가 + stale 폴링

**Files:**
- Modify: `src/services/trading.service.ts`
  - `getFeeRate` (line ~19-21)
  - 클라이언트 생성 3곳 (line ~320-322, ~762-764, ~953-955) → `resolveGridClient`로 치환
  - 현재가 2곳 (line ~325-326, ~665-666)
  - stale 폴링 분기 (line ~830)
- Test: `__tests__/services/trading-mexc-branch.test.ts`

- [ ] **Step 1: 실패 테스트 작성** (`__tests__/services/trading-mexc-branch.test.ts`)

```typescript
import { getFeeRate, resolveGridClient } from '../../src/services/trading.service';
import { MexcGridClient } from '../../src/services/exchange/mexc-grid-client';
import { BithumbClient } from '../../src/services/exchange/bithumb-client';
import { UpbitService } from '../../src/services/upbit.service';

describe('trading.service mexc 분기', () => {
  const cred = { apiKey: 'k', secretKey: 's' };
  it('getFeeRate: mexc는 env 기본 0.0005', () => {
    expect(getFeeRate('mexc')).toBeCloseTo(0.0005, 6);
    expect(getFeeRate('bithumb')).toBeCloseTo(0.0004, 6);
    expect(getFeeRate('upbit')).toBeCloseTo(0.0005, 6);
  });
  it('resolveGridClient: 거래소별 올바른 클라이언트', () => {
    expect(resolveGridClient('mexc', cred)).toBeInstanceOf(MexcGridClient);
    expect(resolveGridClient('bithumb', cred)).toBeInstanceOf(BithumbClient);
    expect(resolveGridClient('upbit', cred)).toBeInstanceOf(UpbitService);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest trading-mexc-branch`
Expected: FAIL — `resolveGridClient is not exported` / `getFeeRate ... mexc`

- [ ] **Step 3: 구현**

3-1. `getFeeRate` 교체 (line ~19-21):

```typescript
function getFeeRate(exchange: string): number {
  if (exchange === 'bithumb') return 0.0004;
  if (exchange === 'mexc') return (Number(process.env.MEXC_SPOT_FEE_BPS) || 5) / 10000;
  return 0.0005; // upbit 기본
}
export { getFeeRate };
```

3-2. 파일 상단 import 추가:

```typescript
import { MexcGridClient } from './exchange/mexc-grid-client';
import { mexcGridPriceManager } from './mexc-grid-price-manager';
```

3-3. `resolveGridClient` 헬퍼 신설(파일 상단, GridTradeClient 정의 아래):

```typescript
// 거래소별 그리드 클라이언트 해석(3개 분기점 공용). upbit/bithumb/mexc 가산.
export function resolveGridClient(
  exchange: string,
  cred: { apiKey: string; secretKey: string },
): GridTradeClient {
  if (exchange === 'bithumb') return new BithumbClient({ accessKey: cred.apiKey, secretKey: cred.secretKey });
  if (exchange === 'mexc') return new MexcGridClient({ apiKey: cred.apiKey, secretKey: cred.secretKey });
  return new UpbitService({ accessKey: cred.apiKey, secretKey: cred.secretKey });
}
```

> `MexcGridClient`는 `GridTradeClient`(buyLimit/sellLimit/cancelOrder/getFilledOrders)를 만족한다. `cancelOrder(uuid, symbol?)`·`getFilledOrders(market,limit)` 시그니처가 호환되므로 타입 OK.

3-4. 클라이언트 생성 3곳 치환 — 각 지점의 `const upbit: GridTradeClient = exchange === 'bithumb' ? ... : new UpbitService(...)` 를 다음으로:

```typescript
const upbit: GridTradeClient = resolveGridClient(botExchange /* 또는 exchange */, { apiKey: credential.apiKey, secretKey: credential.secretKey });
```
(line ~320, ~762, ~953. 변수명 `botExchange`/`exchange`는 각 지점 기존 변수 사용.)

3-5. 현재가 2곳(line ~325, ~665) — 기존:
```typescript
const currentPrice = botExchange === 'bithumb'
  ? await bithumbPriceManager.getPriceWithFallback(bot.ticker)
  : await priceManager.getCurrentPrice(bot.ticker);
```
를:
```typescript
const currentPrice = botExchange === 'mexc'
  ? await mexcGridPriceManager.getPriceWithFallback(bot.ticker)
  : botExchange === 'bithumb'
    ? await bithumbPriceManager.getPriceWithFallback(bot.ticker)
    : await priceManager.getCurrentPrice(bot.ticker);
```
(업비트 현재가 호출 형태는 기존 코드 그대로 유지 — 위 `priceManager.getCurrentPrice`는 해당 지점의 실제 표현식으로 맞출 것.)

3-6. stale 폴링(line ~830) — `if (exchange === 'bithumb')` 분기를 mexc도 포함하도록. mexc는 `getOrder(orderId, ticker)` 호출이 필요(symbol 전달):

```typescript
if (exchange === 'bithumb' || exchange === 'mexc') {
  for (const grid of staleGrids) {
    try {
      const order = exchange === 'mexc'
        ? await (upbit as any).getOrder(grid.orderId!, grid.bot.ticker)
        : await (upbit as any).getOrder(grid.orderId!);
      if (order.status === 'filled') {
        await this.processFilledOrder(grid, order, upbit, userId, exchange);
        totalFilledCount++;
      } else if (order.status === 'cancelled') {
        await prisma.gridLevel.update({ where: { id: grid.id }, data: { status: 'available', orderId: null, filledAt: null } });
      }
    } catch { /* 개별 조회 실패 무시 */ }
  }
} else {
  // 업비트 배치 경로 (기존 그대로)
}
```

> Stage1 체결폴링(`getFilledOrders(market,100)` + `order.uuid`/`order.state==='done'`)은 MEXC 정규화가 업비트형이라 **수정 불필요**(mexc도 자동 동작).

- [ ] **Step 4: 통과 확인**

Run: `npx jest trading-mexc-branch` 그리고 `npx tsc --noEmit`
Expected: PASS (2 tests), tsc 0 errors

- [ ] **Step 5: 회귀 확인**

Run: `npx jest trading` (기존 trading 관련 테스트)
Expected: 기존 테스트 전부 PASS(가산 변경이라 무회귀)

- [ ] **Step 6: 커밋**

```bash
git add -A && git commit -m "feat: trading.service에 mexc 그리드 분기 가산(resolveGridClient/fee/price/stale)"
```

---

## Task 7: start 전 USDT pre-flight 잔고 체크

**Files:**
- Modify: `src/services/trading.service.ts` (봇 start 경로 — `startBot`/`createGridOrders` 진입부)
- Test: `__tests__/services/trading-mexc-branch.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

```typescript
import { checkMexcUsdtBalance } from '../../src/services/trading.service';
import * as mgc from '../../src/services/exchange/mexc-grid-client';

describe('MEXC start pre-flight', () => {
  afterEach(() => jest.restoreAllMocks());
  it('USDT 가용 < 투입금이면 { ok:false }', async () => {
    jest.spyOn(MexcGridClient.prototype as any, 'getUsdtBalance').mockResolvedValue(10);
    const r = await checkMexcUsdtBalance({ apiKey: 'k', secretKey: 's' }, 50);
    expect(r.ok).toBe(false);
  });
  it('USDT 가용 ≥ 투입금이면 { ok:true }', async () => {
    jest.spyOn(MexcGridClient.prototype as any, 'getUsdtBalance').mockResolvedValue(100);
    const r = await checkMexcUsdtBalance({ apiKey: 'k', secretKey: 's' }, 50);
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest trading-mexc-branch -t 'pre-flight'`
Expected: FAIL — `checkMexcUsdtBalance`/`getUsdtBalance` 미정의

- [ ] **Step 3: 구현**

3-1. `MexcGridClient`에 `getUsdtBalance` 추가 (mexc-grid-client.ts):

```typescript
  /** USDT 가용 잔고(free). pre-flight용. */
  async getUsdtBalance(): Promise<number> {
    const data = await signedGet(
      MEXC.baseUrl, MEXC.apiKeyHeader, this.creds.apiKey, this.creds.secretKey, '/api/v3/account',
    );
    const b = (data.balances ?? []).find((x: any) => String(x.asset).toUpperCase() === 'USDT');
    return b ? parseFloat(b.free ?? '0') : 0;
  }
```

3-2. `trading.service.ts`에 pre-flight 헬퍼 + start 경로 호출:

```typescript
export async function checkMexcUsdtBalance(
  cred: { apiKey: string; secretKey: string }, investmentUsdt: number,
): Promise<{ ok: boolean; available: number }> {
  const client = new MexcGridClient({ apiKey: cred.apiKey, secretKey: cred.secretKey });
  const available = await client.getUsdtBalance();
  return { ok: available >= investmentUsdt, available };
}
```

start 진입부(봇 상태를 running으로 바꾸고 최초 그리드 주문 생성하기 직전)에서 `bot.exchange === 'mexc'`면 호출하고, `ok===false`면 봇을 `error` 상태(errorMessage=`USDT 잔고 부족: 가용 ${available} < 투입 ${investmentUsdt}`)로 두고 중단.

- [ ] **Step 4: 통과 확인**

Run: `npx jest trading-mexc-branch -t 'pre-flight'`
Expected: PASS (2 tests)

- [ ] **Step 5: 커밋**

```bash
git add -A && git commit -m "feat: MEXC 그리드 start 전 USDT 잔고 pre-flight"
```

---

## Task 8: USDT 손익 분리 헬퍼 (대시보드 집계)

**Files:**
- Create: `src/utils/quote-currency.ts`
- Modify: `src/controllers/profit.controller.ts` 또는 수익 집계 지점(KRW 합계에 mexc 제외 + USDT 별도 합계)
- Test: `__tests__/utils/quote-currency.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

```typescript
import { isUsdtQuote, splitByQuote } from '../../src/utils/quote-currency';

describe('quote-currency', () => {
  it('mexc는 USDT quote', () => {
    expect(isUsdtQuote('mexc')).toBe(true);
    expect(isUsdtQuote('upbit')).toBe(false);
    expect(isUsdtQuote('bithumb')).toBe(false);
  });
  it('splitByQuote: krw/usdt 분리 합계', () => {
    const bots = [
      { exchange: 'upbit', currentProfit: 1000 },
      { exchange: 'bithumb', currentProfit: 500 },
      { exchange: 'mexc', currentProfit: 12.5 },
    ];
    const r = splitByQuote(bots);
    expect(r.krwProfit).toBe(1500);
    expect(r.usdtProfit).toBeCloseTo(12.5, 6);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest quote-currency`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: 구현** (`src/utils/quote-currency.ts`)

```typescript
// 거래소별 호가통화(quote) 판정 + KRW/USDT 손익 분리.
export function isUsdtQuote(exchange: string): boolean {
  return exchange === 'mexc';
}

export function splitByQuote<T extends { exchange: string; currentProfit: number }>(
  bots: T[],
): { krwProfit: number; usdtProfit: number } {
  let krwProfit = 0, usdtProfit = 0;
  for (const b of bots) {
    if (isUsdtQuote(b.exchange)) usdtProfit += b.currentProfit ?? 0;
    else krwProfit += b.currentProfit ?? 0;
  }
  return { krwProfit, usdtProfit };
}
```

3-2. 수익 집계 API(profit.controller.ts 등)에서 KRW 총합에 `isUsdtQuote(exchange)` 봇을 제외하고, `usdtProfit`을 별도 필드로 응답에 추가(프론트가 USDT 섹션에 표시).

- [ ] **Step 4: 통과 확인**

Run: `npx jest quote-currency`
Expected: PASS (2 tests)

- [ ] **Step 5: 커밋**

```bash
git add -A && git commit -m "feat: KRW/USDT 손익 분리 헬퍼(isUsdtQuote/splitByQuote)"
```

---

## Task 9: 전체 빌드·테스트·tsc 최종 확인

- [ ] **Step 1: 타입체크**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 2: 전체 관련 테스트**

Run: `npx jest mexc-grid-client mexc-grid-price-manager trading-mexc-branch quote-currency`
Expected: 전부 PASS

- [ ] **Step 3: 회귀(기존 그리드/trading 테스트)**

Run: `npx jest trading grid`
Expected: 기존 테스트 무회귀 PASS

- [ ] **Step 4: 커밋(필요 시)**

```bash
git add -A && git commit -m "chore: MEXC 그리드 백엔드 MVP 최종 검증"
```

---

## 수동 canary (배포 후, 사용자 승인 하)

1. 관리자 프론트에서 MEXC BTCUSDT 그리드 봇 생성(소액: 투입 20~50 USDT, gridCount 소수, 현재가 중심 좁은 범위) — 기본 stopped.
2. MEXC에 USDT 잔고 준비 후 수동 start → pre-flight 통과 확인.
3. 로그/DB로 확인: GTC 지정가 발주 → 체결 감지(Stage1 getFilledOrders) → 반대편 재배치 → Trade(USDT) 기록 → Bot.currentProfit(USDT) 갱신.
4. stale 경로(10분+ 미체결) getOrder 동작 확인.
5. 이상 시 봇 stop + 미체결 cancelOrder 정리.

---

## Self-Review (작성자 체크)

- **스펙 커버리지**: ①어댑터=Task1-4·7, ②가격매니저=Task5, ③엔진분기=Task6, ④USDT손익분리=Task8, ⑤안전/canary=Task7+수동canary, ⑥UI=별도 프론트 플랜(범위 외 명시). 커버 OK.
- **플레이스홀더**: 각 Task에 실제 테스트·구현 코드 포함. "handle edge cases" 류 없음. (3-5 현재가/3-6 stale은 기존 표현식에 맞추라는 지시 포함 — 실제 라인 변수명은 구현 시 확인.)
- **타입 일관성**: `{uuid}`(buyLimit), `{uuid,state:'done',avgFillPrice,filledQty,trades}`(getFilledOrders), `{status,avgFillPrice,filledQty}`(getOrder) — Task 간 일관. `resolveGridClient`·`getFeeRate`·`checkMexcUsdtBalance`·`isUsdtQuote`·`splitByQuote` 시그니처 일관.
- **주의(구현자)**: trading.service의 정확한 라인/변수명(botExchange vs exchange, 업비트 현재가 호출 표현식)은 가산 전 해당 지점을 Read로 확인 후 반영. 기존 upbit/bithumb 동작·반환형 변경 금지(가산만).
