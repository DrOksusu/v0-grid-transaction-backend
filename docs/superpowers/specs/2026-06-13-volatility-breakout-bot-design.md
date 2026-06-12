# 변동성 돌파(래리 윌리엄스) 자동매매 봇 설계

작성일: 2026-06-13
상태: 설계 확정 (구현 전)

## 1. 배경과 목적

BTC/USDT 8년 백테스트(바이낸스 4h→일봉, 수수료 0.1% 왕복)에서 변동성 돌파 전략이
k=0.65 기준 $1,000 → $16,099 (단순 보유 $9,942 대비 +62%), MDD 29.5%를 기록했다.
k=0.6~0.7 전 구간이 완만한 수익 봉우리를 형성해 파라미터 강건성도 확인됐다.
이 전략을 업비트 KRW 시장에서 실행할 수 있는 봇과 관리 UI를 만든다.

백테스트 스크립트: `scripts/backtest-volatility-breakout.ts` (검증 이력)

## 2. 전략 규칙 (확정)

- 하루 사이클: KST 09:00 ~ 다음날 09:00 (업비트 일봉 갱신 시각과 일치)
- 매수 기준가(목표가) = 당일 시가 + (전일 고가 − 전일 저가) × k
- 당일 가격이 목표가에 도달하면 시장가 매수. **하루 최대 1회 진입**
- 청산 (둘 중 먼저 발생하는 것):
  - 손절(STOP): 현재가 ≤ 진입가 × (1 − stopLossPct/100) → 즉시 시장가 매도
  - 종가 청산(CLOSE): KST 08:55~09:00 강제 시장가 매도
- 기본값: k=0.65, stopLossPct=3, 수수료 가정 0.05%/회 (업비트)

## 3. 운영 모드

| 모드 | 동작 |
|---|---|
| 모의 (live=false, 기본) | 주문 없이 현재가 기준 가상 체결을 DB에 기록. 슬리피지 실측·검증용 |
| 실거래 (live=true) | 업비트 시장가 주문 실행 (기존 사용자 인증정보 사용) |

- 모의 → 실거래 전환은 UI 토글 + 확인 다이얼로그
- 실거래 주문 전 업비트 최소 주문금액(5,000 KRW) 검증

## 4. 데이터 모델 (Prisma)

```prisma
model VolatilityBreakoutBot {
  id           Int      @id @default(autoincrement())
  userId       Int
  market       String   // "KRW-BTC", "KRW-ETH" 등
  buyAmountKrw Float    // 1회 매수금액
  k            Float    @default(0.65)
  stopLossPct  Float    @default(3)
  live         Boolean  @default(false)
  enabled      Boolean  @default(false)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  trades       VolatilityBreakoutTrade[]

  @@unique([userId, market]) // 사용자×코인당 봇 1개
}

model VolatilityBreakoutTrade {
  id          Int       @id @default(autoincrement())
  botId       Int
  bot         VolatilityBreakoutBot @relation(fields: [botId], references: [id])
  tradeDate   String    // KST 거래일 "2026-06-13" (09:00 경계 기준)
  targetPrice Float
  entryPrice  Float
  entryAt     DateTime
  qty         Float
  exitPrice   Float?
  exitAt      DateTime?
  exitReason  String?   // "CLOSE" | "STOP"
  pnlKrw      Float?
  pnlPct      Float?    // 수수료 차감 후
  isLive      Boolean
  status      String    // "HOLDING" | "CLOSED"

  @@index([botId, tradeDate])
}
```

- 거래가 발생한 날만 row 생성 (돌파 없는 날은 기록 없음)
- 서버 재시작 시 `status=HOLDING` row로 포지션 복구
- "오늘 이미 거래했는가"는 `(botId, tradeDate)` 조회로 판단

## 5. 백엔드 구성 (기존 에이전트 아키텍처 통합)

| 파일 | 역할 |
|---|---|
| `src/agents/volatility-breakout-agent.ts` | BaseAgent 확장, 30초 주기 사이클. `src/index.ts`에 등록 |
| `src/services/volatility-breakout.service.ts` | 봇 CRUD, 사이클 로직(목표가 계산→진입→청산), 모의/실거래 체결 |
| `src/services/volatility-backtest.service.ts` | 업비트 일봉 수집(페이지네이션) + 백테스트 실행 |
| `src/utils/volatility-breakout-core.ts` | **순수 함수**: 목표가 계산, KST 거래일 계산, 백테스트 시뮬레이션. 봇과 백테스트가 공유. 단위 테스트 대상 |
| `src/controllers/volatility.controller.ts` | 요청 파싱/검증 |
| `src/routes/volatility.ts` | 라우트 (`/api/volatility`, authenticate) |

### 에이전트 사이클 (30초)

```
대상 봇 = enabled 봇 + (disabled여도 HOLDING 거래가 있는 봇 — 청산 감시 유지):
  1. KST 거래일 계산 (09:00 경계)
  2. 목표가 확보 — 업비트 일봉 2개(오늘 시가, 전일 고저)로 계산, 거래일당 1회 캐시
  3. 현재가 조회 — 업비트 public ticker REST (인증 불필요)
  4. HOLDING 거래 있음:
     a. 현재가 ≤ 손절선 → 매도(STOP)
     b. KST 08:55~09:00 → 매도(CLOSE)
     c. 거래일이 바뀌었는데 HOLDING (서버 다운으로 청산 누락) → 즉시 매도(CLOSE)
  5. HOLDING 없음 (enabled 봇만 — 신규 진입은 활성 상태에서만):
     a. 오늘 tradeDate에 거래 row 존재 → 대기 (하루 1회)
     b. 현재가 ≥ 목표가 → 매수 (모의: 가상 체결 / 실거래: buyMarket)
```

### 주문 실행

- 매수: 기존 `upbitService.buyMarket(market, totalPrice)` 재사용
- 매도: `upbitService.sellMarket(market, volume)` — **없으면 신규 추가** (업비트 ord_type=market, side=ask)
- 실거래 체결가/수량은 주문 응답(또는 주문 조회)에서 실제 값을 가져와 기록
- 알림: 체결/손절/청산/주문 에러 시 기존 텔레그램·카카오 알림 발송

## 6. API

Base: `/api/volatility` (전부 authenticate)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/bots` | 내 봇 목록 + 실시간 상태(오늘 목표가, 현재가, 돌파까지 %, 포지션) |
| POST | `/bots` | 생성 `{market, buyAmountKrw, k?, stopLossPct?}` |
| PUT | `/bots/:id` | 수정 (buyAmountKrw, k, stopLossPct, live, enabled) |
| DELETE | `/bots/:id` | 삭제 (HOLDING 포지션 있으면 거부) |
| GET | `/bots/:id/trades` | 거래 내역 (최신순, 페이지네이션) |
| POST | `/backtest` | `{market, k, stopLossPct, years(1\|2\|4\|8)}` → 백테스트 결과 |

백테스트 응답: `{ n, winRate, avgNetPct, finalCapital(₩100만 시작 복리), maxDdPct, worstPct, yearly: [{year, pnlPct}], buyHoldFinal }`

검증(zod): buyAmountKrw ≥ 5000, 0.1 ≤ k ≤ 2, 0.5 ≤ stopLossPct ≤ 50, market은 업비트 KRW 마켓 코드 형식

## 7. 백테스트 엔진

- 데이터: 업비트 일봉 API (`/v1/candles/days`, count=200 페이지네이션) — 8년 ≈ 15회 호출, 3~5초
- 시뮬레이션 (순수 함수, 봇과 동일한 목표가 공식 사용):
  - 진입: `high ≥ target`이면 target 가격 체결 가정
  - 손절: 진입일 `low ≤ entry×(1−sl)` 이면 손절가 체결 (보수적 — 손절을 종가 청산보다 먼저 가정)
  - 그 외: 당일 종가 청산
  - 수수료 0.1% 왕복 차감, 복리
- 한계 (스펙으로 명시): 일봉 기반이라 장중 돌파→손절 순서는 근사치. 슬리피지 미반영 — 모의 모드 실측으로 보완

## 8. 프론트엔드

- 신규 페이지 `app/volatility/page.tsx` + 사이드바/모바일 네비 메뉴 추가
- `lib/api.ts`에 API 함수 + 타입 추가

화면 구성 (shadcn/ui Card 기반, 기존 전략 페이지 패턴):

1. **봇 설정 카드**: 코인 선택(셀렉트), 1회 매수금액(KRW), k, 손절 %, 모의/실거래 토글(전환 시 확인 다이얼로그), 시작/정지 버튼
2. **오늘 상태 카드**: 목표가, 현재가, 돌파까지 거리 %, 포지션 상태(대기/보유/청산 완료), 보유 시 진입가·평가손익. 10초 폴링 갱신
3. **백테스트 검증 카드**: 기간 선택(1/2/4/8년) + 실행 버튼 → 결과 표(최종자본, 승률, MDD, 단순보유 대비, 연도별 손익). 현재 폼의 k/손절 값으로 실행
4. **거래 내역 테이블**: 날짜, 모드(모의/실거래), 진입가, 청산가, 사유(CLOSE/STOP), 손익

## 9. 에러 처리·안전장치

- 실거래 주문 실패: 에러 알림 발송 + 다음 사이클 재시도 안 함(해당 거래일 skip) — 중복 주문 방지 우선
- 매도 실패(STOP/CLOSE): **재시도함** (포지션 방치가 더 위험). 사이클마다 청산 조건 재평가가 자연 재시도가 됨
- 업비트 API 장애: 사이클 에러는 BaseAgent 메트릭에 기록, 포지션은 다음 정상 사이클에서 조건 재평가
- 봇 삭제/정지 시 HOLDING 포지션 처리: enabled=false여도 HOLDING이면 청산 감시는 계속 (정지=신규 진입 중단). 삭제는 포지션 없을 때만 허용

## 10. 테스트 (TDD)

`src/utils/volatility-breakout-core.ts` 순수 함수 단위 테스트:
- 목표가 계산 (전일 변동폭 × k)
- KST 거래일 경계 (08:59 vs 09:01)
- 백테스트: 진입 발생/미발생, 손절 우선, 종가 청산, 수수료 차감, 복리 누적
- 청산 판단 함수: 손절 조건, 강제 청산 시간 창, 거래일 변경 감지

## 11. 구현 순서 (참고)

1. Prisma 스키마 + 마이그레이션
2. core 순수 함수 (TDD) → 백테스트 서비스 + API
3. 에이전트 + 봇 사이클 (모의 모드)
4. 실거래 경로 (sellMarket 추가 포함) + 알림
5. 프론트엔드 페이지
6. 통합 검증 (모의 모드로 1사이클 관찰)

## 12. 범위 제외 (YAGNI)

- 멀티 거래소(바이낸스 등) 지원 — 업비트만
- k/손절 자동 최적화, 동적 파라미터
- 부분 청산, 분할 매수
- 코인별 동시 다중 봇 초과 운영 (사용자×코인당 1개)
