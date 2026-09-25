# 실시간 체결 WebSocket (private myOrder) — 설계 spec

> 작성 2026-09-25. 목적: 그리드 봇의 체결 감지 지연(현행 최대 ~36초, 30초 폴링 안전망 의존)을 실시간 private WebSocket으로 제거.

## 배경 / 문제
- 현행 체결 감지 2경로 (둘 다 `processFilledOrder()` → `executeOppositeOrder()`로 수렴):
  - (a) 가격 크로스 감지: 업비트 공개 WS(`wss://api.upbit.com/websocket/v1`) 기반. 빗썸은 REST 폴링(5초)이라 크로스 감지 사실상 없음.
  - (b) 30초 폴링 안전망: `checkFilledOrders()` — REST로 done/filled 조회.
- 실측(2026-09-24): 반대주문 86건 중 6건이 1.4~36.4초. 느린 건 전부 **업비트 봇**이며, 원인은 "실제 체결 → 감지" 지연(주문 API 자체는 ~0.5초). 즉 가격 크로스가 급변 시 놓치면 30초 폴백이 뒤늦게 잡음.
- EGLD(빗썸)는 실측상 빠르게(<2초) 나왔으나, 빗썸은 크로스 감지가 약해 폴링 의존도가 높음 → 실시간 WS로 근본 개선.

## 목표 / 성공 기준
- 업비트·빗썸 그리드 봇의 체결 감지 지연을 **실시간(<1초)**로.
- 30초 폴링 안전망은 **영구 유지**(WS 끊김/누락 대비 belt-and-suspenders).
- 실거래 자금 영향 0의 **shadow 단계**를 거쳐 단계적 활성화.

## 범위
- ✅ 업비트 private `myOrder` WS
- ✅ 빗썸 private `myOrder` WS (2.0 키, `wss://ws-api.bithumb.com/websocket/v1/private`)
- ✅ 30초 폴링 유지, 기존 반대주문 진입점(`checkAndProcessSingleOrder`) 재사용
- ❌ 다른 거래소(coinone/mexc/gate 등) — 대상 아님

## 외부 API (검증됨)
| | 업비트 | 빗썸 |
|---|---|---|
| 엔드포인트 | `wss://api.upbit.com/websocket/v1/private` | `wss://ws-api.bithumb.com/websocket/v1/private` |
| 인증 | JWT(access_key, nonce) Bearer 헤더 | JWT(access_key, nonce, timestamp) Bearer 헤더, **API 2.0 키 전용** |
| 구독 | `[{"ticket":"..."},{"type":"myOrder"}]` | `[{"ticket":"..."},{"type":"myOrder","codes":["KRW-EGLD",...]}]` |
| 연결 제한 | — | 10 conn/s/IP (연결 후 데이터는 무제한) |
| 체결 메시지 | `type=myOrder`, `state=done`/부분체결 `trade`, `uuid`, `market` 포함 | 동일 계열(`type=myOrder`) |

JWT 서명은 기존 코드 재사용: 업비트 `upbit.service.ts`(HS256, access_key+nonce+query_hash), 빗썸 `bithumb-client.ts:generateBithumbJwt`(+timestamp). WS 핸드셰이크는 query 없음 → query_hash 생략한 JWT.

## 설계

### 신규 모듈 `src/services/private-order-ws.ts`
거래소 무관 공용. credential별 연결 1개 풀.

```
PrivateOrderWsPool
  key = `${exchange}:${credentialId}`   // 같은 키 재사용 → 연결 공유
  getOrCreate(exchange, userId, credentialId, apiKey, secretKey, markets[]): conn (ref-count++)
  release(key): ref-count--; 0이면 idle 타이머 후 close
  onFill(cb: (info:{exchange, market, uuid, state}) => void)
  getStats(): { connections, byExchange }

PrivateOrderWsConnection
  connect(): JWT 생성 → WS(headers Authorization: Bearer) → 구독 메시지 전송
  onmessage: myOrder 파싱 → 체결(state done/trade)만 onFill emit
  ping/pong keepalive, 지수 백오프 재연결(최대 N회), 재연결 시 fresh JWT
```

- 파싱: 메시지에서 `uuid`(=주문 orderId), `market`, `state` 추출. 부분체결/완전체결 모두 감지 대상(기존 폴링과 동일 기준).
- 거래소 차이는 주입: 엔드포인트, JWT 서명 함수, 구독 페이로드(빗썸은 codes 필요).

### 통합 `bot-engine.service.ts`
- start()/구독 시: 실행 중 봇을 (exchange, credentialId)로 그룹 → 각 그룹에 대해 `pool.getOrCreate(...)`, 봇 티커를 codes로.
- `pool.onFill(info => this.onPrivateOrderFill(info))` 등록.
- `onPrivateOrderFill`: `info.uuid`로 `gridLevel.findFirst({ where:{ orderId: uuid } })` → gridId → **기존 `TradingService.checkAndProcessSingleOrder(gridId)` 호출** (fire-and-forget, 기존 크로스 감지와 동일). 중복은 기존 원자 pending→filled 가드가 차단.
- stop(): 모든 연결 release/close.
- 봇 추가/제거 시 codes 갱신(재구독) — 초기엔 봇 목록 변경 시 재연결로 단순화 가능.

### 중복/정합
- 실시간 WS + 30초 폴링 + 가격 크로스가 동시에 같은 체결을 처리할 수 있음 → 이미 `processFilledOrder`의 atomic `updateMany(status pending→filled)` 가드로 1건만 진행(검증 필요).

## 단계적 배포 (실거래 안전)
- env 플래그 `REALTIME_FILL_WS_MODE` = `off` | `shadow` | `on` (기본 `off`)
  - **off**: 연결 안 함(현행과 동일).
  - **shadow**: WS 연결·체결 수신 후 **로그만** 남김(`[RealtimeFill][shadow] exchange market uuid Δ감지지연`). 실제 반대주문은 기존 경로. → 안정성/커버리지 검증.
  - **on**: 수신 체결로 `checkAndProcessSingleOrder` 트리거(실동작). 30초 폴링 유지.
- 롤아웃: 배포(off) → shadow 관찰(수 시간, 수신율/지연) → on 전환 → 지연 분포 재측정(30초 꼬리 소멸 확인).

## 테스트 (TDD)
`__tests__/services/private-order-ws.test.ts` (기존 `bithumb-stablecoin-ws-manager.test.ts`의 ws mock/EventEmitter 패턴):
1. myOrder 체결 메시지 → onFill 1회 emit (uuid/market/state 파싱).
2. 비체결(wait/watch) 메시지 → emit 안 함.
3. 풀 ref-count: 같은 credential 2봇 → 연결 1개, 1봇 종료해도 유지, 0되면 close.
4. 재연결 시 fresh JWT 생성.
5. 통합: onFill → checkAndProcessSingleOrder(gridId) 1회 (mock), 미존재 uuid는 무시.
6. shadow 모드: 로그만, 트리거 안 함.

## 리스크 / 완화
- 멀티 credential 연결 수: 풀+ref-count+idle 종료. 빗썸 10 conn/s 제한 → 연결 간 소폭 throttle.
- JWT 만료(장수명 WS): 재연결 시 fresh JWT. 필요 시 주기적 재연결.
- 빗썸 2.0 키 아님: myOrder 구독 실패 가능 → 실패 시 로그+폴링 폴백(연결 실패해도 기존 경로로 정상 동작).
- 중복 주문: 기존 atomic 가드(검증 포함).

## 완료 정의
- 신규 테스트 그린 + `tsc` 클린.
- shadow 로그로 업비트·빗썸 체결 실시간 수신 확인.
- on 전환 후 반대주문 지연 분포에서 3초 초과 꼬리 소멸(폴링 안전망은 유지).
