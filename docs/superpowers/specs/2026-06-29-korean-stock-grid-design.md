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

## 4. 토스증권 Open API 사양 (확인된 사실)

### 인증
- **OAuth 2.0 Client Credentials Grant**
- 사용자가 토스증권 WTS(웹) → 설정 → Open API 메뉴에서 `client_id` + `client_secret` 발급
- 우리 백엔드는 사용자 키로 `POST /oauth2/token` 호출 → `access_token` 받음
- 모든 API 호출 시: `Authorization: Bearer {access_token}` 헤더
- 계좌 관련 요청: `X-Tossinvest-Account: {accountSeq}` 헤더 추가

### 제공 카테고리
- **Market Data**: 시세, 종목 마스터, 환율, 장 운영 시간
- **Account / Asset**: 계좌 목록, 보유 주식
- **Order**: 주문 생성/정정/취소, 주문 조회, 거래 가능 정보

### 통신 방식
- **REST API only** (WebSocket 없음) → 시세는 polling

### 필요한 사용자 입력 (credentials 저장)
| 필드 | 출처 | 우리 DB 저장 |
|---|---|---|
| `client_id` | 토스증권 WTS Open API 메뉴 | AES-256-GCM 암호화 |
| `client_secret` | 동일 | 암호화 |
| `accountSeq` | 토스증권 계좌 번호 (계좌 목록 API로 조회 가능) | 평문 |

### 자세히 알아봐야 할 항목 (구현 시점에 공식 문서로 확정)
- Rate limit (분당/일당 호출 제한)
- 주문 정정/취소 API의 응답 latency
- 시세 polling 주기 권장값
- 휴장일 endpoint 형식
- 주문 체결 알림 (push) 여부

---

## 5. 데이터 모델 변경

### 5.1 Prisma `Bot` 모델
- 신규 enum `Market { CRYPTO, KOREAN_STOCK }` 추가
- `Bot.market: Market @default(CRYPTO)` 컬럼 추가 (기존 row 자동 백필 = CRYPTO)
- `Exchange` enum에 `toss` 추가 (코인거래소들과 같은 enum 공유)

### 5.2 Credential
기존 `Credential` 테이블에 `purpose='toss'` row로 저장. `apiKey` 컬럼에 `clientId`, `secretKey` 컬럼에 `clientSecret` 저장 (KIS 패턴 그대로). `Credential` 모델에 신규 컬럼 `accountSeq String?` 추가 — 토스 계좌 시퀀스(평문, 시크릿 아님).

### 5.3 신규 모델 — `KoreanStockSymbol`
종목 검색 자동완성 + 호가 단위 캐싱용. 토스 API에서 종목 마스터 조회 후 캐싱.
```prisma
model KoreanStockSymbol {
  code      String   @id @db.VarChar(10)  // "005930"
  name      String                          // "삼성전자"
  market    String                          // "KOSPI" / "KOSDAQ"
  sector    String?
  updatedAt DateTime @updatedAt
  @@index([name])
  @@map("korean_stock_symbols")
}
```
- 일 1회 (장 마감 후) 토스 종목 마스터 API로 일괄 동기화
- 자동완성은 `WHERE name LIKE '<query>%' OR code LIKE '<query>%' LIMIT 20`

### 5.4 신규 모델 — `KoreanMarketCalendar` (휴장일)
```prisma
model KoreanMarketCalendar {
  date       DateTime @id @db.Date
  isOpen     Boolean
  reason     String?  // "신정", "임시휴장" 등
  @@map("korean_market_calendar")
}
```
- 토스 "장 운영 시간" API로 연 1회 일괄 동기화
- 봇 cycle 시작 시 오늘 row 조회

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

### 휴장일 캘린더
- 1차 소스: 토스 "장 운영 시간" API (구현 시점에 공식 문서로 정확한 endpoint 확정)
- Fallback: 토스 API에 휴장일 정보 없을 경우 KRX(한국거래소) 공식 휴장일 캘린더 수동 입력 또는 외부 라이브러리(`korean-holiday` 등) 사용
- 연 1회 (매년 12월 말) 일괄 동기화하여 다음 해 휴장일 채움
- 임시 휴장(예: 선거일 추가 등) 발생 시 수동 보정 가능한 admin endpoint는 본 스코프 외 (후속 task)

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

## 10. 종목 검색 (자동완성)

### UX
- 봇 등록 마법사 step 1 입력창: "종목명 또는 코드 입력"
- 사용자 입력 (debounce 300ms) → GET `/api/korean-stocks/search?q=삼성` → 백엔드 → DB `KoreanStockSymbol` 조회 → 최대 20개 반환
- 결과 카드: 종목명 (큰글씨) + 코드 (회색 작은글씨) + 시장(KOSPI/KOSDAQ 배지)

### 종목 마스터 동기화
- 일 1회 (장 마감 후 16:00 cron) 토스 종목 마스터 API → DB upsert
- 신규 상장/상장폐지 자동 반영
- 종목 수: KOSPI ~900개 + KOSDAQ ~1,600개 = 약 2,500개

### 검색 UX 보강
- 정확 매칭 우선: "삼성" 입력 시 "삼성전자(005930)" 먼저 표시
- 시장별 필터 (KOSPI/KOSDAQ)
- 최근 검색/즐겨찾기 (localStorage, 추후)

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

## 13. 미체결 주문 처리

### 장 마감 (15:30) 자동 취소
- KoreanStockGridAgent의 마지막 cycle (15:29:55~15:30:00) 또는 별도 cron에서:
  ```ts
  // 한국주식 봇의 모든 pending grid level
  const pendingLevels = await prisma.gridLevel.findMany({
    where: { bot: { market: 'KOREAN_STOCK', status: 'running' }, status: 'pending' }
  });
  for (const lvl of pendingLevels) {
    if (lvl.orderId) await tossService.cancelOrder(userId, lvl.orderId);
    await prisma.gridLevel.update({ where: { id: lvl.id }, data: { status: 'available' } });
  }
  ```
- 매수 미체결 → 다음 영업일 09:00에 자동 재주문
- 매도 미체결 → 다음 영업일 09:00에 자동 재주문 (포지션은 유지)

### 부분 체결
- 토스 주문 응답에서 `executedQty < requestedQty` 시 부분 체결로 처리
- Trade row의 `amount`는 실제 체결량 사용
- 미체결 잔여분은 장 마감 시 일괄 취소

---

## 14. 에러 / 장애 처리

### 토스 API 일시 장애
- HTTP 5xx 또는 timeout → cycle 단위로 retry (최대 3회)
- 3회 연속 실패 시 해당 봇 `status='error'` + `errorMessage` 저장 + 사용자 알림
- 모든 봇이 동시 fail (네트워크 장애) → 카카오톡 일괄 알림 1회

### OAuth 토큰 만료
- access_token 만료 시간 캐싱 (메모리 + DB)
- 만료 5분 전 자동 재발급
- 재발급 실패 시 credentials 문제 → 사용자에게 "토스 API 키 만료/변경 확인" 알림

### 사용자 토스 계좌 잔액 부족
- 매수 주문 reject → grid level `status='available'` 유지 + `errorMessage` 기록
- 봇 자체는 계속 동작 (다른 grid level이 매도되면 잔액 회복 가능)

### 상장폐지/거래정지
- 토스 시세 조회 시 종목 없음 응답 → 봇 자동 정지 + 알림
- KoreanStockSymbol 일일 sync 시점에 상장폐지 종목 표시

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

## 18. 출시 전 체크리스트

### Dev 환경
- [ ] 토스 sandbox/dev API endpoint 사용 (있다면)
- [ ] 테스트 계정으로 client_id/secret 등록 → settings 페이지에서 정상 저장
- [ ] 종목 검색 자동완성 동작 (삼성 → 005930)
- [ ] 봇 등록 마법사 4 step 정상 진행
- [ ] 거래세 시뮬레이션 정확 (수익/손실 케이스 모두)
- [ ] 호가 단위 보정 (예: 70,123 → 70,150)
- [ ] 상하한가 벗어난 가격 → 등록 거부
- [ ] 장 시간 체크 (오프장에 봇 cycle skip)
- [ ] 장 마감 시 미체결 취소 시뮬레이션

### Production 사전 점검
- [ ] 토스 production API client 발급
- [ ] OAuth 토큰 만료 시간/rate limit 공식 문서 확인
- [ ] 종목 마스터 일일 sync cron 동작 확인 (KST 16:00)
- [ ] 휴장일 캘린더 한 해치 사전 입력
- [ ] 카카오톡 알림 template 정상

### Canary
- [ ] 1주일간 사용자 1명 (베타) 운영
- [ ] 봇 1개, 작은 금액 (10만원 이하)
- [ ] 매일 손익/오류 모니터링
- [ ] 1주일 후 일반 사용자 오픈

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
