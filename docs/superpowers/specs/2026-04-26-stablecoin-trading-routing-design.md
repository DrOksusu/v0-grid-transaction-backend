# 스테이블코인 통합 트레이딩 (직접 아비트리지 + Maker-Taker Live) 설계서

> 날짜: 2026-04-26
> 작성: Claude (세션 10)
> 상태: 사용자 brainstorming 승인 → spec 검토 대기
> 관련: M3 (실거래 executor) 진입. 세션 9~10 진단으로 M2 시스템(WS/listener/evaluate/DB) 정상 확정 후 다음 단계.

## 1. 개요

Upbit 5종 스테이블코인(USDT/USDC/USD1/USDS/USDE) **단일 거래소 내** 통합 트레이딩 시스템 구현.

### 1.1 한 줄 요약

호가 update마다 **직접 아비트리지 기회 우선 탐색**, 없으면 Maker-Taker live 주문 운영. 두 전략이 메모리 lock으로 잔고 충돌 방지.

### 1.2 핵심 결정 (Brainstorming 결과)

| Q | 결정 |
|---|---|
| Q1 범위 | Upbit 5종 단일 거래소만. 빗썸 미포함 (관찰만 유지) |
| Q2 routing | 순차: 직접 아비트리지 우선, 없을 때만 maker. 직접 실행 중에는 maker 신규 PENDING 일시 중단 |
| Q3a 코인 풀 | 5종 모두 (USDT/USDC/USD1/USDS/USDE) |
| Q3b maker 봇 | 시드 5개 + admin UI로 CRUD |
| Q4 canary | 설계서 §"M3 초기값" 단계 (Stage 1=10000원/일3건 → 50000원/일30건) |

### 1.3 기존 시스템과의 관계

- **유지**: M2 detection (StablecoinArbAgent), Maker-Taker 시뮬 (live=false 봇), CrossExchangeObserver (관찰)
- **확장**: agent에 live=true 분기 추가 → 실거래 executor 호출
- **비파괴**: 기존 시뮬 데이터 보존 (`MakerTakerSimBot.live` 기본 false), 기존 봇 enable로 시뮬 계속

## 2. 아키텍처

### 2.1 모듈 구조

#### 새 파일

| 경로 | 역할 |
|---|---|
| `src/services/stablecoin-arb-executor.ts` | 직접 아비트리지 Leg-1/Leg-2/fallback 실행 |
| `src/services/maker-taker-live-executor.ts` | live maker 주문 + Upbit polling + taker leg |
| `src/services/stablecoin-pre-check.ts` | killSwitch / dailyLimit / dailyLossLimit / depeg / depthAndBalance 5단계 검사 (순수 함수) |
| `src/services/stablecoin-trading-lock.ts` | 메모리 mutex (process-local, 30s timeout) |

#### 기존 파일 수정

| 경로 | 변경 |
|---|---|
| `src/agents/stablecoin-arb-agent.ts` | bot.live=true이면 executor 호출, 그 외 기존 detection |
| `src/agents/maker-taker-simulator-agent.ts` | bot.live=true이면 liveExecutor.processBot, 그 외 기존 simulator.processBot |
| `prisma-stablecoin/schema.prisma` | live, makerOrderUuid, paidFeeKrw, legAStatus, legBStatus 필드 추가 |
| `src/controllers/stablecoin-admin.controller.ts` | maker bot CRUD 4개 + Stage 승급 + live 토글 endpoint |
| `v0-grid-transaction-frontend/app/admin/stablecoin/_components/*` | Stage/live UI + maker bot CRUD UI + auto kill switch alert |

### 2.2 데이터 흐름 (호가 update 1회당)

```
Upbit WS orderbook update
  ↓
upbit-price-manager: cache 갱신 + listener 전파
  ↓
StablecoinArbAgent.evaluate():
  1. 활성 봇 조회 (enabled=true, killSwitch=false)
  2. 봇별:
     a. preCheck.runAll(bot, books, balance, recentTrades) → ok / abort(reason)
     b. abort → logOpportunity(skipReason) → 다음 봇
     c. opp = findBestOpportunity(books, coinsEnabled, threshold)
     d. opp 없음 → 다음 봇
     e. bot.live === false → logOpportunity(executed=false, skipReason='detection_only') → 다음 봇
     f. bot.live === true:
        if (!tradingLock.tryAcquire('arb-bot-' + bot.id)) → skip (다음 update에)
        try {
          result = await executor.executeArbitrage(opp, bot, balance, creds)
          logOpportunity + Trade 기록 (FILLED/FAILED/ROLLED_BACK)
          updateBotStats(totalTrades, totalProfitUsd, lastExecutedAt)
        } finally {
          tradingLock.release('arb-bot-' + bot.id)
        }
  ↓ (병렬, 동일 호가 update에서)
MakerTakerSimulatorAgent.evaluate():
  1. 활성 봇 조회 (enabled=true, killSwitch=false)
  2. 봇별:
     a. bot.live === false → 기존 simulator.processBot (변경 없음)
     b. bot.live === true → liveExecutor.processBot:
        - PENDING 없음:
          if (tradingLock.isLocked()) → skip (신규 차단)
          preCheck.runAll → ok면 placeMakerOrder → DB PENDING (live=true, makerOrderUuid set)
        - PENDING 있음:
          status = await UpbitService.getOrder(uuid)
          if filledQty>0:
            executeTakerLeg (qty 비율로 축소된 best+ioc) → DB FILLED + P&L
          else if elapsed > maxPendingMs:
            cancelOrder → DB EXPIRED
          else: 대기
```

## 3. 직접 아비트리지 Executor

### 3.1 함수 시그니처

```ts
export async function executeArbitrage(
  opp: ArbOpportunity,
  bot: StablecoinArbBot,
  balance: Record<string, number>,
  creds: ExchangeCredentials,
): Promise<ExecutorResult>;

export type ExecutorResult =
  | { ok: true; net: number; legA: LegResult; legB: LegResult }
  | { ok: false; reason: string; rolledBack?: boolean; legA?: LegResult; legB?: LegResult };
```

### 3.2 흐름

```
1. 거래량 결정:
   qtyByDepth = min(opp.bidSoldSize, opp.askBoughtSize)
   qtyByBudget = bot.tradeSizeKrw / opp.askBoughtKrw
   qty = min(qtyByDepth, qtyByBudget)
   if qty < MIN_QTY → abort('qty too small')

2. Trade row 생성 (status=PENDING, legAStatus=PENDING, legBStatus=PENDING):
   stablecoinArbTrade.create({ botId, soldCoin, boughtCoin, qty,
     expectedSpreadBps: opp.spreadBps, status:'PENDING' })

3. Leg-1: best+ioc 매도 X (KRW-X):
   resp = await UpbitService.placeBestIoc(creds, 'sell', `KRW-${opp.soldCoin}`, qty)
   filledQtyL1 = parseFloat(resp.executed_volume)
   filledKrwL1 = (resp.trades || []).reduce((s,t) => s + parseFloat(t.funds), 0)
   paidFeeL1 = parseFloat(resp.paid_fee || '0')
   if filledQtyL1 === 0:
     update Trade(status='FAILED', legAStatus='FAILED')
     return { ok:false, reason:'leg-1 zero fill' }

4. Leg-2: best+ioc 매수 Y (KRW-Y), 받은 KRW로:
   buyKrw = filledKrwL1 - paidFeeL1
   // 부분 체결 처리: leg-1이 일부만 체결됐으면 leg-2도 그 비율로 (qty가 작아짐)
   resp2 = await UpbitService.placeBestIoc(creds, 'buy', `KRW-${opp.boughtCoin}`, buyKrw)
   filledQtyL2 = parseFloat(resp2.executed_volume)
   filledKrwL2 = (resp2.trades || []).reduce((s,t) => s + parseFloat(t.funds), 0)
   paidFeeL2 = parseFloat(resp2.paid_fee || '0')
   if filledQtyL2 === 0:
     // fallback: 받은 KRW로 X 재매수 (원위치 복구)
     resp3 = await UpbitService.placeBestIoc(creds, 'buy', `KRW-${opp.soldCoin}`, buyKrw)
     update Trade(status='ROLLED_BACK', legAStatus='FILLED',
                  legBStatus='FAILED', notes='leg-2 zero, fallback to X')
     return { ok:false, reason:'leg-2 failed, recovered to X', rolledBack:true }

5. P&L 계산 (두 값 모두 DB 기록, 본 spec은 markToMarketNet을 주 net으로 채택):

   midPriceX = (books[KRW-X].bid.price + books[KRW-X].ask.price) / 2  // 실행 직전 mid
   midPriceY = (books[KRW-Y].bid.price + books[KRW-Y].ask.price) / 2

   // (가) KRW flow net — 단순 KRW 입출력 차 (자산 변환 무시, 보조 통계)
   krwFlowNet = filledKrwL1 - filledKrwL2 - paidFeeL1 - paidFeeL2
              ≈ -(paidFeeL1 + paidFeeL2)  // L1 = L2 + 수수료라 거의 음수

   // (나) Mark-to-market net — 자산 변환 가치 포함 (주 net)
   markToMarketNet = filledQtyL2 * midPriceY - filledQtyL1 * midPriceX
                   - (paidFeeL1 + paidFeeL2)

   // (다) 실현 spread — 슬리피지 0 가정 (방식 A의 보고용)
   realizedSpreadBps = Math.floor((opp.bidSoldKrw / opp.askBoughtKrw - 1) * 10000)

6. Trade 업데이트:
   update Trade(status='FILLED', legAStatus='FILLED', legBStatus='FILLED',
                executedAt=now, qtyL1=filledQtyL1, qtyL2=filledQtyL2,
                krwL1=filledKrwL1, krwL2=filledKrwL2,
                paidFeeKrw=paidFeeL1+paidFeeL2,
                realizedSpreadBps,
                netProfitKrw=markToMarketNet,    // 주 net
                krwFlowNetKrw=krwFlowNet)        // 보조 통계 컬럼 (DB 추가)
   update Bot(totalTrades++,
              totalProfitUsd += markToMarketNet / UsdKrwRate,
              lastExecutedAt=now)
   return { ok:true, net: markToMarketNet, legA, legB }
```

### 3.3 M1 검증으로 확정된 Upbit 응답 파싱 (재발 방지)

- **성공 판정**: `parseFloat(executed_volume) > 0` (state는 매수=cancel/매도=done — 둘 다 정상)
- **KRW 합산**: `(trades || []).reduce((s,t) => s + parseFloat(t.funds), 0)` (`executed_funds` 최상위 필드 없음)
- **수수료**: `parseFloat(paid_fee || '0')` (USD1은 0% 가정 검증 필요)

## 4. Maker-Taker Live Executor

### 4.1 함수 시그니처

```ts
export async function processLiveBot(
  bot: MakerTakerSimBot,
  books: ReadonlyMap<string, OrderbookTop>,
  creds: ExchangeCredentials,
): Promise<void>;
```

### 4.2 흐름

```
pending = await prisma.makerTakerSimTrade.findFirst({
  where: { botId, status: 'PENDING' },
  orderBy: { createdAt: 'desc' },
})

// CASE A: PENDING 없음 → 새 maker 주문
if (!pending):
  if (tradingLock.isLocked()) return  // 직접 아비트리지 중 신규 차단
  preCheckResult = preCheck.runAll(bot, ...) → ok / abort
  if abort: return

  makerBook = books.get(`KRW-${bot.makerCoin}`)
  makerPrice = makerBook.bid.price + bot.bidOffsetKrw  // 시뮬과 동일 계산
  qty = bot.quantity

  resp = await UpbitService.placeLimitOrder(
    creds, 'buy', `KRW-${bot.makerCoin}`, makerPrice, qty, /*postOnly=true*/
  )
  if (!resp.uuid):
    return  // 주문 실패 (수수료 부족 등) → 다음 호가 update에서 재시도

  await prisma.makerTakerSimTrade.create({
    botId, makerCoin, takerCoin, makerOrderPrice: makerPrice,
    quantity: qty, status: 'PENDING',
    makerOrderUuid: resp.uuid,
    live: true,
    notes: `live order placed at ${makerPrice}`,
  })
  return

// CASE B: PENDING 있음
if (!pending.live):
  // 기존 시뮬 흐름 그대로 (변경 없음)
  return await simulator.processBot(bot, books)

// live PENDING → Upbit 상태 polling
status = await UpbitService.getOrder(creds, pending.makerOrderUuid)
filledQty = parseFloat(status.executed_volume || '0')
elapsed = Date.now() - pending.createdAt.getTime()

if (filledQty > 0):
  // (부분 체결 포함) maker leg 체결 → taker leg 즉시 실행 (옵션 나: X→Y 변환)
  filledMakerKrw = (status.trades || []).reduce((s,t) => s + parseFloat(t.funds), 0)
  paidFeeMaker = parseFloat(status.paid_fee || '0')

  // 옵션 (나): X를 takerCoin Y로 변환 = X 매도(best+ioc) → 받은 KRW로 Y 매수(best+ioc)
  // X와 Y 모두 KRW 페어이므로 두 단계 필요 (Upbit에 직접 X-Y 페어 없음).

  // taker step 1: X best+ioc 매도 → KRW 회수
  sellResp = await UpbitService.placeBestIoc(
    creds, 'sell', `KRW-${bot.makerCoin}`, filledQty
  )
  filledSellKrw = (sellResp.trades || []).reduce((s,t) => s + parseFloat(t.funds), 0)
  paidFeeSell = parseFloat(sellResp.paid_fee || '0')
  filledSellQty = parseFloat(sellResp.executed_volume || '0')

  if (filledSellQty === 0):
    // X 매도 실패 → maker로 산 X 그대로 보유 (잔고 누적). 다음 직접 arb로 활용 위임
    update PENDING → status='PARTIAL_HOLD'
            (notes='maker filled, taker sell failed, holding X')
    return

  // taker step 2: 받은 KRW로 Y best+ioc 매수
  buyKrw = filledSellKrw - paidFeeSell
  buyResp = await UpbitService.placeBestIoc(
    creds, 'buy', `KRW-${bot.takerCoin}`, buyKrw
  )
  filledBuyKrw = (buyResp.trades || []).reduce((s,t) => s + parseFloat(t.funds), 0)
  paidFeeBuy = parseFloat(buyResp.paid_fee || '0')
  filledBuyQty = parseFloat(buyResp.executed_volume || '0')

  if (filledBuyQty === 0):
    // Y 매수 실패 → 받은 KRW를 다시 X로 환원 (원위치)
    fallbackResp = await UpbitService.placeBestIoc(
      creds, 'buy', `KRW-${bot.makerCoin}`, buyKrw
    )
    update PENDING → status='ROLLED_BACK'
            (notes='taker buy failed, recovered to X')
    return

  // P&L: KRW flow 기준 net (보유 자산 X→Y 변환의 mark-to-market)
  totalFee = paidFeeMaker + paidFeeSell + paidFeeBuy
  // 자산 가치: maker로 X buyKrw spent, 결과 Y filledBuyQty 보유
  // 단순 KRW flow: 매도로 받은 KRW(filledSellKrw) - 매수에 쓴 KRW(filledBuyKrw)는 거의 0
  //   (둘 다 같은 buyKrw 근처). spread는 자산 변환 가치에 반영.
  // 단순화 보고용 net (KRW 기준):
  //   net = filledSellKrw - filledMakerKrw - totalFee
  //       = (X 매도로 받은 KRW) - (maker로 X 산 KRW) - 수수료 합
  //       이 값은 X 매도 시점 best bid가 maker 주문가보다 위면 양수
  netProfitKrw = filledSellKrw - filledMakerKrw - totalFee
  realizedSpreadBps = Math.floor(
    (filledSellKrw / filledMakerKrw - 1) * 10000
  )

  await prisma.makerTakerSimTrade.update({
    where: { id: pending.id },
    data: {
      status: 'FILLED',
      makerFilledAt: now, makerFilledPrice: pending.makerOrderPrice,
      takerExecutedAt: now,
      takerMarketBid: filledSellKrw / filledSellQty,
      grossProfitKrw: filledSellKrw - filledMakerKrw,
      feeKrw: totalFee,
      paidFeeKrw: totalFee,
      netProfitKrw,
      realizedSpreadBps,
      notes: (pending.notes ?? '') +
             ` | LIVE FILLED sell=${filledSellKrw} buy=${filledBuyKrw} fees=${totalFee} net=${netProfitKrw.toFixed(2)}`,
    },
  })
  return

// fill 안 됨 + 만료
if (elapsed > bot.maxPendingMs):
  await UpbitService.cancelOrder(creds, pending.makerOrderUuid)
  await prisma.makerTakerSimTrade.update({
    where: { id: pending.id },
    data: { status: 'EXPIRED', notes: (pending.notes ?? '') + ' | LIVE expired, cancelled' },
  })
  return

// else: 계속 대기 (다음 호가 update에서 재polling)
```

### 4.3 부분 체결 처리

- maker order의 부분 체결: filledQty가 quantity 미만이어도 즉시 takerLeg 실행 (filledQty만큼만)
- 남은 remainingQty는 Upbit가 계속 limit order로 들고 있음 → 다음 호가 update에서 status가 더 진행됐으면 추가 처리
- 만료 시 남은 remainingQty 취소

## 5. Pre-check (`stablecoin-pre-check.ts`)

5개 순수 함수 + 통합 `runAll`. 각 단계 단위 테스트 작성.

| # | 함수 | 통과 조건 | 실패 시 skipReason |
|---|---|---|---|
| 1 | `checkKillSwitch(bot)` | `bot.killSwitch === false` | `'killswitch'` |
| 2 | `checkDailyTradeLimit(bot, todayTradeCount)` | `todayTradeCount < bot.maxDailyTrades` | `'daily_limit'` |
| 3 | `checkDailyLossLimit(bot, todayNetProfitKrw)` | `todayNetProfitKrw > -bot.dailyLossLimitKrw` | `'daily_loss_limit'` (auto kill switch trigger) |
| 4 | `checkDepeg(books, coinX, coinY, depegBps)` | X와 Y의 mid-price가 5종 mid-price 중간값 ±depegBps 안 | `'depeg'` |
| 5 | `checkDepthAndBalance(opp, qty, balance)` | `opp.bidSoldSize ≥ qty && opp.askBoughtSize ≥ qty && balance[X] ≥ qty` | `'insufficient'` |

```ts
runAll(bot, opp, books, balance, todayStats): { ok: true } | { ok: false; reason: string }
```

## 6. Trading Lock (`stablecoin-trading-lock.ts`)

```ts
let locked = false;
let holder: string | null = null;
let acquiredAt = 0;
const MAX_HOLD_MS = 30_000;  // deadlock 방어

export const tradingLock = {
  tryAcquire(by: string): boolean {
    // 30초 지난 lock은 강제 해제 (이전 holder가 throw해서 안 풀린 경우)
    if (locked && Date.now() - acquiredAt > MAX_HOLD_MS) {
      console.warn(`[TradingLock] forced release from ${holder} (timeout)`);
      locked = false; holder = null;
    }
    if (locked) return false;
    locked = true; holder = by; acquiredAt = Date.now();
    return true;
  },
  release(by: string): void {
    if (holder === by) { locked = false; holder = null; }
  },
  isLocked(): boolean { return locked; },
};
```

- 직접 executor 호출 try/finally로 release 보장
- maker live의 신규 PENDING 생성만 lock 점유 시 skip (기존 PENDING의 status polling/만료/체결은 무관)

## 7. Auto Kill Switch Trigger

다음 중 하나 발생 → `bot.killSwitch = true` + Socket.IO + push 알림:

1. **3회 연속 leg-2 실패** (rollback 발생). 봇별 in-memory counter, 1회 성공 시 0으로 리셋
2. **일일 손실 한도 도달** (`todayNetProfitKrw ≤ -dailyLossLimitKrw`)
3. **재고 리콘실 편차 ≥ 0.05** (Upbit `accounts` API 응답 잔고 vs DB 기대 잔고 차이, periodic 5분마다 검사)
4. **Upbit API 5xx 또는 타임아웃 5회 연속** (executor 호출 응답)

해제는 admin UI에서 사용자만 수동 (POST `/api/admin/stablecoin/bot/killswitch` body { enable: false }).

## 8. Canary 단계 (사용자 수동 승급)

| Stage | 권장 기간 | tradeSizeKrw | maxDailyTrades | dailyLossLimitKrw | maker bot qty (default) |
|---|---|---|---|---|---|
| **1 (시작)** | 1주 | 10,000 | 3 | 10,000 | 5 |
| **2** | 2주 | 20,000 | 10 | 30,000 | 10 |
| **3** | 이후 | 50,000 | 30 | 50,000 | 20 |

- PR D 머지 시 Stage 1 값으로 봇 1개 + maker 봇 5개 자동 update/seed
- admin UI에 현재 Stage 표시 + "Stage 승급" 버튼 (P&L 흑자 + 거래 ≥ N건 충족 시 활성)
- **첫 24시간 강제 Stage 1 잠금** (서버에서 reject)

## 9. DB 스키마 변경 (`prisma-stablecoin/schema.prisma`)

| 테이블 | 변경 |
|---|---|
| `StablecoinArbBot` | `live: Boolean @default(false)` 추가 (true일 때만 executor 호출) |
| `StablecoinArbTrade` | `legAStatus`, `legBStatus` (`'PENDING'\|'FILLED'\|'PARTIAL'\|'FAILED'\|'ROLLED_BACK'`), `paidFeeKrw: Decimal?`, `krwFlowNetKrw: Decimal?` (보조 통계) |
| `MakerTakerSimBot` | `live: Boolean @default(false)` (true=실주문, false=시뮬 유지) |
| `MakerTakerSimTrade` | `makerOrderUuid: String?`, `live: Boolean @default(false)`, `paidFeeKrw: Decimal?`. status enum에 `'PARTIAL_HOLD'` 추가 (live taker step 1 실패 시 X 보유 표시) |

마이그레이션은 `npx prisma migrate dev --create-only` + `tail -10 migration.sql` 검사 (Prisma CLI garbage 트랩 #0 재발 방지) → `migrate deploy`.

## 10. Admin API 추가 (`stablecoin-admin.controller.ts`)

| 메서드 | 경로 | 역할 |
|---|---|---|
| GET | `/api/admin/stablecoin/maker-bots` | 목록 |
| POST | `/api/admin/stablecoin/maker-bots` | 신규 생성 (zod 검증) |
| PATCH | `/api/admin/stablecoin/maker-bots/:id` | 부분 수정 (live 토글 포함) |
| DELETE | `/api/admin/stablecoin/maker-bots/:id` | 삭제 (PENDING 있으면 422 reject) |
| POST | `/api/admin/stablecoin/bot/stage` | StablecoinArbBot Stage 1/2/3 일괄 set + 첫 24h 잠금 |
| POST | `/api/admin/stablecoin/bot/live` | StablecoinArbBot live 토글 (true 전환은 confirm body 필수) |

모두 `requireAdmin` 미들웨어. 응답은 기존 패턴 (Decimal/BigInt → string).

## 11. Admin UI 변경 (`v0-grid-transaction-frontend/app/admin/stablecoin`)

| 컴포넌트 | 변경 |
|---|---|
| `BotStatusCard` | 현재 Stage 표시 + 승급 버튼 + **live 토글 (큰 빨간 confirm dialog)** |
| `MakerTakerSimPanel` | live 봇 빨간 테두리 강조 + CRUD UI (모달 폼) |
| `(신규) AutoKillSwitchAlert` | 페이지 상단 빨간 배너 + 사유 + 해제 버튼 |
| `socket-provider.tsx` | `stablecoin:killswitch_triggered`, `stablecoin:trade_executed` 구독 → toast |

## 12. 테스트 전략 (TDD, 80% 커버리지)

| 종류 | 대상 | 케이스 수 (최소) |
|---|---|---|
| 단위 (순수 함수) | pre-check 5단계 | 각 pass/fail = 10 |
| 단위 | tradingLock | acquire / release / timeout / contention = 4 |
| 단위 (mock Upbit) | arb-executor | leg-1 zero / leg-2 zero+rollback / 부분체결 비율 축소 / 정상 / fee 파싱 = 5 |
| 단위 (mock Upbit) | maker-taker-live-executor | placeMaker / fill polling 부분체결 / 만료 cancel / live=false 분기 = 4 |
| 통합 (mock Upbit + DB) | full flow + lock contention | opp→preCheck→execute→DB 검증 = 3 |
| E2E manual | canary Stage 1 | 사용자 첫 1만원 거래 + 의도적 잔고 부족 mock | 

**모든 mock은 실제 함수 시그니처와 typed match** (세션 9~10 trap #3 재발 방지).

## 13. PR 4단계

| PR | 범위 | 위험도 |
|---|---|---|
| **A** | pre-check + lock + DB schema (live 필드만 add) + 단위 테스트 | 낮음 (실거래 코드 없음) |
| **B** | arb-executor + StablecoinArbAgent 통합 + Admin API/UI | 중 (live=false 기본이라 실행 안 됨) |
| **C** | maker-taker live executor + agent 분기 + maker bot CRUD UI | 중 |
| **D** | canary Stage 1으로 자동 setup + live 토글 활성화 + Stage 승급 흐름 | **고 (실돈 첫 가동)** |

**PR D 머지 직전 AWS Lightsail 수동 스냅샷 필수** (글로벌 안전 규칙).

## 14. 알려진 위험 + 미결정 사항

### 14.1 알려진 위험

1. **첫 실거래 = 실돈 움직임**. canary Stage 1로 한도 1만원/일이지만 코드 버그 있으면 잔고 손실 가능. 머지 전 PR D는 사용자 명시 승인 필수.
2. **Upbit API rate limit**. 호가 update 빈도 ~30건/min × 봇 수만큼 polling 호출. 분당 한도 확인 후 throttle 추가 필요할 수 있음 (PR C 단계에서 측정).
3. **Maker-Taker live의 taker leg 단순화** (X 매도만, Y 매수는 다음 직접 arb에 위임). spread는 maker가 잡고, takerCoin은 다음 호가에서 잡는 구조. 잔고가 한 코인에 누적될 가능성 → 봇별 perCoinMaxUsd 한도로 자동 stop.
4. **자동 kill switch가 잘못 발동** 시 사용자가 모르고 풀어버릴 수 있음. UI에서 사유 + 발동 시각 명시 + 해제 시 confirm.

### 14.2 미결정 (구현 단계에서 결정)

1. UpbitService에 `placeLimitOrder` (post_only) + `getOrder` + `cancelOrder` 함수가 이미 있는지 vs 신규 추가? (PR A에서 확인)
2. `accounts` API 응답 캐싱 정책 (잔고 조회 빈도). 매 evaluate마다 호출하면 rate limit 걸림 → 5초 캐시 + 거래 직후 invalidate?
3. 재고 리콘실 검사 주기 (5분 권장)와 검사 방식 (Trade 누적 vs Upbit 응답 차분)
4. P&L 계산 통합: 본 spec은 직접 arb=`markToMarketNet`, maker-taker live=`krwFlowNet` 형태로 다른 식 사용. 운영 중 두 봇의 P&L이 다른 의미라 비교가 어려움 → PR D 단계 전 통합 식 결정 (둘 다 mark-to-market으로 갈지, 둘 다 KRW flow로 갈지).

## 15. 참조

- 옛 설계서: `Grid_project/docs/superpowers/specs/2026-04-21-stablecoin-arb-design.md` (M3 초기값 표 §"M3 초기값")
- 옛 plan: `Grid_project/docs/superpowers/plans/2026-04-21-stablecoin-arb-plan.md` (Task 10~14 = M3 원안)
- DB 분리 spec: `2026-04-24-stablecoin-arb-db-separation-design.md`
- Maker-Taker 시뮬 spec: `2026-04-24-maker-taker-simulator-design.md` (방식 A 결정 + shouldFill 단순화)
- M1 검증 결과: `Grid_project/docs/superpowers/specs/2026-04-21-m1-findings.md` (USD1 0% 수수료 발견)
- 세션 10 핸드오프: `~/.claude/projects/D--ExpressProject-Grid-project/memory/project_session_10_handoff_2026_04_26.md`
