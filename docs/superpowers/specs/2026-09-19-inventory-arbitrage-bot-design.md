# 재고형(Inventory) 아비트리지 봇 설계서

- 작성일: 2026-09-19
- 상태: 설계 승인 완료 → 구현 대기 (**실거래 자동 봇이라 신선한 세션에서 구현 권장**)
- 범위: 백엔드(`v0-grid-tranasction-backend`) + 프론트(감시목록/승인 UI). 업비트↔빗썸.

## 1. 목적

업비트↔빗썸 간 **크로스 스프레드**(한쪽 매도호가 < 다른쪽 매수호가)가 발생할 때, **비싼 거래소에서 매도 + 싼 거래소에서 매수를 동시 실행**해 코인 개수를 보존하면서 원화 차익을 얻는다. 전송이 아니라 **양쪽에 미리 둔 재고를 맞바꾸는** 방식이라 온체인 전송·네트워크 함정이 없다.

⚠️ 이 프로젝트에서 가장 위험한 기능(실제 자금 자동 주문). 기본 OFF·canary·부분체결 방어를 설계 중심에 둔다.

## 2. 확정된 결정사항

| 항목 | 결정 |
|---|---|
| 실행 방식 | 기본 **반자동**(감지 → 카톡 알림 → 사용자 승인 → 자동 실행), **토글로 완전자동** 전환 가능 |
| 대상 코인 | **사용자 지정 감시목록** (코인별로 양쪽 거래소에 재고 사전 배치) |
| 거래소 | 업비트 ↔ 빗썸 |
| 기본 상태 | **비활성(OFF)** + canary 단계별 확대 |

## 3. 핵심 원리

- 크로스 스프레드 발생 시 **양쪽 동시 주문**: 비싼 거래소 매도(보유 코인) + 싼 거래소 매수(보유 KRW). 두 주문 **같은 수량** → 코인 순변화 0, 원화 순증.
- 재고는 유한하므로 한 방향으로 반복하면 소진된다(예: 빗썸 코인↓/업비트 코인↑). 소진 시 **자동 정지**(리밸런싱=전송은 이번 범위 밖, §8).
- 손익 = 수량 × (매도가 − 매수가) − 양쪽 수수료. 임계 스프레드 > 수수료(업비트 0.05% + 빗썸 0.04%/무료)여야 진입.

## 4. 아키텍처

```
InventoryArbAgent (BaseAgent, 주기 폴링 또는 호가 이벤트)
   ├─ SpreadDetector      : 양쪽 호가 → 크로스 스프레드(bps) + 실행가능 물량(depth)
   ├─ FeasibilityGate     : 임계 스프레드 + 재고/잔고 precheck + 재고 한도
   ├─ ApprovalGate        : 반자동이면 카톡 알림 후 승인 대기 / 완전자동이면 통과
   ├─ InventoryArbExecutor: 양쪽 동시 주문 (ExchangeLeg 재사용) + 부분체결 fallback
   ├─ SafetyGuards        : canary·상한·kill switch·입출금중단 감지
   └─ Notifier            : 카톡(기회/체결/실패/정지)
        │
        ▼
DB: InventoryArbBot(감시목록/설정) + InventoryArbTrade(실행 이력)
```

각 단위는 단일 책임·독립 테스트 가능.

## 5. 재사용 vs 신규 (2026-09-19 조사 기반)

### 재사용 (기존 코드)
- **`src/services/exchange-leg.ts:1-431`** — `ExchangeLeg` 어댑터(업비트/빗썸/코인원). `sellIoc`/`buyIoc`/`placeMakerBid`/`placeMakerAsk`/`pollOrder`/`cancelOrder`. 실제 주문·폴링·취소를 여기로 위임.
- **`src/services/maker-taker-spread-gate.ts:30-65`** — 크로스 스프레드 bps 계산/수익성 게이트 로직(참고·일부 재사용).
- **`src/services/exchange/{upbit,bithumb}-client.ts`** — 지정가/시장가 주문, 잔고 조회, 체결 확인.
- **live/canary 토글 패턴** — `MakerTakerSimBot.live` + Stage 1~3 확대(만원→2만→5만, 일3→10→30건) 방식을 그대로 차용.
- **부분체결 개념** — maker-taker-live-executor의 90% 체결 판정·`partial_hold`(단, 변동성용으로 fallback 강화, §7).

### 신규 (만들어야 함)
- **재고형 실행 엔진**: maker-taker는 "한쪽 체결 후 반대쪽" 순차 모델이라 재고형(양쪽 동시)과 다름 → 신규.
- **부분체결 fallback**: 변동성 코인은 보류(`partial_hold`)가 아니라 **즉시 손실 최소화**가 필요(§7).
- **감시목록 스키마**: stablecoin의 depeg bounds 등은 부적합 → 신규 모델.
- **입출금 중단 감지**: 재고 리밸런싱 불가 상황 회피용.

## 6. 데이터 흐름

1. **감지**: 감시목록 코인마다 업비트·빗썸 호가 조회 → 크로스 스프레드(bps)와 스프레드>0 구간의 매칭 가능 물량(depth) 계산. (양방향: 업bid−빗ask, 빗bid−업ask)
2. **1차 게이트**: 스프레드 ≥ 임계(bps) && 실행 물량 ≥ 최소.
3. **precheck**: 매도측 코인 재고 ≥ 주문량, 매수측 KRW ≥ 주문액(+수수료). 재고 한도(1회 최대 규모) 적용.
4. **승인**: 반자동 → 카톡으로 "코인/방향/예상차익/물량" 알림 후 승인 대기(승인 API 또는 UI 버튼). 완전자동 토글 시 스킵.
5. **동시 실행**: 양쪽에 동일 수량 주문. 지정가 touch(즉시 체결 가능한 최우선 호가) 또는 IOC. 상위 2~3호가 depth로 사이즈 제한(얇은 꼬리 호가 배제).
6. **부분체결 처리**(§7).
7. **기록·알림**: `InventoryArbTrade` 기록, 결과 카톡. 재고 소진/한도 도달 시 자동 정지.

## 7. 부분체결 방어 (변동성 코인 핵심)

크로스 스프레드가 3초에 수% 출렁이므로, 한쪽만 체결되면 방향성 노출 → "개수 보존"이 깨진다. 방어:
- **IOC/지정가 즉시 체결** 위주, 상위 depth 내 사이즈.
- 한쪽 leg 체결 + 다른쪽 미체결/부분체결(기대의 90% 미만) 시:
  - 기본(`fallback=market_flatten`): 미체결분을 **즉시 시장가로 맞춰** 개수/방향 복원(작은 손실 확정, 방향노출 차단).
  - 대안(`fallback=hold`): 재고 여유 있으면 보류 후 재시도(급등 진정 대기). 설정으로 선택, 기본은 market_flatten.
- **동시성 락**: 같은 코인 중복 실행 방지(mutex, 짧은 timeout).

## 8. 안전장치

- **기본 OFF**: `enabled=false`. canary Stage로 상한 확대(예 Stage1 5만원/일5건 → 2 / 3).
- **완전자동 토글**: `autoExecute`(기본 false = 반자동).
- **거래 상한**: 1회 최대 규모, 일일 건수/금액 한도.
- **잔고/재고 precheck** + 재고 한도.
- **kill switch**: 즉시 전체 정지.
- **입출금 중단 감지**: 대상 코인이 한쪽이라도 `wallet_state != working`이면 신규 실행 정지 + 알림(리밸런싱 불가 상황 회피). 재고형 자체는 전송 불필요하나, 재고 소진 후 못 채우므로 경고.
- **가격 이상(anomaly) 가드**: 스프레드가 비현실적으로 크면(티커/호가 오류 의심) 스킵.

## 9. 데이터 모델 (신규, 메인 DB)

```prisma
model InventoryArbBot {
  id            Int      @id @default(autoincrement())
  userId        Int
  symbol        String                 // base 심볼 (예: "BTC")
  minSpreadBps  Int      @default(30)  // 진입 임계 (0.30%)
  maxOrderKrw   Float                  // 1회 최대 주문 규모
  dailyMaxKrw   Float?                 // 일일 한도
  fallbackMode  String   @default("market_flatten") // "market_flatten" | "hold"
  autoExecute   Boolean  @default(false) // false=반자동(승인), true=완전자동
  enabled       Boolean  @default(false) // canary OFF 기본
  killSwitch    Boolean  @default(false)
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
  grossKrw      Float
  feeKrw        Float
  netKrw        Float
  status        String   // "filled" | "partial_flattened" | "failed" | "pending_approval"
  note          String?
  detectedAt    DateTime @default(now())
  executedAt    DateTime?
  @@index([botId, executedAt])
  @@map("inventory_arb_trades")
}
```

## 10. 범위 밖 (YAGNI)
- **자동 리밸런싱(거래소 간 전송)**: 재고 소진 시 자동 코인 전송은 이번 범위 밖. 재고 소진 시 정지 + 알림 후 수동 리밸런싱.
- **3개 이상 거래소**: 업비트↔빗썸만. (해외 거래소는 별도 `multi-exchange-arb-alert`가 알림 담당)
- **maker 선점(수수료 절감)**: 초기엔 즉시 체결(taker/IOC) 위주. maker 최적화는 후속.

## 11. 테스트 전략
- SpreadDetector: 모킹 호가로 크로스 스프레드/방향/물량 계산 검증.
- FeasibilityGate: 임계·재고·잔고·한도 경계값.
- InventoryArbExecutor 부분체결: 한쪽만 체결 → market_flatten fallback이 방향 복원하는지(모킹 ExchangeLeg).
- 안전장치: enabled=false 시 미실행, autoExecute=false 시 승인 대기, killSwitch, 입출금중단 감지 정지.
- canary 상한: maxOrderKrw/dailyMaxKrw 초과 차단.
- jest.

## 12. ⚠️ 구현 주의 (필독)
- **실거래 자동 주문**이다. 반드시 기본 OFF + canary 소액(첫 Stage 예 1만원/일 소수건)으로 시작하고, live 첫 체결을 반드시 사람이 검증한다.
- **부분체결 fallback을 가장 먼저·철저히 테스트**한다(방향노출 = 최대 손실원).
- 실거래 코드라 **신선한 세션에서 subagent-driven으로 신중히 구현**하고, 핵심(Executor·fallback)은 전용 코드 리뷰를 거친다.
- 배포 후 canary 첫 live 거래는 최소 규모로, 부분체결·수수료 실체결을 실데이터로 확인(빗썸 매수 수수료 코인 차감 여부 포함).
