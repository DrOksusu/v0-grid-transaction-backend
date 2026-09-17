# 그리드 코인 중립(현금 누적) 모드 설계서

- 작성일: 2026-09-18
- 상태: 설계 승인 완료 → 구현 계획 대기
- 범위: 백엔드(`v0-grid-tranasction-backend`) + 프론트(`v0-grid-transaction-frontend`)

## 1. 목적

그리드 봇 생성 시 손익 방식을 **토글로 선택**할 수 있게 한다.
- **코인 쌓임(디폴트)**: 현재 방식(정액 그리드). 매매를 반복할수록 코인이 쌓이고 원화는 수수료만큼 감소.
- **코인 중립(신규)**: 산 수량만큼만 팔아 코인 수량은 불변, 차익을 원화로 실현(현금 누적).

배경: 현재 그리드는 매수·매도 모두 `orderAmount`(원화 금액) 고정이라, 매도 수량(`orderAmount/매도가`) < 매수 수량(`orderAmount/매수가`) → 매 사이클 코인이 쌓이고 원화 현금은 왕복 수수료만큼 줄어든다. 코인 가격이 충분히 높다고 판단될 때 "현금을 쌓는" 선택지를 제공한다.

## 2. 확정된 결정사항

| 항목 | 결정 |
|---|---|
| 적용 범위 | **신규 봇 생성 시에만** (기존 봇은 디폴트 유지, 소급 없음) |
| 디폴트 | **코인 쌓임(`fixed_amount`)** — 기존 동작과 동일 |
| 신규 모드 | **코인 중립(`coin_neutral`)** |
| 매도 수량 소스 | **`GridLevel.filledQty` 필드** (Trade 조인보다 명시적·안전) |
| 매수 로직 | 변경 없음 (항상 `orderAmount/매수가`) |

## 3. 핵심 원리

- 매도 수량을 **"그 매도에 대응하는 매수의 실제 체결 수량"**으로 맞춘다.
- 매수는 지금처럼 `orderAmount` 기준. 각 매수-매도 쌍에서 **같은 수량**이 오가므로 코인 수량 불변, 차익은 원화로 남는다.
- `coin_neutral` 손익(1만원, 매수 1,000 / 매도 1,008, 업비트 0.05% 예):
  - 매수 10.000개(1만원) → 매도 10.000개(=매수량, 10,080원 회수) → **원화 +80 − 수수료 10 ≈ +70원, 코인 ±0**
  - 대조: `fixed_amount`는 매도 9.921개 → 원화 −10원, 코인 +0.079개

## 4. 구성 요소 / 변경 지점

조사(2026-09-18) 기반 실제 파일·라인.

### (a) DB 스키마 (`prisma/schema.prisma`)
- `Bot` 모델(L50-79)에 필드 추가:
  ```prisma
  profitMode String @default("fixed_amount")  // "fixed_amount" | "coin_neutral"
  ```
  (enum 대신 String + 기본값 — 기존 마이그레이션 스타일과 정합, 비파괴)
- `GridLevel` 모델(L81-104)에 필드 추가:
  ```prisma
  filledQty Float?  // 매수 실제 체결 수량 (coin_neutral 매도 시 참조)
  ```

### (b) 매수 체결 수량 기록 (`trading.service.ts`)
- `processFilledOrder`(L995-1000)에서 이미 계산하는 `filledVolume`(실제 체결 수량)을, **매수 체결 시 해당 GridLevel.filledQty에 저장**한다.

### (c) 매도 수량 분기 (`trading.service.ts` 2곳)
- 주기적 매도 `executeTrade`(L442): 현재 `const volume = bot.orderAmount / executableGrids.sell.price`
  → `coin_neutral`이면 대응 매수 GridLevel의 `filledQty`를 사용. (executeTrade에 `bot.profitMode` 조회 추가 — 현재 L216-225는 status만 select)
- 즉시 반대주문 `executeOppositeOrder`(L1442): 매수 체결 직후 매도. `filledVolume`를 함수 인자로 전달받아 `coin_neutral`이면 그 수량으로 매도.
- **`filledQty`가 없거나 0인 예외 상황**: 안전하게 기존 방식(`orderAmount/매도가`)으로 폴백하고 경고 로그. (코인 중립이 깨지지 않도록 하되, 매도 자체가 막히면 안 됨)

### (d) API / 프론트
- `bot.controller.ts` createBot(L20-29): `profitMode` 수신(옵션, 기본 `fixed_amount`). 허용값 검증.
- `lib/api.ts` `CreateBotRequest`(L97-106)에 `profitMode?: 'fixed_amount' | 'coin_neutral'` 추가.
- `app/bot/new/page.tsx` 봇 생성 폼: 토글/라디오 추가. **디폴트 = 코인 쌓임**. 각 모드 한 줄 설명(코인 쌓임: 하락장 유리 / 코인 중립: 현금 실현).

### (e) 기존 봇 격리
- 마이그레이션 시 기존 Bot은 `profitMode='fixed_amount'` 자동 → 런타임 분기는 전부 `if (bot.profitMode === 'coin_neutral')` → **기존 봇 손익 영향 0**.

## 5. 트레이드오프 (사용자 선택 기준, 폼에 반영)
- **코인 쌓임(디폴트)**: 하락장에 코인 축적 → 반등 시 수익. 원화는 수수료로 감소. 상승·변동장 유리.
- **코인 중립**: 매 거래 원화 이익 실현, 코인 불변. 하락장에서 코인이 안 쌓여 반등 수익 기회는 적음. 횡보·고점 판단 시 유리.

## 6. 리스크 / 주의
- 부분 체결은 완전체결(`state==='done'`)만 `processFilledOrder`로 처리 → `filledQty`는 항상 확정값. 수량 어긋남 없음.
- `coin_neutral` 매도 시 `filledQty` 미존재(구 데이터/리컨사일 경로)면 폴백 + 경고. 코인 중립이 일시적으로 안 지켜질 수 있으나 매도는 정상 수행.
- 기존 정액 경로 코드는 그대로 유지(회귀 위험 최소화).

## 7. 범위 밖 (YAGNI)
- 기존 봇의 모드 전환(소급) — 이번 범위 아님.
- 비대칭 비율(부분 현금화) 모드 — 이번엔 2택(코인쌓임/코인중립)만.
- 고점 지표 자동 전환 — 후속.

## 8. 테스트 전략
- 매도 수량 계산 단위테스트: `coin_neutral`이면 filledQty 사용, `fixed_amount`이면 orderAmount/sellPrice. (모킹 GridLevel/Bot)
- filledQty 폴백 테스트: filledQty null → orderAmount/sellPrice 폴백 + 경고.
- 매수 체결 시 GridLevel.filledQty 저장 검증.
- 기존 `fixed_amount` 경로 회귀: 수량 계산이 종전과 동일함을 고정.
- jest.
