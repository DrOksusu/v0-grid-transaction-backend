# Maker-Taker 스테이블 시뮬레이터 설계서

> 작성: 2026-04-24 (세션 7 말미 검토용)
> 상태: **초안 — 사용자 승인 후 다음 세션에 구현**

## 1. 목표

Upbit 내 2종 스테이블코인 간 **"저유동성 코인에 매수호가 선점 + 고유동성 코인 시장가 매도"** 전략을 **실거래 없이 DB에 가상 기록**한다. 2~3일 관찰 데이터로 실제 수익성 검증 후 실거래(M3) 도입 여부 판단.

## 2. 전략 핵심

### 기본형
1. **Maker leg**: 저유동성 코인 X(예: USDS)에 `best bid - offset KRW` 가격으로 매수 지정가 주문 (가상)
2. **체결 이벤트**: 시장이 내 가격까지 내려와서 매도세와 만남 → 가상 체결
3. **Taker leg**: 즉시 고유동성 코인 Y(예: USDT)를 `best bid` 가격으로 시장가 매도 (가상)
4. **기록**: 두 leg의 실현 가격 + 수수료 + 슬리피지 계산해 순익 기록

### 예시 (2026-04-24 호가 기준)
```
USDS bid: 1486 / 1485 / 1484 / 1483 / [1482 비어있음] / 1481
USDT bid: 1487 / 1486 / 1485 / ...

전략 A: USDS를 1482원(빈 자리)에 매수 → 체결 시 USDT 1487원 매도
  이론 차익: +5원/코인, 수수료 -1.5원 → +3.5원 순익 (+24bp)

전략 B: USDS를 1480원에 매수 → 체결 시 USDT 1487원 매도
  이론 차익: +7원/코인, 수수료 -1.5원 → +5.5원 순익 (+37bp)
```

## 3. 아키텍처

### 독립 에이전트
- 이름: `MakerTakerSimulatorAgent`
- 기존 `StablecoinArbAgent`(동일 거래소 즉시 arb detection)와 **별도 에이전트**로 분리
- 이유: 관심사 분리, 실행 주기 다름(maker 주문 lifetime 있음), DB 스키마 다름

### 데이터 흐름
```
Upbit orderbook WS (기존 구독 재활용)
  → 매 tick마다 MakerTakerSimulatorAgent.evaluate()
     → 활성 봇 조회
     → 각 봇마다:
        - pending 주문 없으면 → 현재 호가로 "가상 매수 주문" 생성 (status=PENDING)
        - pending 주문 있으면 → 체결 판단 로직 실행
     → 체결 판단 긍정 시:
        - filledAt 기록, taker leg 실행 (현재 USDT best bid로 가상 매도)
        - P&L 계산, status=FILLED
     → pending 주문이 maxPendingMs 초과 → status=EXPIRED
```

## 4. 체결 판단 알고리즘 (핵심 난제)

실거래 체결 이벤트 없이 orderbook 스냅샷만으로 "내 지정가 매수 주문이 체결됐다"를 판단해야 함.

### 선택지와 트레이드오프

| 방식 | 정확도 | 구현 복잡도 | 과대평가 위험 |
|---|---|---|---|
| A. best bid가 내 가격 이하로 "한 번이라도" 내려왔다면 체결 | 낮음 | 매우 간단 | 높음 (맞은 편 물량 상관없이 체결 간주) |
| B. best bid가 내 가격 이하로 내려오고 + 내 호가 자리의 누적 수량이 감소 | 중간 | 중간 | 중간 |
| C. Upbit **trades API** 폴링 → 내 가격 이하의 시장가 매도 거래 감지 | 높음 | 높음 | 낮음 |
| D. Upbit WS `trade` 채널 추가 구독 | 높음 | 중간 | 낮음 |

**권장**: **초기 MVP는 A, 검증 후 D로 업그레이드**. A는 과대평가 확실하지만 "이론 상한"을 보여주므로 실거래 도입 판단의 최소 조건으로 활용(이마저도 수익 안 되면 실거래 무의미).

### 체결 판단 의사코드 (방식 A)

```typescript
// 매 orderbook update 마다
if (pendingOrder && orderbook[makerCoin].bid.price <= pendingOrder.price) {
  // 체결로 간주
  pendingOrder.filledAt = now;
  pendingOrder.filledPrice = pendingOrder.price; // 지정가 그대로 체결
  executeTakerLeg(pendingOrder);
}
```

### 방식 D 업그레이드 (향후)
- `wss://api.upbit.com/websocket/v1` 에 `{type: 'trade', codes: [...]}` 추가 구독
- 체결 내역 중 `ask_bid === 'ASK'`(시장가 매도) 이고 `trade_price <= pendingOrder.price` 인 것만 집계
- 누적 체결 수량이 내 주문 수량 도달 시 filled

## 5. 데이터 모델 (Prisma, `prisma-stablecoin/schema.prisma`)

```prisma
model MakerTakerSimBot {
  id               Int      @id @default(autoincrement())
  userId           Int
  enabled          Boolean  @default(true)
  killSwitch       Boolean  @default(false)

  makerCoin        String   // "USDS"
  takerCoin        String   // "USDT"
  bidOffsetKrw     Int      // best bid 대비 얼마 낮게 걸지 (음수). 예: -6
  quantity         Decimal  @db.Decimal(20, 8)  // 가상 주문 수량 (코인)
  maxPendingMs     Int      @default(3600000)   // 1시간

  // 헷지 조건 (taker leg 실행 시 최소 bid)
  minTakerBidKrw   Int?

  // 수수료 파라미터 (기본값 upbit 0.05%)
  makerFeeBps      Int      @default(5)
  takerFeeBps      Int      @default(5)

  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  trades           MakerTakerSimTrade[]

  @@map("maker_taker_sim_bots")
}

model MakerTakerSimTrade {
  id                  BigInt      @id @default(autoincrement())
  botId               Int
  bot                 MakerTakerSimBot @relation(fields: [botId], references: [id], onDelete: Cascade)

  createdAt           DateTime    @default(now())
  makerCoin           String
  takerCoin           String

  // Maker leg
  makerOrderPrice     Int         // 내가 건 가격
  makerFilledAt       DateTime?
  makerFilledPrice    Int?        // 실제 체결가 (방식 A에서는 orderPrice와 동일)

  // Taker leg
  takerExecutedAt     DateTime?
  takerMarketBid      Int?        // 실행 시점 USDT best bid
  takerSlippageBps    Int?        // 예상 vs 실행 가격 차이

  // 수량
  quantity            Decimal     @db.Decimal(20, 8)

  // P&L
  grossProfitKrw      Decimal?    @db.Decimal(18, 4)
  feeKrw              Decimal?    @db.Decimal(14, 4)
  netProfitKrw        Decimal?    @db.Decimal(18, 4)
  realizedSpreadBps   Int?

  status              String      // "PENDING", "FILLED", "EXPIRED", "CANCELLED"
  notes               String?     @db.Text

  @@index([botId, createdAt])
  @@index([status])
  @@map("maker_taker_sim_trades")
}
```

## 6. 파라미터 기본값

| 파라미터 | 기본값 | 근거 |
|---|---|---|
| `makerCoin` | USDS | 저유동성 + Upbit에서 bid 스택 자리 자주 비어있음 |
| `takerCoin` | USDT | 최고 유동성 + bid 깊이 두꺼움 → 시장가 매도 슬리피지 0에 가까움 |
| `bidOffsetKrw` | -4 | "1482원 같은 빈 자리" 공략. 조정 가능 |
| `quantity` | 10 | 가상이지만 실거래 전환 시 현실적 크기 |
| `maxPendingMs` | 3,600,000 (1시간) | 1시간 내 미체결 시 취소 (시장 변화 반영) |
| `minTakerBidKrw` | 1485 | USDT bid 1485 이하로 내려가면 taker leg 포기 (손절) |
| `makerFeeBps` / `takerFeeBps` | 5 / 5 | Upbit 일반 0.05% (실거래 전환 시 코인별 실측값으로 교체) |

## 7. 초기 봇 3개 제안 (관찰용)

시뮬레이션 시작 시 3가지 조합을 동시에 돌려 비교:

| 봇 | makerCoin | takerCoin | bidOffsetKrw | 예상 체결 빈도 | 예상 수익 |
|---|---|---|---|---|---|
| 1 | USDS | USDT | -2 (bid+2만 낮게) | 높음 | 낮음 |
| 2 | USDS | USDT | -4 (빈 자리) | 중간 | 중간 |
| 3 | USDS | USDT | -6 | 낮음 | 높음 |

2~3일 관찰 후 수익/체결 빈도 균형 최적값 도출.

## 8. 리스크 및 제약

1. **체결 판단 과대평가**: 방식 A는 "호가가 내려온 적이 있다"만 체크하므로 실제로는 상대 물량 부족으로 체결 못 했을 수 있음. 실거래 전 방식 D 구현으로 검증 필수.

2. **Taker leg 슬리피지 0 가정**: USDT 시장가 매도를 최상 bid 그대로로 가정하지만 실제 수량이 많으면 더 낮은 bid까지 먹힐 수 있음. 추후 orderbook 깊이 기반 슬리피지 모델 추가.

3. **재고 리스크 미반영**: 현재 시뮬레이터는 USDS 무한 매수/USDT 무한 매도 가정. 실거래 전환 시 재고 한도 + 리밸런싱 비용 포함해야 함.

4. **peg 깨짐 리스크**: USDS 1달러 고정이 흔들리면 USDT와의 "같은 1달러 가치" 가정 붕괴. 디페그 감지 로직은 `feedback_production_db_safety.md`와 별개로 전략 레벨에서 추가 필요.

## 9. 성공 기준

2~3일 관찰 후:
- 일일 체결 건수 ≥ 10건 (의미있는 빈도)
- 평균 순익 ≥ +10bp (수수료 제외 후)
- 최대 drawdown (연속 실패) 분석 결과 감내 가능한 수준

이 세 조건 모두 만족 시 **M3 실거래 executor에 이 전략 통합** 논의. 아니면 폐기 또는 방식 D로 재검증.

## 10. 열린 결정 사항 (다음 세션 시작 시 확정)

- [ ] 체결 판단 방식 A로 시작 확정? (advisor 권장 사항 재확인)
- [ ] 초기 봇 3개 or 1개부터? (리소스/DB 볼륨 고려)
- [ ] minTakerBidKrw 하드코딩 vs 동적 계산 (makerCoin 매수가 - 최소이익)?
- [ ] Upbit trades API 사용 시 rate limit (10req/sec) 고려 필요?

## 11. 참고

- `project_stablecoin_arb_handoff.md` — M1+M2 완료 상태, M3 설계 배경
- `feedback_prisma_migrate_cli_garbage.md` — migration SQL 생성 후 tail 검사 (이번에 재적용)
- `feedback_agent_cycles_red_herring.md` — 구현 후 동작 검증은 side effect(DB row)로
- 실시간 호가 관찰 데이터는 `grid_transaction.cross_exchange_snapshots` (CrossExchangeObserverAgent 수집 중)
