# Cross-Exchange Stablecoin Arbitrage 설계서

> 날짜: 2026-05-01
> 작성: Claude (세션 12)
> 상태: brainstorming 승인 → spec 검토 대기
> 관련: Stage 3 maker-taker (Upbit 단일 거래소) 가동 중. 본 spec 은 별개 시스템.

## 0. 개요

Upbit + Bithumb 양 거래소에서 동일 스테이블코인을 동시 매매하여 가격차(spread)를 차익으로 취하는 cross-exchange arbitrage 시스템.

### 0.1 한 줄 요약

5초마다 Upbit + Bithumb 양쪽 호가 비교 → spread bps 50 이상 시 한쪽 시장가 매수 + 반대쪽 시장가 매도로 즉시 lock.

### 0.2 핵심 결정 (Brainstorming 결과)

| Q | 결정 |
|---|------|
| Q1 빗썸 활용 | **B. Cross-exchange arbitrage** (양 거래소 가격차 활용) |
| Q2 거래 모델 | **A. Both Taker** (양쪽 시장가, 단순/즉시) |
| Q3 양방향/리밸런싱 | **A. 양방향 자동 모니터링 + 수동 리밸런싱** |
| Q4 진입 코인 | **A. 데이터 분석 후 1-2 코인** |
| Q5 진입 봇 구성 | **B. USDE BU + USD1 UB 양봇 + 50 bps** |
| Q6 거래 시퀀스 | **A. Sequential + No Fallback** (PR E2 패턴 답습) |
| Q7 자금 규모 | **A. Stage 1 캐너리 (quantity=10, daily 5건)** |
| Q8 안전장치 | **default 패키지 전부** (depeg ±1.5%, daily loss 50,000 KRW, single-leg auto-killSwitch 등) |

### 0.3 본 spec 범위 (Stage 1 캐너리만)

- 봇 가동: USDE BU + USD1 UB
- 봇별 quantity = 10, 일일 한도 5건
- 24h 캐너리 → Exit 기준 충족 시 **Stage 2 별도 spec** (quantity 2배, 한도 6배)
- Stage 2/3 는 본 spec 범위 밖

### 0.4 기존 시스템과의 관계

- **유지**: 모든 기존 6 에이전트 (CrossExchangeObserver 포함)
- **확장**: 7번째 에이전트 `CrossExchangeArbAgent` 추가
- **비파괴**: Maker-Taker 봇 (Stage 3) 영향 없음. 별도 봇 모델, 별도 잔고 라우팅
- **재사용**: `CrossExchangeObserver` 가 5일+ 누적한 spread 데이터 = 본 시스템 임계값 결정 근거

## 1. 데이터 분석 결과 (Q5 결정 근거)

`CrossExchangeObserver` 5일치 (302,355 row) 통계:

### 1.1 코인별 spread bps avg/max

| 코인 | avg_max | max | UB 우세 | BU 우세 |
|------|---------|-----|---------|---------|
| **USDE** | -34.7 | 87 | 1.7/일 | **386/일** |
| USDS | -18.2 | 53 | 1.8/일 | 95/일 |
| USD1 | -6.4 | 53 | **273/일** | 0.7/일 |
| USDC | -7.8 | 13 | 0/일 | 0/일 |
| USDT | -4.1 | 6 | **0/일** | **0/일** |

### 1.2 50 bps 임계값 일일 기회 수

| 코인 | UB | BU | 합 |
|------|-----|-----|-----|
| USDE | 0 | **263** | 263/일 |
| USD1 | 2.1 | 0 | 2.1/일 |
| 나머지 | 0 | 0 | 0/일 |

### 1.3 핵심 인사이트

1. **USDT/USDC 진입 불가** — spread 거의 0 (가장 효율적 시장)
2. **USDE BU 가 최고** — Upbit 매수 + Bithumb 매도, 50 bps 에서 일 263 events
3. **USD1 UB 가 USDE 의 정반대** — Bithumb 매수 + Upbit 매도. 양봇 동시 운영 시 잔고 흐름 반대 = 자연 균형
4. **30 bps 임계값 시 일 660 events** — Stage 2 에서 검토. Stage 1 은 50 bps 보수.

### 1.4 fee 계산 가정

- Upbit taker = 0.05% = 5 bps
- Bithumb taker = 0.05% = 5 bps (사용자 확인 값)
- fee 합 = 10 bps
- 50 bps 임계값 → 마진 = 40 bps (충분, slippage 흡수 가능)
- 30 bps 임계값 → 마진 = 20 bps (slippage 변수 큰 시장에선 위험)

## 2. 아키텍처

### 2.1 모듈 구조

#### 신규 파일

| 경로 | 역할 |
|------|------|
| `src/services/exchange/exchange-client.ts` | `ExchangeClient` 인터페이스 (거래소 추상화) |
| `src/services/exchange/upbit-client.ts` | Upbit 어댑터 (기존 `UpbitService` wrap, 인터페이스 구현) |
| `src/services/exchange/bithumb-client.ts` | **Bithumb private API** (auth, accounts, place_order, get_order) |
| `src/services/cross-exchange-spread-gate.ts` | 50 bps 임계값 게이트 (PR H spread-gate 패턴) |
| `src/services/cross-exchange-precheck.ts` | depeg + liquidity + balance + spread + dailyLimit 5단계 사전 검사 |
| `src/services/cross-exchange-executor.ts` | LegA → LegB sequential 실행 + P&L 계산 |
| `src/services/cross-exchange-reconciliation.service.ts` | 양 거래소 done order vs DB FILLED row 비교 |
| `src/agents/cross-exchange-arb-agent.ts` | 매 5초 사이클 봇 평가 + 실행 |
| `src/controllers/stablecoin-admin.controller.ts` (수정) | Cross-exchange bot CRUD 4개 + verify endpoint |
| `src/routes/stablecoin-admin.ts` (수정) | 신규 라우트 등록 |

#### Frontend 신규/수정

| 경로 | 변경 |
|------|------|
| `app/admin/stablecoin/_components/CrossExchangeBotPanel.tsx` | 신규 — Maker-Taker 패널과 같은 페이지에 추가 카드 그룹 |
| `app/admin/stablecoin/_components/EditCrossExchangeBotDialog.tsx` | 신규 — bot CRUD UI |
| `app/admin/stablecoin/_components/CrossExchangeReconciliationDialog.tsx` | 신규 — 🔍 Verify 결과 표시 |
| `lib/api.ts` | `CrossExchangeArbBot` 타입 + API 함수 |

### 2.2 데이터 모델 (Prisma 신규)

```prisma
// prisma-stablecoin/schema.prisma

model CrossExchangeArbBot {
  id                Int       @id @default(autoincrement())
  userId            Int
  coin              String    // "USDE" | "USD1" | "USDS" 등
  targetDirection   String    // "UB" | "BU" — bot 이 노리는 방향
  quantity          Int       // 1회 거래 수량 (코인 단위)
  minSpreadBps      Int       @default(50)
  enabled           Boolean   @default(false)
  killSwitch        Boolean   @default(false)
  // 안전장치 임계값
  depegMinKrw       Int       @default(1380)  // depegGuard 하한
  depegMaxKrw       Int       @default(1420)  // depegGuard 상한
  liquidityMultiplier Float   @default(1.5)   // top-of-book qty >= quantity * 이 값
  dailyCountLimit   Int       @default(5)
  dailyLossLimitKrw Int       @default(50000)
  // 추적
  lastResumeAt      DateTime?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
  trades            CrossExchangeArbTrade[]
}

model CrossExchangeArbTrade {
  id                  BigInt    @id @default(autoincrement())
  botId               Int
  bot                 CrossExchangeArbBot @relation(fields: [botId], references: [id])
  direction           String    // "UB" | "BU"
  spreadBpsAtPlacement Int

  // Leg A (먼저 매수 또는 매도)
  legAExchange        String    // "upbit" | "bithumb"
  legASide            String    // "buy" | "sell"
  legAOrderId         String?
  legAFilledQty       Decimal?  @db.Decimal(24, 8)
  legAAvgPrice        Decimal?  @db.Decimal(18, 4)
  legAFeeKrw          Decimal?  @db.Decimal(18, 4)

  // Leg B (반대 거래)
  legBExchange        String
  legBSide            String
  legBOrderId         String?
  legBFilledQty       Decimal?  @db.Decimal(24, 8)
  legBAvgPrice        Decimal?  @db.Decimal(18, 4)
  legBFeeKrw          Decimal?  @db.Decimal(18, 4)

  profitKrw           Decimal?  @db.Decimal(18, 4)
  status              String    // "FILLED" | "LEG_A_FAILED" | "LEG_B_FAILED" | "PENDING"
  failureReason       String?

  createdAt           DateTime  @default(now())
  completedAt         DateTime?

  @@index([botId, createdAt])
  @@index([status])
  @@map("cross_exchange_arb_trades")
}
```

마이그레이션: `prisma-stablecoin/migrations/<timestamp>_add_cross_exchange_arb/`

## 3. Components 상세

### 3.1 `ExchangeClient` interface

```ts
export interface OrderbookTop {
  bid: number;       // 최우선 매수호가 (KRW)
  ask: number;       // 최우선 매도호가
  bidQty: number;    // 매수 수량
  askQty: number;    // 매도 수량
  timestamp: number;
}

export interface PlacedOrder {
  orderId: string;
  status: 'pending' | 'filled' | 'partial' | 'cancelled' | 'failed';
  filledQty?: number;
  avgFillPrice?: number;
  totalFeeKrw?: number;
}

export interface ExchangeClient {
  exchangeName: 'upbit' | 'bithumb';
  getOrderbookTop(symbol: string): Promise<OrderbookTop | null>;
  getBalances(): Promise<Record<string, { available: number; locked: number }>>;
  placeMarketOrder(side: 'buy' | 'sell', symbol: string, quantity: number): Promise<PlacedOrder>;
  getOrder(orderId: string): Promise<PlacedOrder>;
}
```

### 3.2 `BithumbClient` (가장 큰 신규)

#### 인증
- HMAC SHA512 서명: `endpoint + chr(0) + body + chr(0) + nonce` 를 secret key 로 서명
- Headers: `Api-Key`, `Api-Sign` (base64), `Api-Nonce` (현재 ms timestamp)

#### Endpoints
| 기능 | endpoint | method |
|------|----------|--------|
| 잔고 조회 | `/info/balance` | POST |
| 시장가 매수 | `/trade/market_buy` | POST |
| 시장가 매도 | `/trade/market_sell` | POST |
| 주문 상세 | `/info/order_detail` | POST |
| 호가 조회 (public) | `/public/orderbook/{symbol}_KRW` | GET (기존 `bithumb-price-manager.ts` 재사용) |

#### Error 매핑
| Bithumb code | 의미 | 처리 |
|--------------|------|------|
| 5100 | 잘못된 요청 | AppError 400 |
| 5300 | 인증 실패 / nonce 중복 | AppError 401 |
| 5500 | 잔고 부족 | AppError 400 (placement 직전 reject — precheck miss 시 발생) |
| 5600 | 주문 처리 중 | retry 1회 |
| 기타 | unknown | AppError 500 |

#### Rate limit
- private API: 약 10 req/s — 순차 호출, 별도 queue 미구현 (캐너리 빈도 5초 cycle * 2봇 = 0.4 req/s 면 충분)

### 3.3 `CrossExchangeSpreadGate`

```ts
export interface SpreadGateResult {
  ok: boolean;
  spreadBps: number;
  reason?: string;
}

export function isSpreadProfitable(
  snapshot: { upbitBid: number; upbitAsk: number; bithumbBid: number; bithumbAsk: number },
  direction: 'UB' | 'BU',
  minSpreadBps: number
): SpreadGateResult {
  const spreadBps = direction === 'UB'
    ? Math.floor((snapshot.upbitBid / snapshot.bithumbAsk - 1) * 10000)
    : Math.floor((snapshot.bithumbBid / snapshot.upbitAsk - 1) * 10000);

  if (spreadBps < minSpreadBps) {
    return { ok: false, spreadBps, reason: `spread ${spreadBps} bps < min ${minSpreadBps}` };
  }
  return { ok: true, spreadBps };
}
```

순수 함수. 봇별 minSpreadBps 컬럼 사용.

### 3.4 `CrossExchangePrecheck` — 5단계 순서

```ts
function runAll(args): { ok: boolean; abortReason?: string }
```

순서 (첫 fail 즉시 abort):
1. **spreadGate**: spreadBps >= bot.minSpreadBps
2. **depegGuard**: 양 거래소 mid 가격 (bid+ask)/2 가 depegMin~depegMax KRW 안 (양쪽 다 통과 해야)
3. **liquidity**: 양쪽 top-of-book bidQty/askQty >= quantity * liquidityMultiplier
4. **balance**: legA 사이드 자금 (예: UB 면 Upbit KRW), legB 사이드 자금 (Bithumb USDE) 충분
5. **dailyLimit**: 오늘 봇별 trade 카운트 < dailyCountLimit, 누적 손실 < dailyLossLimitKrw

### 3.5 `CrossExchangeExecutor`

```ts
async function execute(
  bot: CrossExchangeArbBot,
  direction: 'UB' | 'BU',
  snapshot: OrderbookSnapshot,
  upbitClient: ExchangeClient,
  bithumbClient: ExchangeClient
): Promise<{ status, legA, legB, profitKrw, failureReason? }>
```

순서 (Q6=A Sequential + No Fallback):
1. trade row PENDING 으로 insert (DB)
2. legA placement (시장가)
3. legA polling (max 5초, 100ms 간격) → FILLED 확인
4. legA 실패/timeout → status=`LEG_A_FAILED` + 종료 (자금 영향 0 또는 cancel 시도)
5. legB placement (반대 거래소 반대 사이드)
6. legB polling (max 5초)
7. **legB 실패/timeout → status=`LEG_B_FAILED` + autoKillSwitch ON + alarm log + 종료**
8. 양쪽 FILLED → P&L 계산: `profitKrw = legAKrw - legBKrw - fees` (또는 BU 시 부호 반대)
9. trade row update FILLED + completedAt

### 3.6 `CrossExchangeArbAgent`

cycle = 5초.

```
onCycle():
  if (isPaused) return;
  bots = await prisma.crossExchangeArbBot.findMany({
    where: { enabled: true, killSwitch: false }
  });
  for (const bot of bots) {
    // 잔고 race 방지 위해 순차 처리
    await processBot(bot);
  }
```

`processBot`:
1. 양 거래소 호가 동시 조회 (Promise.all)
2. precheck.runAll() → abort 시 logSkip
3. executor.execute() → trade 기록
4. (실패 시 autoKillSwitch 처리는 executor 내부에서)

### 3.7 `CrossExchangeReconciliation`

PR H 의 `MakerTakerAssetReconciliation` 패턴 답습.

```ts
async function reconcile(botId: number): Promise<ReconciliationReport>
```

- 봇 lastResumeAt 이후 양 거래소 done order 조회
- DB FILLED row 와 비교 (legA / legB 양쪽)
- 차이 발견 시 isReconciled=false + diff 표시
- pageTruncated 처리 (양 거래소 페이징 한계 100건)

## 4. Data Flow

(§3 참조)

## 5. Error Handling

### 5.1 케이스별 처리 매트릭스

| 케이스 | 처리 | 자금 영향 |
|--------|------|----------|
| Precheck fail | logSkip, 다음 봇 | 0 |
| LegA fail | logFAIL, abort | 0 |
| LegA timeout | order cancel + logFAIL | 0 (cancel 성공) |
| **LegB fail** | **autoKillSwitch ON + alarm** | **partial — legA 만 fill** |
| LegB timeout | order cancel + autoKillSwitch ON | partial |
| API 5xx | retry 1회 → fail 시 abort | 0 |
| Rate limit (429) | abort + 다음 cycle | 0 |
| Daily loss > limit | enabled=false 자동 | 누적 |
| Depeg trigger | placement 중단 (skip) | 0 |
| Single-leg failure | autoKillSwitch (1건 즉시) | partial |

### 5.2 Single-leg failure 사후 절차

1. autoKillSwitch ON
2. Admin UI alarm
3. 사용자: 양 거래소 거래내역 확인 → 수동 정리
4. 정리 후: ✏️ Edit → killSwitch OFF → 재가동

## 6. Testing 전략

### 6.1 단위 테스트 (TDD)

| 파일 | 시나리오 |
|------|---------|
| `cross-exchange-spread-gate.test.ts` | UB/BU 양방향, bps 5/10/30/50/100/-10 6 케이스 |
| `cross-exchange-precheck.test.ts` | 5단계 fail 시나리오 + 단계 순서 보장 |
| `bithumb-client.test.ts` | HMAC 서명 검증, error code 매핑, mock axios 응답 |
| `cross-exchange-executor.test.ts` | LegA fail / LegB fail / 양쪽 success / timeout 4 케이스 |
| `cross-exchange-reconciliation.test.ts` | 정합/불일치/pageTruncated 케이스 |

### 6.2 통합 테스트

| 파일 | 검증 |
|------|------|
| `cross-exchange-arb-agent.test.ts` | mock prisma + mock client → 봇 순차 처리, killSwitch 적용 |

### 6.3 회귀 (기존 보호)

- 기존 6 에이전트 테스트 통과
- Maker-Taker 봇 (Stage 3) 영향 없음

### 6.4 캐너리 = 실 E2E

Stage 1 24h 가동 = 실질적 E2E. 단위/통합 통과 + 캐너리 검증 = 안전성 충분.

## 7. 캐너리 단계

### Stage 1 (이번 spec 범위)

| 항목 | 값 |
|------|-----|
| 봇 | USDE BU + USD1 UB |
| quantity | 10 (각 봇) |
| daily limit | 5건 (각 봇) |
| minSpreadBps | 50 |
| 모든 안전장치 | ON (default) |
| 관찰 기간 | 24h |

### Stage 1 → 2 Exit 기준 (전부 ✅ 시 승급 검토)

- [ ] FILLED ≥ 5건 (전체)
- [ ] Net profit ≥ 0 KRW
- [ ] Single-leg failure = 0건
- [ ] Depeg / daily limit auto-trigger = 0건
- [ ] Reconciliation isReconciled=true (양 봇 둘 다)

### Stage 2 (별도 spec)

- quantity = 20, daily limit = 30
- minSpreadBps = 50 유지 또는 30 검토
- 24-48h 관찰

### Stage 3 (별도 spec)

- 풀 가동 (단일 최선 코인)

## 8. 사전 자금 요건

### Bithumb 입금 필요

- USDE: 50개 (Stage 1 5거래/일 × 양일 마진)
- USD1: 50개
- KRW: 200,000 (양쪽 매수용 여유)
- **총 약 34만원 Bithumb 입금**

### Upbit (현재 잔고 조회 후 부족 시 보충)

- USDE: 50+
- USD1: 50+
- KRW: 200,000+

### Bithumb API 키

- 권한: 잔고 조회 + 시장가 주문
- **출금 권한 부여 금지** (보안)

## 9. 위험 매트릭스

| 위험 | 가능성 | 영향 | 완화 |
|------|--------|------|------|
| LegB fail 발생 | 중간 | 단일거래 손실 (slippage) | autoKillSwitch + 수동 reconciliation |
| Bithumb API 인증 에러 (nonce 중복) | 낮음 | placement 실패 (자금 영향 0) | nonce 정확성 + retry 1회 |
| Bithumb 호가창 얕음 (slippage) | 중간 | 50 bps 마진 침식 | liquidity precheck (qty * 1.5) |
| USDE depeg 사건 | 매우 낮음 | placement 중단 (자금 영향 0) | depegGuard 1380~1420 KRW |
| 캐너리 24h FILLED 0건 | 중간 | 운영 의미 없음 | 결과 분석 → 임계값 조정 (Stage 1.5 검토) |
| 양 거래소 rate limit hit | 낮음 | placement skip | 5초 cycle + 순차 호출 |
| 봇 잔고 race condition | 낮음 | placement reject | balance precheck + 봇 순차 처리 |
| 사용자 수동 리밸런싱 빈도 과다 | 중간 | 운영 부담 | 양봇 동시 운영 (자금 흐름 반대) → 자연 균형 |

## 10. 구현 순서 (rough plan)

이번 spec 의 plan 단계에서 task 분해:

1. Prisma 스키마 + 마이그레이션 (CrossExchangeArbBot + CrossExchangeArbTrade)
2. ExchangeClient 인터페이스 + UpbitClient (기존 wrap)
3. BithumbClient (가장 큰 신규, 단위 테스트 forefront)
4. CrossExchangeSpreadGate (TDD 순수 함수)
5. CrossExchangePrecheck (TDD 5단계)
6. CrossExchangeExecutor (TDD 4 케이스)
7. CrossExchangeReconciliationService
8. CrossExchangeArbAgent + agent-manager 등록
9. Controller + routes (CRUD + verify)
10. Frontend lib/api.ts 확장
11. CrossExchangeBotPanel + EditDialog + ReconciliationDialog
12. agent-manager 통합 + 기존 회귀 테스트
13. PR + 머지 + 배포
14. (별도 작업) Stage 1 가동 runbook (PR H 패턴 답습)

총 약 14-16 task. PR H 규모와 비슷.

## 11. 참고

- 관련 메모리: `project_canary_stage_2_complete_2026_04_30.md` (maker-taker Stage 2 학습)
- 관련 메모리: `project_pr_h_canary_stage_3_readiness_pushed_2026_04_30.md` (PR H 안전장치 패턴)
- 관련 spec: `2026-04-26-stablecoin-trading-routing-design.md` (당시 빗썸 미포함 결정 — 본 spec 으로 보강)
- 관련 코드: `src/services/bithumb-price-manager.ts` (public API 가격 조회 — 재사용)
- 관련 코드: `src/agents/cross-exchange-observer-agent.ts` (관찰자 — 영향 없음)
- 데이터: `cross_exchange_snapshots` 테이블 5일치 (302,355 row, 본 spec 결정 근거)

## 12. 후속 spec/plan (이번 범위 밖)

- Stage 2 캐너리 (quantity 2배)
- Stage 3 풀 가동
- 자동 리밸런싱 (출금/입금 자동화 — 보안 검토 필요)
- 다른 거래소 추가 (Coinone, Binance 등) — `ExchangeClient` 추상화 활용
