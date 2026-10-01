# 빗썸 Private WebSocket V1→V2 마이그레이션 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 2026-10-30 종료되는 빗썸 Private WebSocket V1(`/websocket/v1/private`, 실시간 체결 myOrder)을 V2(`/websocket/v2/private`)로 전환해 실시간 체결 감지를 끊김 없이 유지한다.

**Architecture:** 실시간 체결 감지는 `src/services/private-order-ws.ts`의 `PrivateOrderWsConnection`/`PrivateOrderWsPool`에 거래소 중립적으로 구현돼 있고, 엔드포인트·JWT 생성·구독 페이로드가 전부 주입/중앙화돼 있다. 따라서 전환 = ①빗썸 기본 엔드포인트 상수 v1→v2 ②구독 페이로드에 `format:'DEFAULT'` 추가 ③메시지 파싱을 V2 DEFAULT+SIMPLE 필드까지 방어적으로 확장. 인증(JWT)·state 판정값·구독 구조는 V1과 동일해 변경 불필요. 배포는 기존 `REALTIME_FILL_WS_MODE` off/shadow/on 단계로 shadow에서 실제 V2 메시지를 검증한 뒤 on으로 전환한다.

**Tech Stack:** TypeScript · `ws`(WebSocket) · Jest · 기존 JWT(`generateBithumbJwt`, HS256 access_key/nonce/timestamp)

---

## 배경 사실 (조사 완료, 2026-10-01)

- **현재 production**: `REALTIME_FILL_WS_MODE=on` — 빗썸 v1 private WS가 실가동 중. 미전환 시 10-30에 끊기고 30초 폴링으로 폴백(안전하나 실시간 감지 상실).
- **V2 변경점** (빗썸 API Docs 확인):
  - 엔드포인트: `wss://ws-api.bithumb.com/websocket/v2/private` (v1은 `/v1/private`)
  - 인증: JWT Bearer 헤더 동일 (`generateBithumbJwt` 그대로 사용 — 변경 없음)
  - 구독 요청: `ticket` + `type:'myOrder'` + `codes`(대문자 KRW-XXX, 생략 시 전체) 동일 구조. V2는 `format`(DEFAULT/SIMPLE) 지원 → DEFAULT 명시 권장.
  - 응답: "식별자 표준화 + 주문/체결 정보 분리". DEFAULT 필드 = `type`, `stream_type`, `code`, `order_id`, `state`, `executed_quantity`, `remaining_quantity`, `side`, `order_type`, `trade_timestamp` 등. SIMPLE 축약 = `ty`, `st`, `cd`, `oid`, `s`, `eq` …
  - **state 값: `wait`/`trade`/`done`/`cancel`** — 현재 `FILLED_STATES = {done, trade}`와 동일(변경 불필요).
- **현재 코드가 이미 커버하는 부분**: 방어 파싱 `msg.order_id`(uuid), `msg.code`(market), `msg.state` → V2 DEFAULT 필드명과 일치. 즉 DEFAULT 포맷이면 파싱은 대체로 동작. 단 SIMPLE 포맷으로 올 경우 대비 + `format:'DEFAULT'` 명시로 이중 안전.

---

## 파일 구조

- Modify `src/services/private-order-ws.ts`
  - `BITHUMB_ENDPOINT` 상수 v1→v2
  - `defaultEndpoint`, `defaultBuildSubscribePayload` 를 **export**(단위 테스트 가능하도록)
  - `defaultBuildSubscribePayload` 빗썸 분기에 `{format:'DEFAULT'}` 추가
  - `handleMessage` 파싱을 V2 DEFAULT+SIMPLE 필드까지 방어적으로 확장
- Modify `__tests__/services/private-order-ws.test.ts` — v2 엔드포인트/구독 포맷/파싱 테스트 추가
- (배포) `.github/workflows/deploy.yml` 의 `REALTIME_FILL_WS_MODE` 값 — 코드 변경 아님. shadow→on 전환은 env로만.

> 범위: 빗썸 **private** WS만. `bithumb-stablecoin-ws-manager.ts`의 `pubwss.bithumb.com/pub/ws`(public)는 이번 공지(Private V1 종료) 대상이 아니므로 제외. (별도 public WS 종료 공지가 오면 그때 처리.)

---

## Task 1: 기본 엔드포인트/구독 빌더 export + 테스트 베이스

**Files:**
- Modify: `src/services/private-order-ws.ts:250-265`
- Test: `__tests__/services/private-order-ws.test.ts`

- [ ] **Step 1: 실패 테스트 작성** (`private-order-ws.test.ts`의 최상위 describe 안에 신규 describe 추가)

```typescript
import { defaultEndpoint, defaultBuildSubscribePayload } from '../../src/services/private-order-ws';

describe('V2 기본 엔드포인트/구독', () => {
  it('빗썸 기본 엔드포인트는 v2 private', () => {
    expect(defaultEndpoint('bithumb')).toBe('wss://ws-api.bithumb.com/websocket/v2/private');
  });
  it('업비트 기본 엔드포인트는 변경 없음', () => {
    expect(defaultEndpoint('upbit')).toBe('wss://api.upbit.com/websocket/v1/private');
  });
  it('빗썸 구독 페이로드에 type:myOrder + codes + format:DEFAULT 포함', () => {
    const payload = defaultBuildSubscribePayload('bithumb')(['KRW-BTC', 'KRW-ETH']) as any[];
    expect(payload).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'myOrder', codes: ['KRW-BTC', 'KRW-ETH'] }),
      expect.objectContaining({ format: 'DEFAULT' }),
    ]));
    expect(payload[0]).toHaveProperty('ticket');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest private-order-ws -t "V2 기본" -v`
Expected: FAIL — `defaultEndpoint`/`defaultBuildSubscribePayload` 미export(import 에러) + 빗썸 엔드포인트가 아직 v1.

- [ ] **Step 3: 구현** (`private-order-ws.ts` 250-265 수정)

```typescript
const UPBIT_ENDPOINT = 'wss://api.upbit.com/websocket/v1/private';
const BITHUMB_ENDPOINT = 'wss://ws-api.bithumb.com/websocket/v2/private';

export function defaultEndpoint(exchange: string): string {
  return exchange === 'bithumb' ? BITHUMB_ENDPOINT : UPBIT_ENDPOINT;
}

export function defaultBuildSubscribePayload(exchange: string) {
  return (markets: string[]) => {
    const ticket = `private-fill-${Date.now()}`;
    if (exchange === 'bithumb') {
      // V2: DEFAULT 포맷 명시(응답 필드 전체명 보장, SIMPLE 축약 방지). codes 생략/빈배열이면 전체 구독.
      return [{ ticket }, { type: 'myOrder', codes: markets }, { format: 'DEFAULT' }];
    }
    return [{ ticket }, { type: 'myOrder' }];
  };
}
```

(기존 `function defaultEndpoint`/`function defaultBuildSubscribePayload` 선언에 `export`를 붙이고 빗썸 엔드포인트/payload만 교체. 나머지 호출부는 동일 시그니처라 변경 불필요.)

- [ ] **Step 4: 통과 확인**

Run: `npx jest private-order-ws -t "V2 기본" -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/private-order-ws.ts __tests__/services/private-order-ws.test.ts
git commit -m "feat: 빗썸 private WS 기본 엔드포인트 v2 + 구독 format:DEFAULT"
```

---

## Task 2: V2 메시지 파싱 확장 (DEFAULT + SIMPLE 방어)

**Files:**
- Modify: `src/services/private-order-ws.ts:149-161` (`handleMessage` 파싱부)
- Test: `__tests__/services/private-order-ws.test.ts`

- [ ] **Step 1: 실패 테스트 작성** (기존 '메시지 파싱' describe 패턴 재사용 — mock ws로 'message' emit)

```typescript
// 기존 테스트(line ~88-115, 빗썸 trade 케이스)와 동일한 mock ws 셋업 방식 사용.
// 신규 describe:
describe('V2 myOrder 파싱 (DEFAULT/SIMPLE)', () => {
  it('V2 DEFAULT 체결(state=trade, order_id, code) → onFill emit', async () => {
    // (기존 빗썸 테스트의 conn 셋업 복사: endpoint v2, buildSubscribePayload defaultBuildSubscribePayload('bithumb'))
    // 메시지:
    const msg = { type: 'myOrder', state: 'trade', order_id: 'oid-v2-1', code: 'KRW-EGLD' };
    // → onFill 1회, info.uuid === 'oid-v2-1', info.market === 'KRW-EGLD', info.state === 'trade'
  });
  it('V2 SIMPLE 체결(ty=myOrder, s=trade, oid, cd) → onFill emit', async () => {
    const msg = { ty: 'myOrder', s: 'trade', oid: 'oid-v2-2', cd: 'KRW-BTC' };
    // → onFill 1회, info.uuid === 'oid-v2-2', info.market === 'KRW-BTC'
  });
  it('state=cancel/wait → onFill 미발생', async () => {
    // { type:'myOrder', state:'cancel', order_id:'x', code:'KRW-BTC' } → emit 0회
  });
});
```

> 구현 노트: 기존 파일 line 70/100의 테스트가 `conn['handleMessage']` 를 직접 호출하거나 mock ws의 'message' 이벤트로 Buffer를 보낸다. **그 방식 그대로** 복사해 위 msg만 바꿔 쓸 것. (테스트 셋업 중복은 허용 — 기존 패턴 일치 우선.)

- [ ] **Step 2: 실패 확인**

Run: `npx jest private-order-ws -t "V2 myOrder 파싱" -v`
Expected: SIMPLE 케이스 FAIL (현재 `msg.ty`/`msg.s`/`msg.oid`/`msg.cd` 미처리로 onFill 미발생). DEFAULT 케이스는 통과할 수도 있음(이미 order_id/code/state 커버).

- [ ] **Step 3: 구현** (`handleMessage` 149-161 교체)

```typescript
  private handleMessage(data: Buffer): void {
    try {
      const msg = JSON.parse(data.toString());
      // type: V2 DEFAULT 'type' / SIMPLE 'ty'
      const type = msg?.type ?? msg?.ty;
      if (type !== 'myOrder') return;

      // 필드명 방어적 파싱: V2 DEFAULT + SIMPLE + 레거시 후보 모두 허용
      const uuid: string | undefined = msg.uuid ?? msg.order_id ?? msg.orderId ?? msg.oid;
      const market: string | undefined = msg.market ?? msg.code ?? msg.cd ?? msg.symbol;
      const state: string | undefined = msg.state ?? msg.s ?? msg.status;

      if (!uuid || !market || !state) return;
      if (!FILLED_STATES.has(state)) return; // wait/cancel 등 비체결 무시 (V2: wait/trade/done/cancel)

      const info: FillInfo = { exchange: this.options.exchange, market, uuid, state };
      for (const listener of this.listeners) {
        try {
          listener(info);
        } catch (err: any) {
          console.error(`[PrivateOrderWs][${this.options.exchange}] onFill 리스너 오류:`, err.message);
        }
      }
    } catch (err: any) {
      console.error(`[PrivateOrderWs][${this.options.exchange}] 메시지 파싱 오류:`, err.message);
    }
  }
```

(`FILLED_STATES = new Set(['done', 'trade'])` 는 V2 state와 일치하므로 변경 없음.)

- [ ] **Step 4: 통과 확인**

Run: `npx jest private-order-ws -v`
Expected: 신규 3 + 기존 전체 PASS (기존 upbit/빗썸 v1형 메시지도 여전히 통과 — 후보 집합을 넓히기만 해서 회귀 없음).

- [ ] **Step 5: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add src/services/private-order-ws.ts __tests__/services/private-order-ws.test.ts
git commit -m "feat: 빗썸 V2 myOrder 파싱 (DEFAULT/SIMPLE 필드 방어)"
```

---

## Task 3: 임시 원시 메시지 로깅 추가 (shadow 검증용)

> 목적: shadow 배포 시 실제 V2 메시지의 필드/state를 **눈으로 확인**해 문서 가정(DEFAULT 필드명·state 값)을 경험적으로 검증. 검증 후 Task 5에서 제거한다.

**Files:**
- Modify: `src/services/private-order-ws.ts` (`handleMessage` 진입부)

- [ ] **Step 1: 임시 로그 추가** (`handleMessage`의 `JSON.parse` 직후, `type` 판정 전)

```typescript
      const msg = JSON.parse(data.toString());
      // [임시/V2검증] 빗썸 원시 메시지 1회성 관찰 — Task 5에서 제거. 과다로그 방지 위해 myOrder/ty만.
      if (this.options.exchange === 'bithumb' && (msg?.type === 'myOrder' || msg?.ty === 'myOrder')) {
        console.log('[PrivateOrderWs][bithumb][V2-RAW]', JSON.stringify(msg).slice(0, 500));
      }
```

- [ ] **Step 2: 빌드 확인**

Run: `npm run build`
Expected: 컴파일 성공(0 errors)

- [ ] **Step 3: Commit**

```bash
git add src/services/private-order-ws.ts
git commit -m "chore: 빗썸 V2 원시 메시지 임시 로깅 (shadow 검증용)"
```

---

## Task 4: shadow 배포 + 실제 V2 메시지 검증

> 코드 머지 후, **배포 env를 shadow로** 두고 실제 빗썸 V2 메시지를 받아 파싱을 검증한다. shadow는 수신·로그만 하고 실제 반대주문 트리거를 하지 않으므로 무위험(그 사이 30초 폴링이 실시간 공백을 메움).

**Files:**
- Modify: `.github/workflows/deploy.yml` — `REALTIME_FILL_WS_MODE` 를 `on`→`shadow`로 (1줄)

- [ ] **Step 1: PR 머지 + 배포** (Task 1-3 브랜치)

재고 프로젝트 자동 머지 정책에 따라 PR 생성→머지→배포. 배포 전 RDS 스냅샷 불필요(코드/스키마 무변경).

- [ ] **Step 2: deploy.yml mode를 shadow로 변경 후 재배포**

`REALTIME_FILL_WS_MODE=on` → `REALTIME_FILL_WS_MODE=shadow` 로 바꿔 커밋·배포. (또는 서버에서 임시로 `docker run -e REALTIME_FILL_WS_MODE=shadow` 재기동 — CI 경유 권장.)

- [ ] **Step 3: 실제 V2 메시지 수신 확인** (빗썸에서 소액 체결 1건 유발 or 기존 그리드 봇 체결 대기)

Run(서버): `ssh … 'docker logs --since 10m grid-bot 2>&1 | grep -E "V2-RAW|myOrder 구독|onFill" | tail -20'`
Expected:
- `myOrder 구독 시작` 로그 (v2 연결 성공)
- 체결 발생 시 `[V2-RAW]` 로 실제 메시지 1건 — **아래 체크리스트로 검증**:
  - [ ] `type`(또는 `ty`) === `'myOrder'`
  - [ ] 식별자 필드가 `order_id`(또는 `oid`)로 존재
  - [ ] 마켓 필드가 `code`(또는 `cd`)로 존재
  - [ ] 체결 state가 `trade` 또는 `done`
  - [ ] shadow 디스패치 로그(체결 감지됨, 트리거는 안 함)가 뜸

- [ ] **Step 4: 불일치 시 파싱 보정**

만약 실제 필드명/ state가 문서와 다르면(예: `order_id`가 아니라 다른 이름, state가 다른 값) → Task 2의 후보 집합/`FILLED_STATES`를 실제값에 맞춰 추가하고 재배포 후 Step 3 재검증. (일치하면 생략.)

---

## Task 5: on 전환 + 이중감지 안전 확인 + 임시 로그 제거

**Files:**
- Modify: `.github/workflows/deploy.yml` (`REALTIME_FILL_WS_MODE` shadow→on)
- Modify: `src/services/private-order-ws.ts` (임시 V2-RAW 로그 제거)

- [ ] **Step 1: 임시 로그 제거** (Task 3에서 추가한 `[V2-RAW]` 블록 삭제)

- [ ] **Step 2: 테스트/빌드 확인**

Run: `npx jest private-order-ws && npx tsc --noEmit`
Expected: 전체 PASS, 0 errors

- [ ] **Step 3: mode on 복귀 + 배포**

`REALTIME_FILL_WS_MODE=shadow` → `on` 으로 변경 커밋·배포.

- [ ] **Step 4: production 검증**

Run(서버): `ssh … 'docker logs --since 10m grid-bot 2>&1 | grep -E "myOrder 구독|실시간 체결 WS 초기화" | tail'`
Expected: `실시간 체결 WS 초기화 완료 (mode=on …)` + `myOrder 구독 시작`.
체결 1건 발생 시: 실시간 트리거 동작 + **이중 주문 0건**(기존 원자 가드 `processFilledOrder`의 `updateMany where status=pending`가 WS/폴링 중복을 방지 — 메모리 `project_realtime_fill_ws_2026_09_25` 참조). 최근 거래에서 같은 주문이 2번 처리되지 않았는지 확인.

- [ ] **Step 5: Commit**

```bash
git add src/services/private-order-ws.ts .github/workflows/deploy.yml
git commit -m "chore: 빗썸 WS V2 on 전환 + 임시 로그 제거"
```

---

## 롤백 전략

- **즉시 롤백**: `REALTIME_FILL_WS_MODE=off`(또는 `shadow`)로 env 변경·재배포 → 실시간 트리거 중단, 30초 폴링이 체결을 커버(자금 영향 0). 전환 기간(현재~10-30)에는 v1도 아직 살아있으나, 코드가 v2로 바뀌었으므로 롤백은 "엔드포인트 되돌리기"가 아니라 "모드 off"로 한다.
- **엔드포인트 되돌리기(최후수단)**: `BITHUMB_ENDPOINT`를 v1으로 되돌려 재배포(10-30 이전에만 유효).

## 타임라인/긴급도

- 마감: **2026-10-30**. 현재 production `on`이라 미전환 시 그날 실시간 감지가 폴링 폴백으로 저하(자금 손실은 없음).
- V2는 2026-06-30부터 가동 중이라 **지금 바로 전환 가능**(전환 기간엔 v1/v2 병존). 여유 있게 10월 중순 전 완료 권장.

---

## Self-Review 메모 (작성자 체크)

- **스펙 커버리지**: 엔드포인트(T1)·구독 format(T1)·파싱 DEFAULT/SIMPLE(T2)·경험적 검증(T3·T4)·on 전환+이중감지 안전(T5)·롤백 모두 태스크 존재. 인증(JWT)·state 값은 V1과 동일해 변경 태스크 불필요(배경에 근거 명시).
- **플레이스홀더 점검**: 코드 스텝은 실제 코드 포함. 단 Task 2 테스트는 "기존 mock ws 셋업 복사" 지시 — 기존 파일(line 88-115)의 구체 패턴을 그대로 재사용하라는 의미로, 구현자가 파일에서 직접 확인 가능(플레이스홀더 아님, 중복 회피 지시).
- **타입 일관성**: `defaultEndpoint`/`defaultBuildSubscribePayload` export명, `FillInfo{exchange,market,uuid,state}`, `FILLED_STATES` 전 태스크 일치.
- **미확인 리스크(경험적 검증으로 해소)**: V2 실제 필드명/ state 값이 문서와 미세하게 다를 가능성 → Task 4 Step 3 체크리스트 + Step 4 보정으로 흡수. 이게 shadow 단계를 둔 이유.
