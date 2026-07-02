# 한국주식 그리드 매매 (토스증권 OpenAPI) — 설계 문서

> 날짜: 2026-06-29
> 대상: 일반 가입자 (관리자 아님)
> 거래소 연동: 토스증권 Open API (REST, OAuth 2.0)

---

## 1. 개요

토스증권 Open API와 연동하여 한국주식(코스피/코스닥) 종목에 그리드 매매를 적용하는 새 페이지 `/korean-stocks` 추가. 기존 코인 그리드(`/grid`)와 동일한 그리드 매매 알고리즘을 재사용하되, 한국주식 시장의 특수성(장 운영 시간, 거래세, 호가 단위, 상하한가)을 처리한다.

일반 가입자(관리자 아님) 대상이라 종목 자동완성, 거래세 시뮬레이션, 설정 마법사 등 onboarding 친화적 UX를 제공한다.

---

## 2. 목표 / 비목표

### 목표
- 사용자가 본인 토스증권 OpenAPI 클라이언트 키를 등록하면 한국주식 그리드 봇 운영 가능
- 코인 그리드 매매 알고리즘 재사용 (Bot/GridLevel/Trade 모델 공유 + `market` enum 분기)
- 장 운영 시간(평일 09:00~15:30 KST)만 봇 동작, 장 마감 시 미체결 주문 자동 취소
- 거래세(매도 0.18%) + 토스증권 수수료를 자동 계산하여 그리드 설정 시 실수익 시뮬레이션
- 종목명 자동완성 (예: "삼성" → 005930 삼성전자)
- 일반 사용자가 실수해서 손실 보는 케이스 방지 (호가 단위/상하한가 검증, 그리드 spread 최소값 경고)

### 비목표
- 미국주식 통합 (기존 `/us-stocks` KIS 그대로 유지)
- 시간외 단일가/장후 단일가 거래 (정규장만)
- 신용/대출 거래 (현금 매수만)
- 토스증권 OpenAPI에 없는 기능 (예: 호가창 시각화 — 제공 시 검토)
- 차트 통합, 다중 봇 비교 (전문가용 기능, 추후 별도 task)

---

## 3. 기존 자산 (재사용)

### 코인 그리드 (재사용 대상)
- `src/services/grid.service.ts` (303줄) — 그리드 가격 계산
- `src/services/bot-engine.service.ts` (621줄) — 봇 사이클 엔진
- `src/agents/grid-agent.ts` (35줄) — 코인 그리드 에이전트
- Prisma `Bot` / `GridLevel` / `Trade` 모델

### 기존 KIS 한국주식 (참조만, 변경 없음)
- `src/services/kis.service.ts` (1046줄), `src/controllers/kis.controller.ts` (531줄)
- 페이지 `app/us-stocks/page.tsx`
- 토스 service 작성 시 KIS 패턴 참조 (OAuth 토큰 관리, polling, 에러 처리)

### 사용자/구독
- `User` 모델 (id, email, ...)
- `Subscription` 모델 — 모든 plan grid 무제한이라 한국주식 그리드도 plan 제한 없음

---

## 4. 토스증권 Open API 사양 (2026-07-01 공식 문서로 확정)

> 출처: `https://developers.tossinvest.com/docs`, canonical spec `https://openapi.tossinvest.com/openapi-docs/latest/openapi.json` (OpenAPI 3.1.0, 20 endpoint). 로컬 캐시본: `docs/toss-openapi/openapi.json`.

### Base URL
- `https://openapi.tossinvest.com` (단일 서버)
- **Sandbox / staging 환경 없음** — 개발/테스트도 실계좌 대상. Canary 절차는 § 18 참조.

### 인증
- **OAuth 2.0 Client Credentials Grant**
- 사용자가 토스증권 WTS(웹) → 설정 → Open API 메뉴에서 `client_id` + `client_secret` 발급
- 우리 백엔드는 사용자 키로 `POST /oauth2/token` 호출 → `access_token` 발급
- 모든 API 호출: `Authorization: Bearer {access_token}` 헤더
- **계좌·자산·주문** 카테고리 요청은 추가로 `X-Tossinvest-Account: {accountSeq}` 헤더 필수 (spec 상 int64 정수)

### Endpoint 카탈로그 (우리가 사용할 12개)

| 그룹 | Method | Path | 헤더 | 용도 |
|---|---|---|---|---|
| Auth | POST | `/oauth2/token` | — | access token 발급 (form-urlencoded body) |
| Market Data | GET | `/api/v1/prices` | Bearer | 현재가 조회 (`symbols` CSV) |
| Market Data | GET | `/api/v1/price-limits` | Bearer | 상/하한가 조회 (`symbol`) |
| Stock Info | GET | `/api/v1/stocks` | Bearer | 종목 기본 정보 (`symbols` CSV) — **전체 dump 아님** |
| Market Info | GET | `/api/v1/market-calendar/KR` | Bearer | 오늘/전영업일/차영업일 장 운영 정보 (`date` optional) |
| Account | GET | `/api/v1/accounts` | Bearer | 계좌 목록 (accountSeq 획득 경로) |
| Asset | GET | `/api/v1/holdings` | Bearer + Account | 보유 주식 + 손익 |
| Order Info | GET | `/api/v1/buying-power` | Bearer + Account | KRW/USD 매수 가능 금액 (`currency`) |
| Order Info | GET | `/api/v1/sellable-quantity` | Bearer + Account | 판매 가능 수량 (`symbol`) |
| Order Info | GET | `/api/v1/commissions` | Bearer + Account | 매매 수수료 |
| Order | POST | `/api/v1/orders` | Bearer + Account | 주문 생성 (LIMIT/MARKET, quantity/orderAmount 두 스타일) |
| Order | POST | `/api/v1/orders/{orderId}/cancel` | Bearer + Account | 주문 취소 (body `{}`) |

> 참조 endpoint (본 스코프 외, 후속 task 참고): `/api/v1/orderbook`, `/trades`, `/candles`, `/stocks/{symbol}/warnings`, `/exchange-rate`, `/market-calendar/US`, `POST /orders/{orderId}/modify`, `GET /orders`, `GET /orders/{orderId}`.

### 응답 envelope (모든 성공 응답 공통)
```json
{ "result": <payload> }
```
- 우리 서비스 레이어는 반드시 `res.data.result`를 unwrap 후 반환.

### 에러 envelope (모든 실패 응답 공통)
```json
{ "error": {
    "requestId": "01HXYZABCDEFG123456789",
    "code": "invalid-request",
    "message": "주문 방향이 올바르지 않습니다.",
    "data": { "field": "side", "allowedValues": ["BUY", "SELL"] }
} }
```
- `requestId`는 응답 헤더 `X-Request-Id`와 동일. 누락 시 `x-amz-cf-id` 대체.
- `code`는 정형 문자열 (§ 14의 표 참조).
- `data`는 hint (엔드포인트별 구조 다름).

### 숫자 표기 (중요)
- `quantity`, `price`, `orderAmount`, `lastPrice`, `krw`, `usd`, `rate` 등 **금액/수량 필드는 전부 JSON string** (spec `type: string, format: decimal`)
- JS number로 파싱하지 말고 문자열로 전달·저장 → precision 손실 방지 (예: 소수점 수량, US 주식 소수점 주문)
- DB 저장 시 우리 컬럼(`Bot.orderAmount: Float`, `GridLevel.price: Float`)과의 변환은 서비스 레이어에서 명시적으로 (String → Number, Number → String)

### 주문 생성 body 스타일 (POST /api/v1/orders)
oneOf 두 스타일:

**A. quantity 주문 (LIMIT/MARKET)**
```json
{
  "clientOrderId": "<uuid>",
  "symbol": "005930",
  "side": "BUY" | "SELL",
  "orderType": "LIMIT" | "MARKET",
  "timeInForce": "DAY" | "CLS",     // optional
  "quantity": "10",                  // string(decimal)
  "price": "70100",                  // string(decimal), LIMIT 시 필수
  "confirmHighValueOrder": true      // 주문 금액 ≥ 1억원일 때 true 필수
}
```

**B. orderAmount 주문 (금액 지정 MARKET)**
```json
{
  "clientOrderId": "<uuid>",
  "symbol": "005930",
  "side": "BUY",
  "orderType": "MARKET",
  "orderAmount": "100000",           // string(decimal)
  "confirmHighValueOrder": true
}
```
> 우리 그리드 봇은 A스타일 LIMIT만 사용 (호가 단위 보정된 지정가).

### idempotency (clientOrderId)
- 매 주문 생성 시 UUID v4 생성 후 body에 실어 전송.
- 동일 `clientOrderId` 재전송 시 서버가 409 `request-in-progress` 반환 → 우리 로직: **성공으로 간주하고 이전 응답의 orderId 조회 재시도** (재발행 금지).
- 그리드 봇은 network timeout으로 인한 재시도 상황에서 duplicate order 방지를 위해 필수.

### Rate limits (초당 요청)
| Group | 기본 | 특이시간 |
|---|---|---|
| AUTH | 5 tps | — |
| ACCOUNT | 1 tps | — |
| ASSET | 5 tps | — |
| STOCK | 5 tps | — |
| MARKET_INFO | 3 tps | — |
| MARKET_DATA | 10 tps | — |
| MARKET_DATA_CHART | 5 tps | — |
| ORDER | 6 tps | **09:00–09:10 KST 3 tps** |
| ORDER_HISTORY | 5 tps | — |
| ORDER_INFO | 6 tps | **09:00–09:10 KST 3 tps** |

응답 헤더로 현황 확인:
- `X-RateLimit-Limit` — 현재 허용 TPS
- `X-RateLimit-Remaining` — 남은 토큰 (429 시 0)
- `X-RateLimit-Reset` — 재충전까지 초
- `Retry-After` — 재시도 권장 초 (429 응답에만)

**429 대응 정책**: `Retry-After` 만큼 대기 → 지수 backoff (1s → 2s → 4s) + jitter (±20%). 최대 3회. `X-RateLimit-Remaining` ≤ 1일 때 사전 대기 300ms.

### 필요한 사용자 입력 (credentials 저장)
| 필드 | 출처 | 우리 DB 저장 |
|---|---|---|
| `client_id` | 토스증권 WTS Open API 메뉴 | AES-256-GCM 암호화 (`Credential.apiKey`) |
| `client_secret` | 동일 | 암호화 (`Credential.secretKey`) |
| `accountSeq` | `GET /api/v1/accounts` 응답의 `accountSeq` | 평문 (`Credential.accountSeq VARCHAR(191)`) — 서비스 레이어에서 zod `numeric-only` enforce (int64 값) |

> UX: credential 등록 화면에서 client_id/secret 입력 후 "계좌 목록 불러오기" 버튼 → `/api/v1/accounts` 호출 → dropdown 선택 → 저장. 직접 입력 대신 목록 선택으로 오타/실수 방지.

### 통신 방식
- **REST API only** (WebSocket 없음) → 시세는 polling. 봇 cycle 주기 조정 시 위 rate limit 표를 참고.

---

## 5. 데이터 모델 변경

### 5.1 Prisma `Bot` 모델
- 신규 enum `Market { CRYPTO, KOREAN_STOCK }` 추가
- `Bot.market: Market @default(CRYPTO)` 컬럼 추가 (기존 row 자동 백필 = CRYPTO)
- `Exchange` enum에 `toss` 추가 (코인거래소들과 같은 enum 공유)

### 5.2 Credential
기존 `Credential` 테이블에 `purpose='toss'` row로 저장. `apiKey` 컬럼에 `clientId`, `secretKey` 컬럼에 `clientSecret` 저장 (KIS 패턴 그대로). `Credential` 모델에 신규 컬럼 `accountSeq String?` 추가 — 토스 계좌 시퀀스(평문, 시크릿 아님).

### 5.3 신규 모델 — `KoreanStockSymbol`
종목 검색 자동완성 캐싱용. **일괄 sync 없음** — § 10의 seed + lazy resolve.
```prisma
model KoreanStockSymbol {
  code      String   @id @db.VarChar(10)  // "005930"
  name      String                          // "삼성전자"
  market    String                          // "KOSPI" / "KOSDAQ" — spec § 4의 stocks.market enum과 정합
  sector    String?
  status    String?  // "ACTIVE" / "SCHEDULED" / "DELISTED" — lazy resolve 시 stocks.status 반영
  updatedAt DateTime @updatedAt
  @@index([name])
  @@map("korean_stock_symbols")
}
```
- 자동완성은 `WHERE name LIKE '<query>%' OR code LIKE '<query>%' LIMIT 20`
- Seed 200종목 + lazy resolve로 채워짐. spec § 10 참조.

### 5.3.1 `GridLevel.clientOrderId` 컬럼 추가
- 기존 `GridLevel` 모델에 `clientOrderId String? @db.VarChar(64)` 추가 (전역 unique 아님 — 우리가 UUID 발행하므로 충돌 X, 인덱스는 굳이 X)
- 목적: 주문 실패 후 재시도 시 동일 clientOrderId로 idempotent 재발행 (§ 13 참조)
- 마이그레이션: `add_grid_level_client_order_id`

### 5.4 신규 모델 — `KoreanMarketCalendar` (휴장일 시드 소스)
```prisma
model KoreanMarketCalendar {
  date       DateTime @id @db.Date
  isOpen     Boolean
  reason     String?  // "신정", "임시휴장" 등
  @@map("korean_market_calendar")
}
```
- 우리 자체 시드가 source-of-truth (2026 휴장일 16건 dev 적용됨).
- 토스 `GET /api/v1/market-calendar/KR?date=`은 today/previousBusinessDay/nextBusinessDay 3개만 반환하므로 연도 단위 dump 불가.
- 봇 cycle 시작 시 우선 우리 DB 조회 → miss 시 (혹은 daily 첫 cycle에) 토스 endpoint 호출해서 today 확정 (특별 휴장 반영). 결과는 우리 DB에 upsert.

### 5.5 마이그레이션
- `add_market_enum_and_toss_exchange` — Bot.market + Exchange.toss + 신규 2 테이블
- 기존 Bot row 모두 `market='CRYPTO'`로 자동 백필 (DEFAULT 활용)

---

## 6. 데이터 흐름

```
[사용자]
   ↓ (1) 토스 client_id/secret/accountSeq 등록
[/korean-stocks/settings] → credential.controller → AES 암호화 → DB

[사용자]
   ↓ (2) 그리드 봇 등록 (마법사 4 step)
[/korean-stocks] → 봇 등록 → Bot row (market='KOREAN_STOCK', exchange='toss')

[KoreanStockGridAgent (5초 cycle)]
   ↓ (3) 장 시간 체크 → KoreanMarketCalendar
   ↓ (4) 운영 중인 봇 조회 (status='running', market='KOREAN_STOCK')
   ↓ (5) 각 봇: 토스 시세 polling → grid level 매수/매도 조건 평가 → 주문
[TossService] → POST /oauth2/token (cache) → GET /시세 → POST /주문

[장 마감 (15:30)]
   ↓ (6) 모든 한국주식 봇 미체결 주문 조회 → 일괄 취소
   ↓ (7) 봇 status 'paused' 또는 'stopped'으로 변경 X (running 유지, 다음 cycle에서 시간 체크로 skip)

[다음 영업일 09:00]
   ↓ (8) Agent cycle이 다시 봇 처리 시작 → 신규 grid level 주문
```

---

## 7. 시장 시간 처리

### 정규장
- 평일 09:00:00 ~ 15:30:00 KST
- 동시호가: 08:30~09:00 (개장), 15:20~15:30 (종가)
- 토요일/일요일/공휴일: 휴장

### 봇 cycle 시간 가드
```ts
function isMarketOpen(now: Date): boolean {
  const kst = toKST(now);
  if (kst.day === 0 || kst.day === 6) return false; // 주말
  const todayCalendar = await prisma.koreanMarketCalendar.findUnique({ where: { date: kst.dateOnly } });
  if (todayCalendar && !todayCalendar.isOpen) return false; // 휴장일
  const minutes = kst.hour * 60 + kst.minute;
  return minutes >= 9 * 60 && minutes < 15 * 60 + 30; // 09:00 ~ 15:30
}
```

### 장 마감 시 미체결 일괄 취소
- 15:30:00 cycle 마지막 시점에 한국주식 봇의 `GridLevel.status='pending'` 또는 토스에 살아있는 주문을 일괄 조회 → 토스 주문 취소 API 호출 → `GridLevel.status='cancelled'`
- 다음 영업일 09:00 cycle에서 신규 매수 grid level 주문 다시 실행

### 휴장일 캘린더 — 2026-07-01 재작성
- **1차 소스: 우리 자체 시드** (`korean_market_calendar` 테이블, `scripts/seed-korean-market-calendar.sql`)
- **2차 검증(daily)**: 매일 첫 cycle에 `GET /api/v1/market-calendar/KR?date=<today>` 호출. 응답의 `result.today`가 `integrated: null`이면 휴장, 있으면 정규장 세션 시간(preMarket/regularMarket/afterMarket) 확인.
  - 응답이 우리 시드와 일치 → 상태 유지
  - 응답이 우리 시드와 불일치 (임시 휴장/조기 마감 등) → 우리 DB에 upsert (`isOpen`, `reason='임시 반영'`)
- 봇 cycle의 `isMarketOpen()` 로직:
  1. 주말 → false
  2. `koreanMarketCalendar` today row가 있고 `isOpen=false` → false
  3. 위 조건 통과 → 시각 09:00~15:30 KST 검증
- **연말 시드 갱신**: 매년 12월 말 관리자가 다음 해 휴장일 시드 SQL 작성 → dev+prod 적용. 임시 휴장(선거일 추가 등)은 daily 검증에서 자동 반영.
- 상세 `market-calendar/KR` 스키마는 spec § 4 endpoint 카탈로그 참조.

---

## 8. 거래세 / 수수료 처리

### 실제 비용
- **거래세 (매도)**: 코스피 0.18% (농어촌특별세 0.15% 포함), 코스닥 0.18% — 2026년 기준
- **토스증권 수수료**: 약 0.015% (사용자별 차이 가능) — 매수/매도 양쪽
- **총 비용 (1회 매수+매도)**: 약 0.21% (코스피 기준)

### 시뮬레이션 표시
봇 등록 마법사 step 3에서:
```
입력:
  - 종목: 삼성전자 (005930)
  - 가격 범위: 70,000 ~ 80,000
  - 그리드 수: 10 (1,000원 간격)
  - 1회 주문 금액: 100,000원

자동 계산:
  - 그리드 간격: 1,000원 (1.43%)
  - 1회 매수 후 매도 시:
    - 매수: 100,000원 (수수료 15원)
    - 매도: 101,429원 (수수료 15원 + 거래세 183원)
    - 손익: +1,429 - 213 = +1,216원 (실수익률 +1.22%)
  ✅ 흑자 (실수익 > 0)

경고:
  - 그리드 간격이 0.22% 미만이면 빨간 경고: "거래세+수수료(약 0.21%)보다 작아 매 거래마다 손실 발생"
  - 그리드 간격이 0.22% ~ 0.5%면 노란 경고: "수익이 매우 작음, 시세 변동 시 손실 가능"
```

### Bot 모델에 비용 정보 저장
```prisma
model Bot {
  // ...
  feeRate    Float?  // 봇별 토스 수수료율 (default 0.015%, 사용자 settings로 변경 가능)
  taxRate    Float?  // 매도 거래세 (default 0.18%, 코스피/코스닥 자동 결정)
}
```
- 토스 수수료율은 사용자별 차이 가능 → settings에서 입력 가능
- 거래세는 종목 시장(코스피/코스닥) 따라 자동 결정 (2026년 현재 둘 다 0.18% 동일)
- nullable: crypto 봇은 NULL (기존 동작 유지)

---

## 9. 호가 단위 / 상하한가

### 호가 단위 (2026년 기준)
| 가격 범위 | 호가 단위 |
|---|---|
| ~ 2,000원 | 1원 |
| 2,000 ~ 5,000원 | 5원 |
| 5,000 ~ 20,000원 | 10원 |
| 20,000 ~ 50,000원 | 50원 |
| 50,000 ~ 200,000원 | 100원 |
| 200,000 ~ 500,000원 | 500원 |
| 500,000원 ~ | 1,000원 |
- 코스닥은 일부 구간 차이 있음 (구현 시 토스 종목 마스터에서 확인)

### 그리드 가격 자동 보정
```ts
function snapToTickSize(price: number): number {
  const tick = getTickSize(price);
  return Math.round(price / tick) * tick;
}
```
- 사용자가 그리드 등록 시 lowerPrice/upperPrice/gridCount 입력 → 백엔드에서 각 grid level 가격을 호가 단위로 자동 보정
- 보정 결과 사용자에게 미리보기로 표시 ("입력한 70,123원은 70,150원으로 보정됩니다")

### 상하한가 (±30%)
- 일일 가격 제한폭 ±30% (전일 종가 기준)
- 그리드 가격 범위가 상하한가 벗어나면 등록 거부
- 운영 중 상한가/하한가 도달 시 봇 자동 일시 정지 + 알림 (해당 일자만)

### VI(변동성 완화장치)
- 정적 VI(상하한가 10% 초과 시 2분 단일가) / 동적 VI(2~3% 변동 시 2분 단일가)
- VI 발동 중에는 주문 대기 → 토스 API가 reject 응답 시 retry
- 별도 처리 없이 토스 응답 기반으로 retry (3회 후 봇 일시 정지)

---

## 10. 종목 검색 (자동완성) — 2026-07-01 재작성

> **아키텍처 변경**: 토스 Open API에 "전체 종목 마스터 dump" endpoint 없음 (`GET /api/v1/stocks?symbols=` 은 명시된 심볼만 반환). Hybrid 전략으로 재설계.

### 전략: seed + lazy resolve
1. **Seed (오프라인)**: KOSPI 시가총액 top 100 + KOSDAQ top 100 = 총 200 종목을 SQL 시드로 `korean_stock_symbols` 테이블에 미리 INSERT.
   - 자동완성 UX의 90% 이상 커버 (사용자가 인기 종목 검색 지배적).
   - dev 시드 파일: `scripts/seed-korean-stock-symbols-dev.sql` (untracked).
   - production 시드: 별도 마이그레이션 또는 `prisma db seed`로 별도 등록.
2. **Lazy resolve (온라인)**: 사용자가 검색창에 미시드 종목 코드(예: `329180`)를 정확히 입력했는데 seed에 없으면, 백엔드가 `GET /api/v1/stocks?symbols=329180` 호출 → response의 `name/market/status`를 확인 → `active` 상태면 `korean_stock_symbols`에 upsert 후 검색 결과 반환.

### UX
- 봇 등록 마법사 step 1 입력창: "종목명 또는 코드 입력"
- 사용자 입력 (debounce 300ms) → GET `/api/korean-stocks/symbols/search?q=삼성` → 백엔드 → DB `KoreanStockSymbol` 조회 → 최대 20개 반환
- 결과 없고 `q`가 6자리 숫자 코드 패턴이면 → 서버가 lazy resolve 시도 → 성공 시 upsert 후 1건 반환, 실패(404 `stock-not-found`) 시 빈 배열
- 결과 카드: 종목명 (큰글씨) + 코드 (회색 작은글씨) + 시장(KOSPI/KOSDAQ 배지)

### 봇 등록 시 종목 확정 검증
- `POST /api/korean-stocks/bots`의 `ticker`가 DB에 없으면 → controller가 lazy resolve 1회 시도 → 그래도 없으면 400 `SYMBOL_NOT_FOUND`.
- 확정 후 upsert된 종목의 `status !== 'ACTIVE'` (SCHEDULED/DELISTED)면 400 `SYMBOL_NOT_TRADABLE`.

### 검색 UX 보강
- 정확 매칭 우선: "삼성" 입력 시 "삼성전자(005930)" 먼저 표시
- 시장별 필터 (KOSPI/KOSDAQ)
- 최근 검색/즐겨찾기 (localStorage, 추후)

### 상장폐지 감지 (별도 task, 본 스코프 외)
- 후속 후보:
  - (i) KRX 공식 상장종목 CSV 일 1회 pull → `status='DELISTED'` bulk update
  - (ii) 봇 cycle에서 `stocks?symbols=<보유심볼>` 200 응답의 `status`가 `DELISTED`이면 봇 자동 정지 + 알림
- 현 스코프에서는 (ii)만 최소 구현.

---

## 11. 봇 등록 마법사 (4 step)

### Step 1: 종목 선택
- 자동완성 종목 검색
- 선택 시: 종목 카드 표시 (종목명/코드/시장/현재가/52주 최고최저)

### Step 2: 가격 범위 설정
- 현재가 기준 슬라이더 또는 직접 입력
- lowerPrice/upperPrice (호가 단위 자동 보정)
- 상하한가 벗어나면 빨간 경고
- 미리보기: "현재가 75,000원 / 그리드 범위: 70,000 ~ 80,000원 (-6.7% ~ +6.7%)"

### Step 3: 그리드 + 주문 금액
- gridCount (2 ~ 50)
- 1회 주문 금액 (orderAmount)
- 거래세 시뮬레이션 자동 표시 (§ 8)
- 총 투자 금액 표시: `gridCount * orderAmount` (예: "총 1,000,000원 필요")
- 사용자 토스 계좌 잔액 표시 + 부족하면 경고

### Step 4: 최종 확인
- 모든 설정 요약
- 거래세 포함 예상 손익 다시 표시
- "이 설정으로 봇 시작" 버튼 → POST `/api/korean-stocks/bots`

### Step 0 (마법사 진입 전)
- 토스 credentials 미등록 시: "먼저 토스증권 API 키를 등록해주세요" + settings 페이지 링크

---

## 12. 그리드 매수/매도 알고리즘

### 알고리즘 (코인 그리드와 동일)
1. 사용자가 lowerPrice/upperPrice/gridCount 입력
2. 그리드 가격 계산: `prices = linspace(lowerPrice, upperPrice, gridCount + 1)` → 호가 단위 보정
3. 현재가 기준 모든 grid level이 매수 대기 상태 (`type='BUY'`, `status='available'`)
4. 봇 cycle (5초):
   - 현재가 < grid price 도달 시 매수 주문 실행 → `status='pending'` + orderId 저장
   - 토스에서 체결 알림 → `status='filled'` + `filledAt`
   - 매수 체결되면 그 grid level의 `type` 을 `SELL`로 전환 + 한 칸 위 가격으로 매도 주문 자동 발행
   - 매도 체결 시 `Trade` row 생성 (profit 계산) + 다시 `type='BUY'`로 전환
5. 1cycle 내 여러 grid level이 트리거되면 순차 처리 (rate limit 대응)

### 한국주식 특수 처리
- **장 시간 가드**: cycle 시작 시 `isMarketOpen()` false면 즉시 return
- **거래세 차감**: `Trade.profit` 계산 시 매도 거래세 + 양쪽 수수료 차감하여 net profit 기록
- **호가 단위 보정**: 매수/매도 주문 전 `snapToTickSize()` 호출
- **상하한가 도달**: 토스 reject 응답 시 봇 자동 일시 정지 + 알림

---

## 13. 미체결 주문 처리 — 2026-07-01 재작성

### Idempotency (`clientOrderId`)
모든 주문 생성 시 UUID v4를 `clientOrderId`로 실어 전송한다. 이유:
- 그리드 봇은 network timeout/부분 실패 상황에서 재시도. 재시도 시 동일 `clientOrderId` 사용하면 서버가 409 `request-in-progress` (진행 중) 또는 이미 생성된 주문의 응답을 반환 → **중복 주문 방지**.
- `GridLevel`에 `clientOrderId` 컬럼 신설 (`String? @db.VarChar(64)`) — 서비스 레이어에서 발행 시 저장, 실패 후 재시도에 재사용.
- `orderId` 대신 `clientOrderId`로 상태를 검증하는 recovery 흐름: 서버 실패로 orderId 못 받았을 때, 잠시 후 `GET /api/v1/orders?clientOrderId=<uuid>`로 상태 재조회 (본 스코프 v1에서는 단순 재시도 정책만 두고, `orders` 조회는 후속 task).

### 주문 취소 — 공식 endpoint
```ts
// 우리 tossService.cancelOrder(cred, orderId)
POST /api/v1/orders/{orderId}/cancel
Headers:
  Authorization: Bearer <access_token>
  X-Tossinvest-Account: <accountSeq>
Body: {}   // 빈 JSON 필수
// 응답: { result: { orderId } }
```
> 취소 method는 POST (DELETE 아님), path는 `/cancel` suffix. Body 없이 보내면 400.

### 장 마감 (15:30) 자동 취소 — 흐름
KoreanStockGridAgent의 마지막 cycle (15:29:55~15:30:00) 또는 별도 cron에서 다음 흐름을 수행한다:
```ts
const pendingLevels = await prisma.gridLevel.findMany({
  where: {
    bot: { market: 'KOREAN_STOCK', status: 'running' },
    status: 'pending',
    orderId: { not: null },
  },
});
for (const lvl of pendingLevels) {
  try {
    await tossService.cancelOrder(cred, lvl.orderId!);
    await prisma.gridLevel.update({
      where: { id: lvl.id },
      data: { status: 'available', orderId: null, clientOrderId: null },
    });
  } catch (e) {
    // 이미 체결/취소된 상태 (409 already-filled/canceled)면 상태 재조회 후 반영
    // 나머지 에러는 로그만 남기고 다음 level 진행
  }
}
```
- 매수 미체결 → 다음 영업일 09:00에 자동 재주문 (`clientOrderId`는 새 UUID 발행)
- 매도 미체결 → 다음 영업일 09:00에 자동 재주문 (포지션은 유지)

### 부분 체결
- 봇 v1 스코프에서는 `GET /api/v1/orders/{orderId}` 조회를 하지 않고, **주문 생성 응답만으로 진행**한다.
- 부분 체결 상세 회수는 후속 task로 분리 (아래 § 14의 `orders/{orderId}` 후속 작업 참조).
- 대신 장 마감 취소 흐름에서 `409 already-filled`를 받으면 "체결로 확정" 상태 전이 → Trade row 생성 (금액은 최소 1주 × price로 보수적 추정, 후속에서 정확 회수).

### 중복 방지 정책 요약
| 상황 | 우리 반응 |
|---|---|
| 네트워크 timeout 후 재시도 | 동일 `clientOrderId` 재발송 → 서버가 idempotent 처리 |
| 봇 crash/restart 후 미확정 order 있음 | `GridLevel.clientOrderId` 그대로 유지, 다음 cycle에서 상태 재확인 (후속) |
| 응답에 429 `rate-limit-exceeded` | `Retry-After` 대기 후 동일 `clientOrderId`로 재시도 |
| 응답에 409 `request-in-progress` | 300ms 대기 후 1회 재조회 (v1에서는 성공 간주하고 다음 cycle에 상태 검증) |

---

## 14. 에러 / 장애 처리 — 2026-07-01 재작성

### 공식 에러 envelope
```json
{ "error": { "requestId", "code", "message", "data" } }
```
서비스 레이어에서 axios error 파싱 시 `err.response.data.error.code`로 접근. `code`가 문자열이며 아래 정형 코드 세트에 속한다.

### 정형 에러 코드 표 (spec 발췌)

| HTTP | code | 의미 | 우리 반응 |
|---|---|---|---|
| 400 | `invalid-request` | 유효하지 않은 요청 (필드 누락/enum 불일치) | 봇 `status='error'` + errorMessage, 즉시 봇 정지 |
| 400 | `confirm-high-value-required` | 1억원+ 주문에 `confirmHighValueOrder=true` 누락 | v1 스코프에서는 발생 X (주문 상한 1억 미만으로 clip) |
| 400 | `account-header-required` | `X-Tossinvest-Account` 미전달 | 서비스 레이어 버그 → 500 알림 |
| 401 | `invalid-token` / `expired-token` / `edge-blocked` (401) / `login-user-not-found` | 인증 실패 | 토큰 캐시 무효화 + 1회 재발급 시도. 재실패면 credential 상태 `expired` 마킹 + 사용자 알림 |
| 403 | `edge-blocked` (403) / `forbidden` | 권한 부족 | 봇 정지 + 사용자에게 "API 권한 재승인" 안내 |
| 404 | `stock-not-found` | 존재하지 않는 종목 | createBot 단계면 400 응답으로 사용자 안내; 봇 cycle 중이면 봇 정지 + 상장폐지 의심 알림 |
| 404 | `order-not-found` | orderId 없음 | GridLevel `status='available'` 로 롤백 + 다음 cycle에서 재발행 |
| 404 | `account-not-found` | accountSeq 유효하지 않음 | credential 상태 `invalid` 마킹 + 사용자에게 재등록 안내 |
| 409 | `request-in-progress` | 동일 clientOrderId 처리 중 | 300ms 대기 후 성공 간주 (v1) — orders 재조회는 후속 |
| 409 | `already-filled` / `already-canceled` / `already-modified` / `already-rejected` / `already-processing` | 취소/정정 대상 주문 상태 전이됨 | GridLevel 상태를 서버 기준으로 재동기화 (filled면 매도 leg 발행) |
| 422 | `insufficient-buying-power` | 매수 가능 금액 부족 | grid level `status='available'` 유지 + errorMessage 기록. 봇은 계속 실행 (다른 매도 체결로 잔액 회복 가능). 3 cycle 연속 발생 시 봇 자동 정지 + 알림 |
| 422 | `order-hours-closed` | 주문 접수 불가 시간 | 봇 cycle 시 skip (isMarketOpen 체크 강화). 오탐 로그만 |
| 422 | `stock-restricted` | 거래 제한 종목 | 봇 정지 + 사용자 알림 |
| 422 | `price-out-of-range` | 상/하한가 이탈 | 그리드 범위 재계산 필요 상태로 봇 정지 + 사용자 안내 |
| 422 | `opposite-pending-order-exists` | 동일 종목 반대 방향 미체결 존재 | GridLevel의 반대편 pending을 우선 취소 후 재발행 (다음 cycle) |
| 422 | `order-type-not-allowed` | 현재 불가 호가 유형 | 봇 정지 (설정 재검토) |
| 422 | `prerequisite-required` | 약관/자격 미충족 | 사용자에게 토스증권 앱에서 약관 동의 안내 |
| 422 | `market-not-supported-for-stock` | KR 종목이 KR 시장에서 거래 불가 | 봇 정지 + 상장 이슈 알림 |
| 422 | `investor-exchange-not-integrated` | SOR 통합 설정 필요 | 사용자에게 "투자자지시 거래소 = 통합(SOR)" 설정 안내 |
| 422 | `modify-restricted` / `cancel-restricted` | 정정/취소 제한 | 로그만, 다음 cycle에서 재시도 |
| 429 | `edge-rate-limit-exceeded` / `rate-limit-exceeded` | rate limit 초과 | `Retry-After` 헤더 값 대기 → 지수 backoff (1s → 2s → 4s) + jitter ±20%. 최대 3회 |
| 500 | `internal-error` / `maintenance` | 서버 장애/점검 | cycle 단위 3회 backoff 재시도. 초과 시 봇 `status='error'` + 카카오톡 알림 (모든 봇이 동시 fail이면 1회로 dedupe) |

### OAuth 토큰 갱신
- 만료 5분 전 자동 재발급 (기존 방식 유지)
- 401 `expired-token`을 이유로 받는 경우 캐시 즉시 무효화 + 1회 재시도

### 잔액 부족 정책
- 22 `insufficient-buying-power`를 3 cycle 연속 받으면 봇 자동 정지 (무한 로그 방지)

### 상장폐지/거래정지
- 봇 cycle 중 `stocks?symbols=<봇 심볼>` 응답의 `status='DELISTED'` → 봇 자동 정지 + 알림
- 미체결 pending은 취소 시도 후 gridLevel 정리

### 네트워크 실패 정책
| 원인 | 우리 반응 |
|---|---|
| axios timeout (기본 10초) | cycle 단위 재시도 (지수 backoff, 최대 3회) |
| DNS/connection error | 봇 error 상태 전이 없이 skip, 다음 cycle 시도 |
| 3 cycle 연속 실패 | 해당 봇 `status='error'` + 카카오톡 알림 |
| 모든 한국주식 봇 동시 fail | 전역 장애로 판단, 카카오톡 1회 dedupe |

---

## 15. 일반 사용자 안전장치

### 등록 시
- 호가 단위/상하한가 자동 검증 (거부 시 명확한 사유 안내)
- 거래세 시뮬레이션 (§ 8) — 손실 가능 설정은 빨간 경고
- 총 투자 금액 + 계좌 잔액 비교
- "테스트로 1개 봇 먼저 운영해보기" 안내 (가급적 첫 봇은 작은 금액으로)

### 운영 중
- 봇 카드에 실시간 손익 표시 (오늘 + 누적)
- 봇별 Kill Switch 토글 (긴급 정지) — 위험 토글은 AlertDialog confirm
- 일별 손실이 -5% 초과 시 자동 일시 정지 + 알림 (사용자 설정 가능)

### 알림
- 장 시작 (08:55) "곧 장 시작 — 봇 N개 활성화 예정"
- 장 마감 (15:30) "장 마감, 미체결 N건 취소, 오늘 손익 +X원"
- 봇 오류 발생 즉시 카카오톡

---

## 16. 관측성 / 로깅

### 봇 메트릭
- 코인 grid-agent와 동일 패턴
- BaseAgent.getExtraInfo() → admin agents 페이지에 표시
- 추가: 토스 API 호출 횟수/실패율, OAuth 토큰 갱신 횟수

### 로그
- `[KoreanStockGridAgent] cycle N: 봇 M개 처리, 주문 K건, 실패 0건`
- `[TossService] 사용자 X: 토큰 재발급` / `시세 조회 1.2s` / `주문 reject: insufficient balance`
- 에러 시 `console.error` (기존 패턴)

### 카카오톡 알림 trigger
- 봇 오류 즉시
- 일일 손익 요약 (15:30)
- 토스 API 1시간 연속 실패 (모든 봇 영향)

---

## 17. 테스트 전략

### 단위 테스트
- `tossService.getAccessToken()` mock — 토큰 캐시, 만료 처리
- `marketHoursService.isMarketOpen()` — 평일/주말/휴장일/장 시간 경계
- `tickSizeService.snapToTickSize(price)` — 모든 호가 구간
- `feeCalculator.simulate()` — 거래세/수수료 시뮬레이션

### 통합 테스트 (mock)
- 토스 API mock으로 봇 cycle 1회 실행
- 매수 체결 → 매도 grid 자동 생성
- 매도 체결 → Trade row 생성 + profit 계산 정확
- 장 마감 시 미체결 일괄 취소

### Manual test (출시 전 — § 19)

---

## 18. 출시 전 체크리스트 — 2026-07-01 재작성

> **중요**: 토스 Open API에는 sandbox/dev/staging 환경이 없다 (§ 4 참조). 모든 검증이 **실계좌 실주문**을 의미하므로 canary 규칙을 엄격히 준수한다.

### Dev 환경 (로컬 개발자 서버)
- [ ] `TOSS_API_URL` 등 base URL을 `https://openapi.tossinvest.com`으로 확정
- [ ] 개발자 본인 토스 client_id/secret으로 credential 등록 → settings 페이지 정상 저장
- [ ] 계좌 목록 dropdown에서 accountSeq 선택 → 저장
- [ ] 종목 검색 (seed 200종): "삼성" → "삼성전자(005930)" 등 다수 반환
- [ ] 종목 검색 (미시드 코드): 예를 들어 `329180` (현대오토에버) → lazy resolve 후 1건 반환 + DB upsert 확인
- [ ] 봇 등록 마법사 4 step 정상 진행 (단, 봇 status=stopped 유지, 실주문 X)
- [ ] 거래세 시뮬레이션 정확 (수익/손실 케이스 모두)
- [ ] 호가 단위 보정 (예: 70,123 → 70,150)
- [ ] 상하한가 벗어난 가격 → 등록 거부
- [ ] 장 시간 체크 (오프장에 봇 cycle skip)
- [ ] `market-calendar/KR` 호출로 today 검증 후 우리 DB upsert 정상 동작

### Production 사전 점검
- [ ] 서비스 관리자 토스 계정으로 production client_id/secret 발급 완료 (본 스코프에서는 개별 사용자 키 사용 위주, 관리자 키는 후속 admin 기능용)
- [ ] `korean_stock_symbols` production 시드 200 종목 적용 (dev 시드와 동일 파일 사용 여부 결정 필요 — v1은 dev 시드를 그대로 production에 재사용)
- [ ] `korean_market_calendar` production 시드 (2026 휴장일 16건) 적용
- [ ] Rate limit 대응 코드 tsc/jest 통과 — `Retry-After` 지연 실측
- [ ] 카카오톡 알림 template 정상 (봇 error 알림 포함)

### Canary — 실주문 안전 규칙 (sandbox 없음 대응)

**Phase 1: 취소만 검증 (실체결 없음)**
- [ ] Canary 사용자 1명 봇 1개 등록, 실계좌에 **작은 금액** (10만원 이하) 대기
- [ ] 봇 활성화 (`status='running'`), 그리드 범위를 **현재가에서 매우 먼 위치**로 설정
  - 매수 grid: 현재가 대비 **-20%** 이하 (예: 현재가 70,000이면 매수 상단 56,000 이하)
  - 매도 grid: 현재가 대비 **+20%** 이상 (예: 84,000 이상)
  - 목적: 현재가가 그리드에 닿을 확률 근방 zero → 미체결 상태 유지
- [ ] 09:00~09:10 KST **제외** (rate limit 3 tps 제약)
- [ ] cycle 진행 후 GridLevel `status='pending'` 상태로 `orderId` 채워지는지 확인 (실주문 성공)
- [ ] 봇 kill switch → 모든 pending 취소 endpoint 호출 → GridLevel `status='available'` 복귀 확인 (취소 성공)
- [ ] 판정: 주문 생성/취소 endpoint 정상, envelope/decimal string/에러 코드 파싱 문제없음

**Phase 2: 최소 체결 검증 (실체결 1건)**
- [ ] 그리드 범위를 현재가 근처로 **좁게** 재설정 → 1주 최소 수량 매수 LIMIT (예: 삼성전자 1주 = 약 7만원)
- [ ] 체결 관찰 → Trade row 생성 + 매도 leg 자동 발행 확인
- [ ] 매도 leg는 즉시 취소 (수동 kill switch) — 시장 반전 리스크 최소화
- [ ] 판정: end-to-end grid 로직 정상, decimal 처리 정확, envelope unwrap 정상

**Phase 3: 1주일 소규모 운영**
- [ ] 10만원 이하로 정상 그리드 범위 (현재가 ±5%) 봇 1개 운영
- [ ] 매일 손익/오류 모니터링 + `admin/agents` 페이지에서 KoreanStockGridAgent 상태 관측
- [ ] 429 발생률 / OAuth 재발급 빈도 / 에러 코드 분포 로그 확인
- [ ] 1주일 후 판정 → 정상 시 일반 사용자 오픈 / 문제 시 spec § 14 위험 항목 참조

**Phase 4: 일반 오픈**
- [ ] 메뉴 노출 (그리드 mode nav에 이미 추가됨)
- [ ] 첫 1주는 hourly 모니터링, 이후 daily로 완화

**절대 금지**
- 개장 직후 09:00~09:10 canary 활성화 (rate limit 3 tps → 오류 급증)
- 시장가(`MARKET`) 주문 canary (즉시 체결 → 롤백 불가)
- 1억원+ 주문 (v1은 `confirmHighValueOrder` 미구현, spec 400 에러)

---

## 19. 신규 / 수정 파일

### 백엔드
**신규**
- `src/services/toss.service.ts` — 토스 OAuth + REST client (KIS 패턴 참조)
- `src/services/korean-stock-grid.service.ts` — 한국주식 그리드 로직 (호가 단위 보정, 거래세 계산)
- `src/services/korean-stock-market-hours.service.ts` — 장 운영 시간 + 휴장일
- `src/services/korean-stock-symbol-sync.service.ts` — 종목 마스터 일일 sync
- `src/agents/korean-stock-grid-agent.ts` — 한국주식 그리드 에이전트 (5초 cycle, 장시간만)
- `src/agents/korean-stock-symbol-sync-agent.ts` — 일일 종목 마스터 sync (KST 16:00 cron)
- `src/controllers/korean-stock.controller.ts` — 봇 CRUD + 종목 검색 + 잔액 조회
- `src/controllers/toss-credential.controller.ts` — 토스 API 키 등록/조회/삭제
- `src/routes/korean-stock.ts`, `src/routes/toss-credential.ts`

**신규 (이어서)**
- `src/services/korean-stock-bot-engine.service.ts` — 한국주식 봇 cycle 엔진 (장시간/거래세/호가단위 처리). 기존 `bot-engine.service.ts`(621줄, 코인 전용)는 건드리지 않음. `grid.service.ts`(가격 계산) 만 shared.

**수정**
- `prisma/schema.prisma` — Market enum + Bot.market + Bot.feeRate + Bot.taxRate + Exchange.toss + Credential.accountSeq + KoreanStockSymbol + KoreanMarketCalendar
- `src/index.ts` — 신규 에이전트 2개 등록 (KoreanStockGridAgent + KoreanStockSymbolSyncAgent), 빗썸 에이전트 등록 패턴 따름
- 마이그레이션: `add_market_enum_and_toss_exchange`

### 프론트엔드
**신규**
- `app/korean-stocks/page.tsx` — 봇 목록 + 봇 등록 마법사
- `app/korean-stocks/settings/page.tsx` — 토스 API 키 등록
- `app/korean-stocks/_components/SymbolSearch.tsx` — 종목 자동완성
- `app/korean-stocks/_components/BotWizard.tsx` — 4 step 마법사
- `app/korean-stocks/_components/FeeSimulator.tsx` — 거래세 시뮬레이션
- `app/korean-stocks/_components/MarketStatusCard.tsx` — 장 상태 표시

**수정**
- `lib/api.ts` — 한국주식 API 함수 추가 (`listKoreanStockBots`, `createKoreanStockBot`, `searchKoreanStockSymbol`, `simulateProfit`, `saveTossCredential` 등)
- admin/page.tsx 등 메뉴 — "한국주식 그리드" 메뉴 추가

---

## 20. 위험 / 완화

| 위험 | 완화책 |
|---|---|
| 토스 API rate limit 초과 | OAuth 토큰 캐싱 + 시세 polling 간격 조정 + 봇 수 많을 때 sequential 처리 |
| 거래세/수수료 잘못 계산하여 영구 손실 | § 8 자동 시뮬레이션 + 빨간 경고 + 일반 사용자 onboarding 마법사 |
| 호가 단위 안 맞아 주문 reject 누적 | 등록 시점에 보정 + 운영 중에도 매번 snapToTickSize |
| 장 마감 후 미체결 주문 방치 → 다음 날 시작가 변동으로 손실 | 15:30 자동 취소 + 다음 영업일 09:00 재주문 |
| 토스 API 갑작스러운 변경/장애 | 봇 자동 정지 + 카카오톡 알림 + 운영자 대응 |
| 일반 사용자가 큰 금액으로 시작해서 손실 | "테스트로 1개 봇 작은 금액부터" 안내 + 일일 손실 -5% 자동 정지 |
| 상장폐지/거래정지 | 일일 sync 시 표시 + 봇 자동 정지 |
| 사용자가 토스 client_secret 노출 | AES-256-GCM 암호화 + 일반 grep으로 노출 불가 + 사용자에게 키 보관 안내 |
| Bot 모델 공유로 인한 코인 기능 회귀 | market 분기 철저히 + 회귀 테스트 (코인 봇 정상 동작) |

---

## 21. 후속 작업 (백로그)

- 차트 통합 (TradingView 등)
- 다중 봇 비교 페이지
- 호가창 시각화 (토스 API 지원 시)
- 신용/대출 거래 지원
- 시간외 단일가 거래
- KIS API와 토스 API 이중 공급 (사용자 선택)
- 임시 휴장 admin 수동 입력 endpoint
- 봇별 자동 손절 (이미 코인 봇에 있음, 한국주식도)
