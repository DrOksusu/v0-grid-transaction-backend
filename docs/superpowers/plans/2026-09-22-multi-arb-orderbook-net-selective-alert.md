# 멀티 거래소 차익 알림 — 호가·깊이·순차익 선별 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** 카톡 "차익후보" 알림을 체결가 기반 → **최우선호가(매도호가 매수/매수호가 매도) + 최소주문 깊이 검증 + 입출금 정상 + 출금수수료 반영 순차익** 기반으로 바꿔 선별 발송한다.

**Architecture:** 60초 사이클. (A) 5개 거래소 호가(bid/ask)를 배치 조회 — KRW권(업/빗)은 depth까지 배치 1콜, USDT권(바낸/MEXC/Gate)은 최우선만. (B) 순서쌍별 실현 스프레드 `(sell.bid − buy.ask)/buy.ask`로 shortlist. (C) 기존 price-sanity + feasibility(네트워크/입출금) 유지. (D) shortlist에 대해 최소주문 규모(KRW 10만/USDT 100) VWAP 깊이 검증 + 거래수수료 + **출금수수료(전송비)** 차감한 **순차익** 계산 → 순차익 ≥ 임계값(기본 1%)만 발송.

**Tech Stack:** Express/TS, axios(public 호가 API), 기존 admin creds(빗썸 출금료·지갑상태), jest.

**사용자 확정 결정(2026-09-22):** ① 순차익 기준 선별 ② 최소주문 KRW 10만/USDT 100 ③ 임계값 1%(env `MULTI_ARB_THRESHOLD_PCT`, 이제 **순차익 %** 의미).

**출금료 가용성:** 바이낸스/MEXC = NetworkStatus.withdrawFee(코인) 있음. 빗썸(매수측일 때) = `getWithdrawFeeInfo`(정액/정률) 있음. **Gate.io·업비트(매수측)= 미제공** → `withdrawFeeKnown=false`, 순차익은 출금료 제외한 추정으로 계산하고 메시지에 "출금료 미확인" 명시.

**실측 확정 응답 형태:**
- 업비트 `GET /v1/orderbook?markets=KRW-A,KRW-B`(청크 ≤100, rate-limit 주의): `[{market, orderbook_units:[{bid_price,bid_size,ask_price,ask_size}×30]}]`
- 빗썸 `GET /public/orderbook/ALL_KRW`(1콜): `{status:'0000', data:{COIN:{bids:[{price,quantity}×5], asks:[{price,quantity}×5]}}}` (asks[0]=최저 매도호가, bids[0]=최고 매수호가)
- 바이낸스 `GET /api/v3/ticker/bookTicker`(심볼 생략=전종목): `[{symbol:'XRPUSDT',bidPrice,bidQty,askPrice,askQty}]`; depth `GET /api/v3/depth?symbol=&limit=20`→`{bids:[[price,qty]],asks:[[price,qty]]}`
- MEXC: 바이낸스와 동일 포맷(`/api/v3/ticker/bookTicker`, `/api/v3/depth`)
- Gate.io `GET /api/v4/spot/tickers`(1콜): `[{currency_pair:'XRP_USDT',highest_bid,lowest_ask,last}]`; depth `GET /api/v4/spot/order_book?currency_pair=&limit=20`→`{bids:[[price,qty]],asks:[[price,qty]]}`

**수수료 상수:** 재사용 `EXCHANGE_FEE_BPS`(candidate-scanner) = {upbit:5,bithumb:5,binance:10,mexc:10}. gateio 추가(20). 순회수수료 = buyFee+sellFee(taker 편도 합, 이미 편도 bps라 buy+sell 합산).

---

## File Structure

- Modify `src/services/multi-arb-types.ts` — `BookTop`(bid/ask/size/levels), `BookMap`, `SpreadCandidate` 확장(askPrice/bidPrice/topSpreadPct), `NetResult` 신규.
- Create `src/services/multi-arb-book-source.service.ts` — 5거래소 호가 배치 조회 → `Partial<Record<ex, BookMap>>`. KRW권은 levels 포함.
- Create `src/services/multi-arb-depth.service.ts` — USDT권 per-symbol depth 조회 + `vwapForNotional` 순수함수(levels·목표금액→체결 VWAP·충족여부).
- Modify `src/services/multi-arb-spread-calculator.ts` — 순서쌍별 `(sell.bid − buy.ask)/buy.ask` 실현 스프레드.
- Create `src/services/multi-arb-net-calculator.ts` — 후보+levels+wallets+출금료 → 최소주문 VWAP 스프레드 − 거래수수료 − 출금료 = netPct(+flags).
- Modify `src/services/multi-exchange-arb-scanner.service.ts` — 파이프라인 재배선.
- Modify `src/services/multi-arb-notifier.service.ts` — 메시지에 실현/순차익%, 검증 규모, 출금료, 네트워크, 스냅샷 주의.
- Modify `src/services/exchange/bithumb-client.ts` — (이미 `getWithdrawFeeInfo` 존재, 재사용).
- Tests: `src/services/__tests__/multi-arb-spread-calculator.test.ts`(갱신), `multi-arb-depth.test.ts`(신규), `multi-arb-net-calculator.test.ts`(신규).

---

## Task 1: 타입 확장 (types)

**Files:** Modify `src/services/multi-arb-types.ts`

- [ ] **Step 1:** 아래 타입 추가/확장.

```typescript
// 호가 한 단계
export interface BookLevel { price: number; qty: number; }

// 거래소 1곳 코인 1개의 호가 (최우선 + 선택적 depth levels)
export interface BookTop {
  ask: number;      // 최저 매도호가 (여기에 매수 = 내가 지불)
  bid: number;      // 최고 매수호가 (여기에 매도 = 내가 수취)
  askLevels?: BookLevel[]; // 오름차순(낮은 ask 먼저). 배치로 얻은 경우만(KRW권)
  bidLevels?: BookLevel[]; // 내림차순(높은 bid 먼저)
}
export type BookMap = Map<string, BookTop>;

// 최소주문 규모(순차익 계산용). KRW권=원, USDT권=USDT.
export const MIN_NOTIONAL_BY_ZONE: Record<CurrencyZone, number> = { KRW: 100000, USDT: 100 };

// 순차익 계산 결과
export interface NetResult {
  filledNotional: number;   // 최소주문 규모까지 실제 채운 금액(양쪽 min)
  depthOk: boolean;         // 최소주문 규모를 양쪽 호가가 커버했는가
  buyVwap: number;          // 매수측 체결 VWAP(지불 단가)
  sellVwap: number;         // 매도측 체결 VWAP(수취 단가)
  grossSpreadPct: number;   // (sellVwap − buyVwap)/buyVwap*100 (깊이 반영)
  tradingFeePct: number;    // 양쪽 taker 수수료 합 %
  withdrawFeePct: number;   // 출금료 %환산 (미확인=0)
  withdrawFeeKnown: boolean;
  netSpreadPct: number;     // grossSpreadPct − tradingFeePct − withdrawFeePct
}
```

`SpreadCandidate`에 `askPrice: number; bidPrice: number;` 추가하고 기존 `buyPrice/sellPrice`는 각각 매수측 ask·매도측 bid를 담도록 의미 변경(주석 갱신). `spreadPct`는 최우선호가 실현 스프레드로 재정의.

- [ ] **Step 2:** `npx tsc --noEmit` 통과 확인 (다른 파일이 아직 안 맞으면 다음 태스크에서 정합).

## Task 2: 호가 소스 (book-source)

**Files:** Create `src/services/multi-arb-book-source.service.ts`

- [ ] **Step 1:** 5거래소 호가 배치 조회. 업비트/빗썸은 levels 채움, 바낸/MEXC/Gate는 최우선만.
  - `fetchUpbitBooks(symbols)`: `/v1/orderbook?markets=` 100청크. 각 market → `ask=units[0].ask_price, bid=units[0].bid_price, askLevels=units.map(u=>({price:u.ask_price,qty:u.ask_size})), bidLevels=units.map(u=>({price:u.bid_price,qty:u.bid_size}))`.
  - `fetchBithumbBooks()`: `/public/orderbook/ALL_KRW` 1콜. status!=='0000' throw. 각 코인 → asks[0].price/bids[0].price + levels(price/quantity→price/qty). 'date' 키 스킵.
  - `fetchBinanceBooks()`/`fetchMexcBooks()`: `/api/v3/ticker/bookTicker`(전종목) → *USDT만, ask=askPrice, bid=bidPrice(levels 없음).
  - `fetchGateioBooks()`: `/api/v4/spot/tickers` → *_USDT만, ask=lowest_ask, bid=highest_bid(levels 없음).
  - `fetchAllBooks(upbitSymbols)`: Promise.allSettled 5개, 실패 거래소 키 제외(기존 fetchAllPrices와 동일 패턴). 반환 `Partial<Record<MultiArbExchange, BookMap>>`.
  - HTTP_TIMEOUT_MS=10000. 유효성: price>0.

- [ ] **Step 2:** `export const multiArbBookSource = new MultiArbBookSourceService();`

## Task 3: 깊이 서비스 + VWAP (depth)

**Files:** Create `src/services/multi-arb-depth.service.ts`, Test `src/services/__tests__/multi-arb-depth.test.ts`

- [ ] **Step 1(RED):** `vwapForNotional(levels: BookLevel[], targetNotional: number): { vwap: number; filledNotional: number; ok: boolean }` 테스트 작성.
  - levels 순서대로 누적: 각 레벨 price×qty 만큼 금액 소비, targetNotional 채울 때까지. 마지막 레벨은 부분 소비. `ok = filledNotional >= targetNotional*0.999`. vwap = 소비금액합/소비수량합. levels 비면 {vwap:0,filledNotional:0,ok:false}.
  - 케이스: [{price:2000,qty:10}] target 100000(=50개 필요, 20000원어치만 있음) → ok:false, filledNotional:20000. [{price:2000,qty:100}] target 100000 → ok:true, vwap:2000, filled:100000. 2레벨 혼합 VWAP 계산.
- [ ] **Step 2(GREEN):** 구현.
- [ ] **Step 3:** `fetchBinanceDepth/ MexcDepth/ GateioDepth(symbol)` → `{askLevels,bidLevels}`(levels 없는 USDT권 shortlist용). binance/mexc `/api/v3/depth?symbol=${S}USDT&limit=20`, gate `/api/v4/spot/order_book?currency_pair=${S}_USDT&limit=20`. 실패 시 null.
- [ ] **Step 4:** `npx tsc --noEmit` + `jest multi-arb-depth` 통과.

## Task 4: 스프레드 계산 (호가 기준, 순서쌍)

**Files:** Modify `src/services/multi-arb-spread-calculator.ts`, Test `src/services/__tests__/multi-arb-spread-calculator.test.ts`

- [ ] **Step 1(RED):** `calculateSpreads(zone, symbols, books, zoneExchanges)` 갱신 테스트.
  - 입력 `books: Partial<Record<ex, BookMap>>`. 각 심볼: zone 거래소 중 호가 있는 것만 수집.
  - **순서쌍 전수 비교**(min-ask/max-bid 단축 금지): 모든 (buy,sell) 조합에서 `realized=(sell.bid − buy.ask)/buy.ask`, 최대 양수 쌍 채택. buy≠sell, realized>0.
  - 결과 SpreadCandidate: buyExchange/sellExchange, buyPrice=buy.ask, sellPrice=sell.bid, askPrice=buy.ask, bidPrice=sell.bid, spreadPct=realized*100.
  - 케이스: 2거래소 XRP ask/bid로 realized 계산. 한 거래소가 최저 ask+최고 bid 동시 보유 시 그 쌍은 realized≤0이라 제외되고 교차쌍 채택되는지.
- [ ] **Step 2(GREEN):** 구현.
- [ ] **Step 3:** `jest multi-arb-spread-calculator` 통과.

## Task 5: 순차익 계산 (net)

**Files:** Create `src/services/multi-arb-net-calculator.ts`, Test `src/services/__tests__/multi-arb-net-calculator.test.ts`

- [ ] **Step 1(RED):** `computeNet(input)` 테스트. 입력: candidate, buyLevels(ask 오름차), sellLevels(bid 내림차), minNotional, buyFeeBps, sellFeeBps, withdrawFee?({feeCoin?|rate?}|null).
  - buyVwap=vwapForNotional(buyLevels(ask),minNotional), sellVwap=동일 target 수량기준으로 sellLevels(bid). **주의: 수량 매칭** — 매수 채운 수량 qty = filledNotional/buyVwap, 매도도 같은 qty를 bid로 채워 VWAP·ok. depthOk = 둘 다 ok.
  - grossSpreadPct=(sellVwap−buyVwap)/buyVwap*100. tradingFeePct=(buyFeeBps+sellFeeBps)/100. withdrawFeePct: rate 있으면 rate*100; feeCoin 있으면 feeCoin*buyVwap/filledNotional*100(=코인정액을 규모로 나눔); 미확인이면 0+withdrawFeeKnown=false. netSpreadPct=gross−trading−withdraw.
  - 케이스: gross 2%, 거래수수료 0.2%(5+5→wait KRW 5+5bps=0.1%; 값에 맞춰), 출금 정률 1% → net≈0.9%. feeCoin 정액 케이스. depth 부족(ok:false) 케이스.
- [ ] **Step 2(GREEN):** 구현(순수함수).
- [ ] **Step 3:** `jest multi-arb-net-calculator` 통과.

## Task 6: 스캐너 파이프라인 재배선

**Files:** Modify `src/services/multi-exchange-arb-scanner.service.ts`

- [ ] **Step 1:** `fetchAllPrices` → `multiArbBookSource.fetchAllBooks`. `calculateSpreads`에 books 전달.
- [ ] **Step 2:** 1차 필터: `spreadPct(실현 최우선호가) >= max(SPREAD_THRESHOLD_PCT, preFloor)` — preFloor는 임계값과 동일(1%)로 shortlist. sanity·feasibility 순서 유지.
- [ ] **Step 3:** feasible(또는 최소한 sane) 후보에 대해 **깊이+순차익**:
  - buyLevels/sellLevels 확보: KRW권은 books의 levels 사용. USDT권은 `multiArbDepth.fetch*Depth`로 buy측 askLevels·sell측 bidLevels per-symbol 조회(shortlist만).
  - 출금료: buy=bithumb→`getWithdrawFeeInfo`(admin BithumbClient, matchedNetwork). buy=binance/mexc→wallets의 NetworkStatus.withdrawFee(matchedNetwork). buy=gateio/upbit→미확인.
  - `computeNet(...)` → netSpreadPct, depthOk.
- [ ] **Step 4:** 발송 조건: `gate.enabled && (!feasibleOnly || feasible) && depthOk && netSpreadPct >= SPREAD_THRESHOLD_PCT && alerted<maxPerCycle`. 순위: feasible→netSpreadPct 내림차순. net 정보 notify에 전달. (미충족은 기존대로 DB 기록/쿨다운만)
- [ ] **Step 5:** `npx tsc --noEmit` 통과.

## Task 7: 알림 메시지

**Files:** Modify `src/services/multi-arb-notifier.service.ts`

- [ ] **Step 1:** `notify` 시그니처에 net 정보 추가. 메시지에: 순차익 %, 최우선호가 실현 %, 검증 규모(예 "10만원 깊이 확인"), 매수/매도 거래소·호가, 출금료(정액/정률/미확인), 매칭 네트워크, 김프(있으면), **주의 문구**("전송에 수분~수시간 소요 — 실현차익은 현재 호가 스냅샷 기준").
- [ ] **Step 2:** DB 기록 필드 정합(기존 스키마 유지, note에 요약). `npx tsc --noEmit` + `npm run build` 통과.

## Task 8: 통합 검증

- [ ] **Step 1:** `npx tsc --noEmit` 0, `npm run build` 성공, 신규/갱신 jest 스위트 전부 PASS.
- [ ] **Step 2:** production 배포 후 서버 내부(docker exec)에서 `scanOnce` 1회 실행 → 로그로 실현/순차익·깊이·출금료 확인. **발송 게이트는 기존 env 그대로**(변경 없이 관찰). 알림 폭주 없이 순차익 후보만 선별되는지 확인.

## Self-Review 체크
- 최우선호가만이 아니라 최소주문 VWAP까지 통과해야 발송(깊이).
- 순서쌍 전수비교(min/max 단축 금지).
- 출금료 미확인 시 순차익은 출금료 제외 추정 + 메시지 명시(은폐 금지).
- 임계값 의미 변경(순차익 %) 로그/문서화.
