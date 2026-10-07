# MEXC USDT 현물 그리드 매매 — 설계 (MVP)

> 작성 2026-10-07. 동기: 2027-01-01 한국 코인 과세 대비 해외 거래소(MEXC) 그리드 거래 능력 사전 구축. 관리자 전용.

## 목표 (Goal)

기존 그리드 엔진을 재사용해 **MEXC 현물 USDT 페어(BTCUSDT 등 메이저 코인)에서 그리드 매매**가 가능하도록 한다. MVP 범위: BTC/메이저 소수 코인, 핵심 주문·체결·손익, canary 검증 가능. 선물·전체기능 패리티·KRW 이전은 범위 밖(후속).

## 확정 결정 (브레인스토밍)

- **범위**: MVP — BTC/메이저 소수부터. 나머지는 2027 전까지 점진 확장.
- **시장**: 현물(Spot)만. 선물 제외.
- **손익 통화**: USDT 그대로 기록·표시. KRW 봇 합계와 **분리**(환산 안 함).
- **통합 방식**: 접근 A — 신규 `MexcGridClient`(`GridTradeClient` 구현) + MEXC 가격매니저 + `trading.service` 거래소 분기 **가산**. 기존 upbit/bithumb 경로·357 라이브 KRW 봇 불변.
- **체결 감지**: REST 폴링(기존 그리드 패턴). 실시간 WS는 후속.
- **운영**: 기본 OFF(status=stopped) + 관리자 수동 시작 + 소액 canary.

## 현재 상태 (조사 결과)

- 그리드 실행 엔진(`trading.service.ts`)은 `exchange==='bithumb' ? BithumbClient : UpbitService` 2분기만. MEXC/binance 미지원(`binance:BTCUSDT` 봇 #1은 생성됐으나 0거래·stopped).
- 그리드 규격 인터페이스 `GridTradeClient`: `buyLimit(market,price,volume)` / `sellLimit(...)` / `cancelOrder(uuid)` / `getFilledOrders(market?,limit?)`.
- MEXC 인프라 **재사용 가능**: `exchange-signer`(MEXC/hmacSign/mexcPost/signedGet), `MexcLeg`의 `exchangeInfo`(가격·수량 정밀도), `/api/v3/account`(잔고), `/api/v3/order`(주문조회), 지정가 주문 경험(buyLimitIoc).
- **없어서 신규 구현**: GTC 지정가(현 MexcLeg는 IOC만, `buyGtc`는 throw 스텁), `getFilledOrders` 폴링, `cancelOrder`, MEXC 현재가 피드.
- 데이터 모델: `Bot`(exchange enum에 mexc 존재, ticker/orderAmount/investmentAmount/currentProfit)·`Trade`(price/amount/total/profit/exchange/ticker)의 금액·손익 필드가 **통화-불문 Float** → 스키마 변경 없이 USDT 기록 가능.
- 관리자(user #2, ok4192@hanmail.net)에 **mexc credential 이미 등록됨**.

## 아키텍처 (접근 A)

```
[그리드 두뇌: bot-engine / trading.service — 불변]
        │  exchange 로 어댑터·가격·수수료 선택 (분기 가산)
        ├─ upbit   → UpbitService        + priceManager            (기존)
        ├─ bithumb → BithumbClient        + bithumbPriceManager     (기존)
        └─ mexc    → MexcGridClient  ★    + mexcGridPriceManager ★  (신규)
                        └ GridTradeClient 규격 구현 (buyLimit/sellLimit/cancelOrder/getFilledOrders)
                        └ exchange-signer·exchangeInfo 재사용
```

## 컴포넌트 (단위·책임·의존)

### ① `MexcGridClient` — `src/services/exchange/mexc-grid-client.ts` (백엔드)
- **책임**: MEXC 현물 주문 I/O를 `GridTradeClient` 규격으로 제공.
- **메서드**:
  - `buyLimit(market, price, volume)` → `POST /api/v3/order` (side=BUY, type=LIMIT, timeInForce=GTC). 반환: `{ orderId }` 형태(기존 엔진이 기대하는 필드에 매핑).
  - `sellLimit(market, price, volume)` → 동일(side=SELL).
  - `cancelOrder(orderId)` → `DELETE /api/v3/order`.
  - `getFilledOrders(market?, limit?)` → `GET /api/v3/allOrders`(status=FILLED 필터) 또는 `/api/v3/myTrades`. 기존 upbit `getFilledOrders` 반환 형태에 맞춰 정규화.
- **정밀도/제약**: `exchangeInfo`에서 PRICE_FILTER(tickSize)·LOT_SIZE(stepSize)·MIN_NOTIONAL 조회 후 price/qty 절사, 최소주문금액 미만 거부.
- **심볼 포맷**: 내부 ticker `BTCUSDT`(대시 없음). 엔진이 넘기는 market 문자열을 MEXC 포맷으로 변환하는 매핑 1곳.
- **의존**: `exchange-signer`, `axios`, credential(apiKey/secretKey).

### ② `mexcGridPriceManager` — `src/services/mexc-grid-price-manager.ts` (백엔드)
- **책임**: MEXC 현재가 제공. MVP는 `GET /api/v3/ticker/price?symbol=…` REST 폴링 + 짧은 캐시(≈1~2초). `bithumb-grid-price-manager` 패턴 준용.
- **인터페이스**: `getPriceWithFallback(ticker): Promise<number>`.

### ③ `trading.service.ts` 분기 (백엔드, 가산 수정)
- 클라이언트 생성 지점(≈3곳): `exchange==='mexc'`일 때 `new MexcGridClient(cred)`.
- 현재가 지점(≈2곳): `exchange==='mexc'`일 때 `mexcGridPriceManager`.
- 체결 폴링 루프: mexc는 `getFilledOrders(market)`로 열린 그리드 주문 체결 확인(upbit 경로 재사용 형태).
- `getFeeRate`: mexc 추가 → `env MEXC_SPOT_FEE_BPS`(기본 5 = 0.05%).
- **불변식**: upbit/bithumb 분기·반환형태·기존 테스트 변경 없음(가산만).

### ④ 데이터·손익 (스키마 변경 無)
- MEXC 봇: `exchange='mexc'`, `ticker='BTCUSDT'`, 금액·손익 USDT.
- 집계·표시: `isUsdtQuote(exchange)` 헬퍼로 KRW와 분리. 대시보드/총수익에서 mexc(USDT) 봇은 별도 섹션·"USDT" 단위.

### ⑤ 안전장치 · canary (백엔드)
- 생성 기본 `status=stopped`(관리자 수동 start).
- start 전 pre-flight: MEXC credential 유효성 + USDT 가용잔고 ≥ investmentAmount 확인.
- 그리드당 MIN_NOTIONAL 가드, REST 레이트리밋 스로틀(주문·폴링 가중치).
- 기존 안전로직 재사용: stopAtMax, 잔고부족 시 매수주문 정리.
- 첫 봇: BTC 소액(20~50 USDT) 관찰.

### ⑥ UI (프론트, 별도 플랜/서브에이전트)
- `/grid` 생성 폼: 거래소 선택에 **MEXC 추가(관리자 전용 게이트)**. 선택 시 ticker=USDT페어, 금액·가격 단위 USDT.
- 목록/상세: mexc 봇은 USDT 단위 표기.
- `lib/api.ts`: 기존 그리드 생성 API 재사용(exchange='mexc', ticker='BTCUSDT'). 신규 엔드포인트 불필요 추정(확인).

## 데이터 흐름

1. 관리자가 MEXC BTCUSDT 그리드 봇 생성(stopped) → 수동 start.
2. 엔진이 가격범위·gridCount로 매수/매도 지정가(GTC)를 MexcGridClient로 발주.
3. 폴링 루프가 `getFilledOrders`로 체결 감지 → 체결된 레벨의 반대편 주문 재배치(기존 로직).
4. 체결마다 Trade(USDT) 기록, Bot.currentProfit(USDT) 갱신.
5. 대시보드는 mexc 봇을 USDT 섹션에 분리 표시.

## 에러 처리

- MEXC API 오류 분류: 정밀도/LOT/minNotional 거부, 잔고부족, 레이트리밋(429/418), 서명·IP 오류.
- 주문 단위 try/catch·로깅. 일시 오류는 다음 사이클 재시도, 반복 실패(예: 연속 N회)면 봇 `error` 상태 + 메시지. 기존 그리드 에러 패턴 준수.
- 한쪽 주문만 나가는 상황 없음(그리드는 독립 지정가라 아비의 한쪽체결 리스크와 다름).

## 테스트 (TDD, 80%+)

- **Unit**: MexcGridClient 주문 파라미터(tickSize/stepSize 반올림, minNotional 거부), `getFilledOrders` 파싱 정규화 — MEXC 응답 목.
- **Unit**: mexcGridPriceManager 파싱·폴백.
- **Unit**: USDT 손익·수수료 계산, `isUsdtQuote` 분리 로직.
- **Integration**: trading.service가 exchange='mexc'에서 MexcGridClient를 해석(목).
- **회귀**: 기존 trading.service/grid 테스트 그대로 통과(가산 변경).
- **Manual canary**: 실거래 BTC 소액 그리드로 발주→체결→재배치→USDT 손익 기록 end-to-end 확인.

## 범위 밖 (YAGNI / 후속)

- 선물(futures), 레버리지.
- 실시간 체결 WS(MEXC private stream).
- 전체 KRW 그리드 기능 패리티(코인중립 모드 등은 USDT에서 추후).
- KRW 이전/병행 운영, 환산 표시.
- 다수 코인 대량 생성(MVP는 소수 수동).

## 구현 분리

- **백엔드**: ①~⑤ (어댑터·가격매니저·엔진분기·데이터·안전).
- **프론트**: ⑥ (폼·표시).
- 글로벌 규칙대로 백/프론트 각각 별도 서브에이전트로 병렬 진행.
