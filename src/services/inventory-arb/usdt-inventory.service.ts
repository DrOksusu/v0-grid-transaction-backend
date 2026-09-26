// USDT권 재고형 아비(Gate↔MEXC) 오케스트레이션: 스캔→순차익 게이트→(자동)실행→기록
// - **양방향**: MEXC 비쌈(Gate매수/MEXC매도) 또는 Gate 비쌈(MEXC매수/Gate매도) 자동 선택. 전송 없음.
// - 거래량은 매도측 코인의 **안정 재고량**(창 내 최소 잔고)으로 캡 — 그리드 신선분 제외
// - 재고 소진은 자동정지 아닌 skip(양방향 자가 리밸런싱). flatten_failed(터미널)→killSwitch+긴급 카톡
// - autoExecute=false(반자동)면 기회를 감지해도 절대 발주하지 않음
import mainPrisma from '../../config/database';
import { getAdminCreds } from '../admin-credentials';
import { MexcLeg } from '../exchange/mexc-leg';
import { GateLeg } from '../exchange/gate-leg';
import { BinanceLeg } from '../exchange/binance-leg';
import { fetchGateioDepth, fetchMexcDepth, fetchBinanceDepth } from '../multi-arb-depth.service';
import { computeNet } from '../multi-arb-net-calculator';
import { executeArb } from './executor';
import { stableTradeableAmount, peekStableAmount } from './inventory-stability';
import { kakaoNotifyService } from '../kakao-notify.service';
import type { BookLevel } from '../multi-arb-types';

// Gate taker 0.2% / MEXC taker 0.1% — 실측 미확정 시 보수적 상한값(더 낮은 실제 수수료면 net이 과소평가되어 안전측)
export const GATE_FEE_BPS = 20;
export const MEXC_FEE_BPS = 10;

const GATE_MIN_ORDER_USDT = 3; // GateLeg 최소주문(spec §0) — executor dust 임계로 그대로 전달
const MIN_BASE_UNIT = 1; // ALEO 등 정수 단위 최소 체결수량

// 드레인 알림: 수익 기회가 있는데 재고/현금 부족으로 실행 못 하는 상태가 지속될 때 리밸런싱 촉구(봇당 스로틀)
const DRAIN_STARVED_REASONS = new Set(['inventory_not_stable', 'notional_below_min_order', 'buy_cash_insufficient']);
const DRAIN_ALERT_THROTTLE_MS = 6 * 60 * 60 * 1000; // 봇당 6시간에 최대 1회
const lastDrainAlertAt = new Map<number, number>();

// 후보 수동 실행 (KRW inventory-arb.service의 executeManual 패턴 미러)
export const USDT_MANUAL_BOT_SYMBOL = '__MANUAL__'; // 수동 실행 기록용 sentinel 봇 (봇 목록에서 숨김)
const MANUAL_MAX_USDT = 1000; // 수동 1회 서버 하드캡
const CANDIDATE_SCAN_MAX_SYMBOLS = 100; // 후보 스캔 심볼 상한 (3거래소 보유 유니온 커버)
const CANDIDATE_SCAN_BATCH = 5; // 심볼 동시 처리 수 (depth 조회 병렬 배치)
const manualInFlight = new Set<string>(); // `${userId}:${symbol}` 동시실행 가드

// ── (a) 거래소 쌍 레지스트리 + 순수 판정 함수 (양방향) ─────────────────────
export type UsdtExchange = 'gateio' | 'mexc' | 'binance';
export type UsdtArbDirection = string; // `buy_${거래소}_sell_${거래소}` (예: buy_gateio_sell_mexc, buy_binance_sell_mexc)

// 거래소별 taker 수수료(bps) — 보수적 상한값
export const EXCHANGE_FEE_BPS: Record<UsdtExchange, number> = { gateio: GATE_FEE_BPS, mexc: MEXC_FEE_BPS, binance: 10 };
// 거래소별 최소 주문금액(USDT) — Binance NOTIONAL 필터(~5)는 보수적으로 6 (critic MAJOR-1)
export const EXCHANGE_MIN_ORDER_USDT: Record<UsdtExchange, number> = { gateio: 3, mexc: 3, binance: 6 };
/** 쌍의 최소주문 = 두 거래소 중 큰 값 — 주문·flatten이 어느 쪽에서든 발생할 수 있어 max로 gate */
export function pairMinOrderUsdt(x: UsdtExchange, y: UsdtExchange): number {
  return Math.max(EXCHANGE_MIN_ORDER_USDT[x], EXCHANGE_MIN_ORDER_USDT[y]);
}
// 지원 거래소 쌍 (봇의 exchangePair 값)
export const USDT_ARB_PAIRS: Record<string, [UsdtExchange, UsdtExchange]> = {
  gateio_mexc: ['gateio', 'mexc'],
  binance_mexc: ['binance', 'mexc'],
  gateio_binance: ['gateio', 'binance'],
};

/** 한 거래소의 스냅샷 (호가 + 잔고). coinBalance엔 호출자가 안정 재고량을 넣어 거래량 상한으로 쓴다. */
export interface ExchangeSide {
  name: UsdtExchange;
  ask: number;
  bid: number;
  askLevels: BookLevel[];
  bidLevels: BookLevel[];
  coinBalance: number; // 매도측 재고 상한 (안정 재고량)
  usdtBalance: number; // 매수측 현금
}

export interface ShouldExecuteInput {
  a: ExchangeSide;
  b: ExchangeSide;
  bot: {
    symbol: string;
    thresholdPct: number;
    orderUsdt: number;
    killSwitch: boolean;
  };
}

export interface ShouldExecuteResult {
  go: boolean;
  direction?: UsdtArbDirection;
  buyExchange?: UsdtExchange;
  sellExchange?: UsdtExchange;
  qty?: number;
  buyPrice?: number;       // 매수 거래소 ask (지불)
  sellPrice?: number;      // 매도 거래소 bid (수취)
  flattenRefPrice?: number; // 매도 거래소 ask (net-short flatten 되사기 예산 기준)
  netSpreadPct?: number;
  reason?: string;
}

/**
 * 순수 판정 함수(I/O 없음). **양방향** (거래소 쌍 무관 A/B 슬롯):
 *  - 방향1: B가 비쌀 때(b.bid > a.ask) — A 매수 + B 매도. 재고: B 코인(매도)+A USDT(매수).
 *  - 방향2: A가 비쌀 때(a.bid > b.ask) — B 매수 + A 매도. 재고: A 코인(매도)+B USDT(매수).
 * 두 방향 중 순차익 최대이면서 모든 게이트(깊이·임계·재고)를 통과하는 것을 선택.
 * 재고 소진은 자동정지가 아니라 skip(양방향이라 반대 방향/시세 변동으로 자가 리밸런싱됨).
 */
export function shouldExecute(input: ShouldExecuteInput): ShouldExecuteResult {
  const { a, b, bot } = input;

  if (bot.killSwitch) return { go: false, reason: 'kill_switch' };

  interface Cand {
    buyEx: ExchangeSide; sellEx: ExchangeSide;
  }
  const candidates: Cand[] = [];
  if (b.bid > a.ask) candidates.push({ buyEx: a, sellEx: b }); // B 비쌈 → A 매수 + B 매도
  if (a.bid > b.ask) candidates.push({ buyEx: b, sellEx: a }); // A 비쌈 → B 매수 + A 매도
  if (candidates.length === 0) return { go: false, reason: 'no_gap_or_wrong_direction' };

  // 각 방향 평가 → 게이트 통과분 중 순차익 최대 선택
  let best: (ShouldExecuteResult & { netSpreadPct: number }) | null = null;
  let lastReason = 'net_spread_below_threshold';
  for (const c of candidates) {
    const buyAsk = c.buyEx.ask;
    const targetQty = Math.floor(bot.orderUsdt / buyAsk);
    if (targetQty < MIN_BASE_UNIT) { lastReason = 'order_too_small'; continue; } // orderUsdt가 1코인 값보다 작음(설정)
    // 먼저 목표 규모 기준 순차익으로 "실제 기회"인지 판정(보수적) — 재고 부족 사유가 무의미하게 뜨지 않도록
    const net = computeNet({
      buyLevels: c.buyEx.askLevels, sellLevels: c.sellEx.bidLevels, minNotional: bot.orderUsdt,
      buyFeeBps: EXCHANGE_FEE_BPS[c.buyEx.name],
      sellFeeBps: EXCHANGE_FEE_BPS[c.sellEx.name],
      withdrawFee: null, thresholdPct: bot.thresholdPct,
    });
    if (!net.depthOk) { lastReason = 'depth_insufficient'; continue; }
    if (net.netSpreadPct < bot.thresholdPct) { lastReason = 'net_spread_below_threshold'; continue; }
    // 여기부터는 수익 기회 존재 → 재고/현금 부족은 "리밸런싱 필요"(드레인 알림 대상)
    // 안정 재고량(sellEx.coinBalance)으로 거래량 캡 — 그리드가 방금 채운 신선분은 제외하고 안정분까지만
    const qty = Math.min(targetQty, Math.floor(c.sellEx.coinBalance));
    if (qty < MIN_BASE_UNIT) { lastReason = 'inventory_not_stable'; continue; } // 안정 재고 부족(60초 관측 전 or 드레인)
    const notional = qty * buyAsk; // 캡 후 실제 체결 규모
    const minOrder = pairMinOrderUsdt(c.buyEx.name, c.sellEx.name);
    if (notional < minOrder) { lastReason = 'notional_below_min_order'; continue; }
    if (c.buyEx.usdtBalance < notional) { lastReason = 'buy_cash_insufficient'; continue; }
    if (!best || net.netSpreadPct > best.netSpreadPct) {
      best = {
        go: true,
        direction: `buy_${c.buyEx.name}_sell_${c.sellEx.name}`,
        buyExchange: c.buyEx.name, sellExchange: c.sellEx.name,
        qty, buyPrice: buyAsk, sellPrice: c.sellEx.bid, flattenRefPrice: c.sellEx.ask, netSpreadPct: net.netSpreadPct,
      };
    }
  }
  return best ?? { go: false, reason: lastReason };
}

// ── (a-2) 후보 스캔 순수 헬퍼 ──────────────────────────────────────────
/**
 * 호가 크로싱 최대 수량: 매수측 ask 레벨과 매도측 bid 레벨을 병합 워크하며
 * "다음 한 단위의 매도가 > 매수가"인 동안 누적. (수수료 미반영 — 순차익은 computeNet으로 별도 판정)
 */
export function crossingQty(buyAsks: BookLevel[], sellBids: BookLevel[]): number {
  let qty = 0;
  let bi = 0, si = 0;
  let bRem = buyAsks[0]?.qty ?? 0;
  let sRem = sellBids[0]?.qty ?? 0;
  while (bi < buyAsks.length && si < sellBids.length) {
    if (sellBids[si].price <= buyAsks[bi].price) break; // 더 이상 이익 구간 아님
    const step = Math.min(bRem, sRem);
    qty += step;
    bRem -= step; sRem -= step;
    if (bRem <= 0) { bi++; bRem = buyAsks[bi]?.qty ?? 0; }
    if (sRem <= 0) { si++; sRem = sellBids[si]?.qty ?? 0; }
  }
  return qty;
}

export interface UsdtCandidate {
  symbol: string;
  direction: UsdtArbDirection;
  buyExchange: UsdtExchange;
  sellExchange: UsdtExchange;
  buyPrice: number;        // 매수 거래소 최우선 ask
  sellPrice: number;       // 매도 거래소 최우선 bid
  grossSpreadPct: number;  // 최우선호가 갭 %
  netSpreadPct: number;    // 체결가능 규모 깊이 VWAP + 수수료 반영 순차익 %
  executableQty: number;   // min(호가 크로싱, 매도측 재고, 매수측 USDT/가격) — 정수 floor
  executableUsdt: number;  // executableQty × buyPrice
}

/** 한 방향 후보 평가 (순수). 실행가능 규모가 최소주문 미만이거나 갭이 없으면 null. */
export function evalCandidateDirection(input: {
  symbol: string;
  direction: UsdtArbDirection;
  buyExchange: UsdtExchange;
  sellExchange: UsdtExchange;
  buyAskLevels: BookLevel[];
  sellBidLevels: BookLevel[];
  sellCoinBal: number;
  buyCashBal: number;
}): UsdtCandidate | null {
  const { buyAskLevels, sellBidLevels } = input;
  const buyAsk = buyAskLevels[0]?.price ?? 0;
  const sellBid = sellBidLevels[0]?.price ?? 0;
  if (!(buyAsk > 0) || sellBid <= buyAsk) return null;

  const rawQty = Math.min(
    crossingQty(buyAskLevels, sellBidLevels),
    input.sellCoinBal,
    input.buyCashBal / buyAsk,
  );
  const qty = Math.floor(rawQty);
  if (qty < MIN_BASE_UNIT) return null;
  const notional = qty * buyAsk;
  if (notional < pairMinOrderUsdt(input.buyExchange, input.sellExchange)) return null;

  const net = computeNet({
    buyLevels: buyAskLevels, sellLevels: sellBidLevels, minNotional: notional,
    buyFeeBps: EXCHANGE_FEE_BPS[input.buyExchange],
    sellFeeBps: EXCHANGE_FEE_BPS[input.sellExchange],
    withdrawFee: null, thresholdPct: 0,
  });
  if (!net.depthOk) return null;

  return {
    symbol: input.symbol,
    direction: input.direction,
    buyExchange: input.buyExchange,
    sellExchange: input.sellExchange,
    buyPrice: buyAsk,
    sellPrice: sellBid,
    grossSpreadPct: (sellBid / buyAsk - 1) * 100,
    netSpreadPct: net.netSpreadPct,
    executableQty: qty,
    executableUsdt: notional,
  };
}

// ── (b) 오케스트레이션 ──────────────────────────────────────────────────
class UsdtInventoryService {
  private mexcLegCache: MexcLeg | null = null;
  private gateLegCache: GateLeg | null = null;
  private binanceLegCache: BinanceLeg | null = null;

  /** 에이전트가 사이클마다 봇 단위로 호출 */
  async runOnce(bot: {
    id: number;
    symbol: string;
    thresholdPct: number;
    orderUsdt: number;
    dailyMaxCount: number | null;
    dailyMaxLossUsdt: number | null;
    killSwitch: boolean;
    autoExecute: boolean;
    inventoryStableSec: number;
    exchangePair?: string;
  }): Promise<void> {
    try {
      // 1. 일한도(KST) 체크 — 초과 시 정지 + 알림 + 리턴
      const usage = await this.fetchTodayUsage(bot.id);
      if (bot.dailyMaxCount != null && usage.count >= bot.dailyMaxCount) {
        await this.autoStop(bot.id, bot.symbol, `일일 최대 거래횟수(${bot.dailyMaxCount}) 도달`);
        return;
      }
      if (bot.dailyMaxLossUsdt != null && usage.netUsdt <= -bot.dailyMaxLossUsdt) {
        await this.autoStop(bot.id, bot.symbol, `일일 최대 손실(${bot.dailyMaxLossUsdt} USDT) 도달`);
        return;
      }

      // 2. 거래소 쌍 해석 + leg/depth/잔고 조회
      const [exA, exB] = this.resolvePair(bot.exchangePair);
      const [sideA, sideB] = await Promise.all([
        this.loadSide(exA, bot.symbol),
        this.loadSide(exB, bot.symbol),
      ]);
      if (!sideA || !sideB) return; // 조회 실패/호가 없음 — 이번 사이클 skip

      // 2.5 재고 안정화: 매도측 코인이 최근 inventoryStableSec 창 동안 유지된 **최소 잔고**만 거래 상한으로 사용
      //     (그리드봇이 방금 채운 신선분은 제외 → 그리드 경합·자기 밀어올림 방지). 두 거래소를 각각 추적.
      const aStable = stableTradeableAmount(`usdt:${bot.id}:${exA}`, sideA.coinBalance, bot.inventoryStableSec);
      const bStable = stableTradeableAmount(`usdt:${bot.id}:${exB}`, sideB.coinBalance, bot.inventoryStableSec);

      // 3. 양방향 게이트 (매도측 재고엔 안정 재고량을 전달 → 거래량 캡)
      const decision = shouldExecute({
        a: { ...sideA, coinBalance: aStable },
        b: { ...sideB, coinBalance: bStable },
        bot,
      });

      if (!decision.go) {
        // 수익 기회는 있으나 재고/현금 부족으로 실행 못 하는 상태 → 리밸런싱 알림(스로틀)
        // 단 워밍업(관측<60s라 안정재고=0) 오탐 제외: 실제 raw 잔고/현금이 최소주문도 못 채울 때만
        if (bot.autoExecute && decision.reason && DRAIN_STARVED_REASONS.has(decision.reason)) {
          const minCoin = GATE_MIN_ORDER_USDT / Math.max(sideA.ask, sideB.ask, 1e-9);
          const genuinelyLow = decision.reason === 'buy_cash_insufficient'
            ? (sideA.usdtBalance < GATE_MIN_ORDER_USDT || sideB.usdtBalance < GATE_MIN_ORDER_USDT)
            : (sideA.coinBalance < minCoin || sideB.coinBalance < minCoin);
          if (genuinelyLow) await this.maybeNotifyDrain(bot, decision.reason);
        }
        console.log(`[UsdtInventoryArb] bot ${bot.id} gate: ${decision.reason}`);
        return;
      }

      // 방향에 따라 leg 결정
      const buyLeg = await this.getLeg(decision.buyExchange!);
      const sellLeg = await this.getLeg(decision.sellExchange!);

      // 4. 반자동(autoExecute=false) — 감지만, 발주 금지
      if (!bot.autoExecute) {
        console.log(`[UsdtInventoryArb] bot ${bot.id} detected (반자동, 미실행) ${decision.direction} qty=${decision.qty}`);
        return;
      }

      // 5. 실행 (record-before-fire)
      const trade = await mainPrisma.usdtInventoryArbTrade.create({
        data: {
          botId: bot.id,
          symbol: bot.symbol,
          buyExchange: decision.buyExchange!,
          sellExchange: decision.sellExchange!,
          qty: decision.qty!,
          buyPrice: decision.buyPrice!,
          sellPrice: decision.sellPrice!,
          status: 'detected',
          note: `pre-fire ${decision.direction}`,
        },
      });

      const result = await executeArb({
        buyLeg,
        sellLeg,
        symbol: bot.symbol,
        qty: decision.qty!,
        buyPrice: decision.buyPrice!,
        sellPrice: decision.sellPrice!,
        fallbackMode: 'market_flatten',
        // 쌍별 최소주문(예: binance 6) — 이보다 작은 불균형은 dust로 수용해 killSwitch 오탐 방지 (critic MAJOR-1)
        minOrderQuote: pairMinOrderUsdt(decision.buyExchange!, decision.sellExchange!),
        flattenBuyRefPrice: decision.flattenRefPrice!,
      });

      // 6. 결과 기록 + 후처리
      await this.persistResult(bot, trade.id, result);
    } catch (err: any) {
      console.error(`[UsdtInventoryArb] bot ${bot.id} 처리 실패:`, err.message);
    }
  }

  /**
   * 실시간 상태 조회 (read-only, 주문 없음). 관리자 UI 대시보드용.
   * runOnce와 동일하게 호가·잔고·순차익·판정을 계산하되 executeArb는 호출하지 않는다.
   */
  async getLiveStatus(bot: {
    id: number; symbol: string; thresholdPct: number; orderUsdt: number;
    autoExecute: boolean; enabled: boolean; killSwitch: boolean; inventoryStableSec: number;
    exchangePair?: string;
  }): Promise<{
    symbol: string;
    pair: string;              // 거래소 쌍 (gateio_mexc | binance_mexc)
    // 거래소별 스냅샷 (쌍 순서대로 2개): 이름 + 최우선호가 + 잔고
    exchanges: Array<{ name: UsdtExchange; bid: number; ask: number; coinBalance: number; usdtBalance: number }>;
    topSpreadPct: number;      // 활성(최적) 방향의 실현 최우선호가 갭 %
    netSpreadPct: number;      // 활성 방향의 깊이 VWAP + 거래수수료 반영 순차익
    depthOk: boolean;
    thresholdPct: number;
    qty: number | null;        // 실행 예정 수량(조건 충족 시)
    direction: string;         // 활성 방향 buy_<거래소>_sell_<거래소>
    buyExchange: string;       // 활성 방향 매수 거래소
    sellExchange: string;      // 활성 방향 매도 거래소
    decision: string;          // 'ready' | shouldExecute reason 코드
    autoExecute: boolean; enabled: boolean; killSwitch: boolean;
    fetchedAt: string;
    error?: string;
  }> {
    const [exA, exB] = this.resolvePair(bot.exchangePair);
    const base = {
      symbol: bot.symbol, thresholdPct: bot.thresholdPct, pair: bot.exchangePair ?? 'gateio_mexc',
      autoExecute: bot.autoExecute, enabled: bot.enabled, killSwitch: bot.killSwitch,
      fetchedAt: new Date().toISOString(),
    };
    const zeros = {
      exchanges: [
        { name: exA, bid: 0, ask: 0, coinBalance: 0, usdtBalance: 0 },
        { name: exB, bid: 0, ask: 0, coinBalance: 0, usdtBalance: 0 },
      ],
      topSpreadPct: 0, netSpreadPct: 0, depthOk: false,
      qty: null, direction: 'none', buyExchange: '', sellExchange: '',
    };
    try {
      const [sideA, sideB] = await Promise.all([
        this.loadSide(exA, bot.symbol, true),
        this.loadSide(exB, bot.symbol, true),
      ]);
      if (!sideA || !sideB) {
        return { ...base, ...zeros, decision: 'depth_unavailable', error: '호가 조회 실패' };
      }

      // 양방향 실현 최우선호가 갭 → 큰 쪽을 활성 방향으로 표시
      const dir1Pct = sideA.ask > 0 ? ((sideB.bid - sideA.ask) / sideA.ask) * 100 : -Infinity; // B 비쌈
      const dir2Pct = sideB.ask > 0 ? ((sideA.bid - sideB.ask) / sideB.ask) * 100 : -Infinity; // A 비쌈
      const activeIs1 = dir1Pct >= dir2Pct;
      const buyEx = activeIs1 ? sideA : sideB;
      const sellEx = activeIs1 ? sideB : sideA;
      const net = computeNet({
        buyLevels: buyEx.askLevels, sellLevels: sellEx.bidLevels,
        buyFeeBps: EXCHANGE_FEE_BPS[buyEx.name], sellFeeBps: EXCHANGE_FEE_BPS[sellEx.name],
        minNotional: bot.orderUsdt, withdrawFee: null, thresholdPct: bot.thresholdPct,
      });

      // 매도측 안정 재고량(read-only) — 실행 판정과 동일 캡을 상태에도 반영
      const aStable = peekStableAmount(`usdt:${bot.id}:${exA}`, bot.inventoryStableSec, sideA.coinBalance);
      const bStable = peekStableAmount(`usdt:${bot.id}:${exB}`, bot.inventoryStableSec, sideB.coinBalance);
      const decision = shouldExecute({
        a: { ...sideA, coinBalance: aStable },
        b: { ...sideB, coinBalance: bStable },
        bot: { symbol: bot.symbol, thresholdPct: bot.thresholdPct, orderUsdt: bot.orderUsdt, killSwitch: bot.killSwitch },
      });

      return {
        ...base,
        exchanges: [
          { name: sideA.name, bid: sideA.bid, ask: sideA.ask, coinBalance: sideA.coinBalance, usdtBalance: sideA.usdtBalance },
          { name: sideB.name, bid: sideB.bid, ask: sideB.ask, coinBalance: sideB.coinBalance, usdtBalance: sideB.usdtBalance },
        ],
        topSpreadPct: activeIs1 ? dir1Pct : dir2Pct,
        netSpreadPct: net.netSpreadPct,
        depthOk: net.depthOk,
        qty: decision.go ? decision.qty ?? null : null,
        direction: decision.go ? decision.direction! : `buy_${buyEx.name}_sell_${sellEx.name}`,
        buyExchange: decision.go ? decision.buyExchange! : buyEx.name,
        sellExchange: decision.go ? decision.sellExchange! : sellEx.name,
        decision: decision.go ? 'ready' : (decision.reason ?? 'unknown'),
      };
    } catch (err: any) {
      return { ...base, ...zeros, decision: 'error', error: err?.message ?? String(err) };
    }
  }

  // 수익 기회가 있는데 재고/현금 부족으로 실행 못 하는 상태 → 봇당 6시간에 1회 리밸런싱 카톡
  private async maybeNotifyDrain(bot: { id: number; symbol: string; exchangePair?: string }, reason: string): Promise<void> {
    const now = Date.now();
    if (now - (lastDrainAlertAt.get(bot.id) ?? 0) < DRAIN_ALERT_THROTTLE_MS) return;
    lastDrainAlertAt.set(bot.id, now);
    const label = reason === 'buy_cash_insufficient' ? '매수측 USDT 부족' : '매도측 코인 재고 소진';
    const [exA, exB] = this.resolvePair(bot.exchangePair);
    try {
      await kakaoNotifyService.sendToMe(
        `⚠️ USDT 재고형 아비 [${bot.symbol}] 리밸런싱 필요\n순차익 기회가 있으나 ${label}(으)로 거래가 중단됐습니다. ${exA}↔${exB} 재고를 재배분하세요.`,
      );
    } catch { /* 알림 실패는 무시 — 다음 스로틀 창에서 재시도 */ }
  }

  // ── 거래소 쌍 해석 + 공용 로더 ──────────────────────────────────────────
  /** exchangePair 문자열 → [거래소A, 거래소B]. 미지정/미지원 값은 gateio_mexc. */
  private resolvePair(pair?: string): [UsdtExchange, UsdtExchange] {
    return USDT_ARB_PAIRS[pair ?? ''] ?? USDT_ARB_PAIRS.gateio_mexc;
  }

  /** 거래소명 → leg 인스턴스 (캐시). */
  private async getLeg(name: UsdtExchange): Promise<MexcLeg | GateLeg | BinanceLeg> {
    if (name === 'mexc') return this.getMexcLeg();
    if (name === 'gateio') return this.getGateLeg();
    return this.getBinanceLeg();
  }

  /** 거래소명 → depth 조회. */
  private fetchDepth(name: UsdtExchange, symbol: string) {
    if (name === 'mexc') return fetchMexcDepth(symbol);
    if (name === 'gateio') return fetchGateioDepth(symbol);
    return fetchBinanceDepth(symbol);
  }

  /**
   * 한 거래소의 스냅샷(호가+코인/USDT 잔고) 로드. 호가 없으면 null.
   * @param swallowBalanceError true면 잔고 조회 실패를 0으로 흡수(상태 표시용)
   */
  private async loadSide(name: UsdtExchange, symbol: string, swallowBalanceError = false): Promise<ExchangeSide | null> {
    const leg = await this.getLeg(name);
    const depth = await this.fetchDepth(name, symbol);
    if (!depth || depth.askLevels.length === 0 || depth.bidLevels.length === 0) return null;
    const [coinBalance, usdtBalance] = await Promise.all([
      swallowBalanceError ? leg.getBalance(symbol).catch(() => 0) : leg.getBalance(symbol),
      swallowBalanceError ? leg.getBalance('USDT').catch(() => 0) : leg.getBalance('USDT'),
    ]);
    return {
      name,
      ask: depth.askLevels[0].price,
      bid: depth.bidLevels[0].price,
      askLevels: depth.askLevels,
      bidLevels: depth.bidLevels,
      coinBalance,
      usdtBalance,
    };
  }

  private async persistResult(
    bot: { id: number; symbol: string },
    tradeId: number,
    result: Awaited<ReturnType<typeof executeArb>>,
  ): Promise<void> {
    if (result.kind === 'filled' || result.kind === 'partial_flattened') {
      // grossUsdt = netUsdt + feeUsdt (flatten leg까지 반영된 netKrw/feeKrw로 역산 — KRW 자매 서비스와 동일)
      const grossUsdt = result.netKrw + result.feeKrw;
      await mainPrisma.usdtInventoryArbTrade.update({
        where: { id: tradeId },
        data: {
          status: result.kind,
          buyFilled: result.buyQty,
          sellFilled: result.sellQty,
          grossUsdt: +grossUsdt.toFixed(6),
          feeUsdt: +result.feeKrw.toFixed(6),
          netUsdt: +result.netKrw.toFixed(6),
          flattenSide: result.kind === 'partial_flattened' ? result.flattenSide : null,
          note: result.note,
        },
      });
    } else if (result.kind === 'flatten_failed') {
      // 터미널: killSwitch ON + 봇 정지 + 긴급 카톡. 각 부수효과 독립 try/catch(서로 안 삼킴).
      try {
        await mainPrisma.usdtInventoryArbBot.update({
          where: { id: bot.id },
          data: { killSwitch: true, enabled: false },
        });
      } catch (e: any) {
        console.error(`[UsdtInventoryArb] bot ${bot.id} killSwitch 설정 실패:`, e.message);
      }
      try {
        await kakaoNotifyService.sendToMe(this.buildEmergencyMessage(bot.symbol, result.imbalanceQty, result.note));
      } catch (e: any) {
        console.error(`[UsdtInventoryArb] bot ${bot.id} 긴급 카톡 발송 실패:`, e.message);
      }
      try {
        await mainPrisma.usdtInventoryArbTrade.update({
          where: { id: tradeId },
          data: { status: 'flatten_failed', note: result.note },
        });
      } catch (e: any) {
        console.error(`[UsdtInventoryArb] bot ${bot.id} trade#${tradeId} 기록 실패:`, e.message);
      }
    } else {
      // partial_hold | failed
      const note = result.kind === 'partial_hold' ? result.note : result.reason;
      await mainPrisma.usdtInventoryArbTrade.update({
        where: { id: tradeId },
        data: { status: result.kind, note },
      });
    }
  }

  private buildEmergencyMessage(symbol: string, imbalanceQty: number, note: string): string {
    return `🚨 USDT 재고형 아비 flatten 실패 — ${symbol} 방향노출 ${imbalanceQty} 잔존!\n봇 killSwitch ON + 정지됨. 수동 확인 필요.\n(${note})`;
  }

  private async autoStop(botId: number, symbol: string, reason: string): Promise<void> {
    try {
      await mainPrisma.usdtInventoryArbBot.update({ where: { id: botId }, data: { enabled: false } });
    } catch (e: any) {
      console.error(`[UsdtInventoryArb] bot ${botId} 자동정지 실패:`, e.message);
    }
    try {
      await kakaoNotifyService.sendToMe(`⏸️ USDT 재고형 아비 자동정지 · ${symbol}\n사유: ${reason}`);
    } catch (e: any) {
      console.error(`[UsdtInventoryArb] bot ${botId} 정지 알림 실패:`, e.message);
    }
  }

  private async fetchTodayUsage(botId: number): Promise<{ count: number; netUsdt: number }> {
    // 일일 한도 창은 KST 자정 기준 명시 계산 — 컨테이너 TZ가 UTC여도 안전 (KRW inventory-arb.service와 동일 패턴)
    const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
    const kstNow = new Date(Date.now() + KST_OFFSET_MS);
    kstNow.setUTCHours(0, 0, 0, 0);
    const start = new Date(kstNow.getTime() - KST_OFFSET_MS);
    const rows = await mainPrisma.usdtInventoryArbTrade.findMany({
      where: { botId, createdAt: { gte: start }, status: { in: ['filled', 'partial_flattened'] } },
      select: { netUsdt: true },
    });
    return { count: rows.length, netUsdt: rows.reduce((s, r) => s + r.netUsdt, 0) };
  }

  /**
   * 크래시 복구 리컨실 (critic Finding #1): record-before-fire와 persistResult 사이에서
   * 프로세스가 죽으면 'detected' 행이 고아로 남는다 — killSwitch/알림 없이 일손실 집계에서 누락돼
   * 안전망(일일 손실 한도)이 조용히 약화된다. 에이전트 onStart에서 호출.
   * onStart 시점엔 이 프로세스의 in-flight 거래가 없으므로 'detected'는 전부 이전 크래시 잔재로 간주.
   * 발견 시 해당 봇을 killSwitch+정지(안전 방향)하고 긴급 카톡 — 실제 체결/잔고는 사람이 수동 확인.
   */
  async reconcileOrphans(): Promise<void> {
    const orphans = await mainPrisma.usdtInventoryArbTrade.findMany({
      where: { status: 'detected' },
      select: { botId: true, symbol: true },
    });
    if (orphans.length === 0) return;

    const botIds = [...new Set(orphans.map((o) => o.botId))];
    for (const botId of botIds) {
      const sym = orphans.find((o) => o.botId === botId)?.symbol ?? '?';
      try {
        await mainPrisma.usdtInventoryArbBot.update({
          where: { id: botId },
          data: { killSwitch: true, enabled: false },
        });
      } catch (e: any) {
        console.error(`[UsdtInventoryArb] 고아복구 봇 ${botId} 정지 실패:`, e.message);
      }
      try {
        await kakaoNotifyService.sendToMe(
          `🚨 USDT 재고형 아비 정산 미완료 거래 발견 · ${sym}\n`
          + `프로세스 중단으로 체결/정산 불명 거래가 남았습니다. 봇 killSwitch ON + 정지.\n`
          + `거래소에서 실제 체결·잔고를 수동 확인하세요.`,
        );
      } catch (e: any) {
        console.error(`[UsdtInventoryArb] 고아복구 알림 실패 (봇 ${botId}):`, e.message);
      }
    }

    // 재집계·재알림 방지 위해 터미널 상태로 마킹(실제 체결 여부 불명이므로 orphan_reconciled로 구분).
    try {
      await mainPrisma.usdtInventoryArbTrade.updateMany({
        where: { status: 'detected' },
        data: { status: 'orphan_reconciled', note: '크래시 고아 — 정산 미완료, killSwitch 처리. 수동 확인 필요' },
      });
    } catch (e: any) {
      console.error('[UsdtInventoryArb] 고아 행 마킹 실패:', e.message);
    }
  }

  /**
   * 후보 스캔: 3개 거래소(Gate/MEXC/Binance) 보유 코인(합집합) × 등록된 쌍(USDT_ARB_PAIRS) 양방향 평가.
   * 방향별 실행가능 규모(호가 크로싱 × 재고 × 현금)와 순차익을 계산해 net ≥ minNetPct만 반환.
   */
  /** 3거래소 non-zero 잔고 일괄 조회 (실패한 거래소는 제외). 해외 스프레드 보유 필터에도 사용. */
  async getBalancesByExchange(): Promise<Map<UsdtExchange, Record<string, number>>> {
    const exchanges: UsdtExchange[] = ['gateio', 'mexc', 'binance'];
    const balances = new Map<UsdtExchange, Record<string, number>>();
    await Promise.all(exchanges.map(async (ex) => {
      try {
        const leg = await this.getLeg(ex);
        balances.set(ex, await leg.getNonZeroBalances());
      } catch (e: any) {
        console.error(`[UsdtInventoryArb] ${ex} 잔고 조회 실패 — 제외:`, e.message);
      }
    }));
    return balances;
  }

  async scanCandidates(minNetPct: number): Promise<UsdtCandidate[]> {
    const exchanges: UsdtExchange[] = ['gateio', 'mexc', 'binance'];
    const balances = await this.getBalancesByExchange();
    const symbols = [...new Set([...balances.values()].flatMap((b) => Object.keys(b)))]
      .filter((s) => s !== 'USDT')
      .slice(0, CANDIDATE_SCAN_MAX_SYMBOLS);

    const out: UsdtCandidate[] = [];
    const evalSymbol = async (sym: string): Promise<UsdtCandidate | null> => {
      // 심볼별 depth 캐시 (거래소당 1회)
      const depths = new Map<UsdtExchange, { askLevels: BookLevel[]; bidLevels: BookLevel[] }>();
      await Promise.all(exchanges.filter((ex) => balances.has(ex)).map(async (ex) => {
        const d = await this.fetchDepth(ex, sym);
        if (d && d.askLevels.length > 0 && d.bidLevels.length > 0) depths.set(ex, d);
      }));

      const cands: UsdtCandidate[] = [];
      for (const [exA, exB] of Object.values(USDT_ARB_PAIRS)) {
        const da = depths.get(exA); const db = depths.get(exB);
        const ba = balances.get(exA); const bb = balances.get(exB);
        if (!da || !db || !ba || !bb) continue; // 한쪽 미상장/조회 실패
        const dir1 = evalCandidateDirection({
          symbol: sym, direction: `buy_${exA}_sell_${exB}`, buyExchange: exA, sellExchange: exB,
          buyAskLevels: da.askLevels, sellBidLevels: db.bidLevels,
          sellCoinBal: bb[sym] ?? 0, buyCashBal: ba['USDT'] ?? 0,
        });
        const dir2 = evalCandidateDirection({
          symbol: sym, direction: `buy_${exB}_sell_${exA}`, buyExchange: exB, sellExchange: exA,
          buyAskLevels: db.askLevels, sellBidLevels: da.bidLevels,
          sellCoinBal: ba[sym] ?? 0, buyCashBal: bb['USDT'] ?? 0,
        });
        if (dir1) cands.push(dir1);
        if (dir2) cands.push(dir2);
      }
      const best = cands.sort((x, y) => y.netSpreadPct - x.netSpreadPct)[0];
      return best && best.netSpreadPct >= minNetPct ? best : null;
    };
    // 배치 병렬 (거래소 API 부하 제한)
    for (let i = 0; i < symbols.length; i += CANDIDATE_SCAN_BATCH) {
      const batch = await Promise.all(symbols.slice(i, i + CANDIDATE_SCAN_BATCH).map(evalSymbol));
      out.push(...batch.filter((c): c is UsdtCandidate => c !== null));
    }
    out.sort((x, y) => y.netSpreadPct - x.netSpreadPct);
    return out;
  }

  /**
   * 수동 1회 실거래 실행 (후보 화면 "즉시 실행" 버튼) — KRW executeManual 패턴 미러.
   * 클릭 시점 실시간 호가+잔고 재검증 → 여전히 net ≥ minNetPct일 때만 executeArb 1회.
   * @param maxUsdt 이번 주문 상한 (서버 하드캡 MANUAL_MAX_USDT로 재차 제한)
   */
  async executeManual(userId: number, symbol: string, maxUsdt: number, minNetPct: number): Promise<{
    executed: boolean; reason?: string; kind?: string; symbol?: string; direction?: string;
    qty?: number; notionalUsdt?: number; netSpreadPct?: number; netUsdt?: number; note?: string;
  }> {
    const key = `${userId}:${symbol}`;
    if (manualInFlight.has(key)) return { executed: false, reason: '이미 실행 중입니다' };
    manualInFlight.add(key);
    try {
      const cappedMax = Math.min(Number(maxUsdt) || 0, MANUAL_MAX_USDT);
      if (cappedMax < GATE_MIN_ORDER_USDT) {
        return { executed: false, reason: `주문 규모가 최소주문(${GATE_MIN_ORDER_USDT} USDT) 미만` };
      }

      // 재검증: 클릭 시점 실시간 호가+잔고 (스캔 스냅샷 아님). 등록된 모든 쌍 평가 후 최적 선택.
      const exchanges: UsdtExchange[] = ['gateio', 'mexc', 'binance'];
      const sides = new Map<UsdtExchange, ExchangeSide>();
      await Promise.all(exchanges.map(async (ex) => {
        try {
          const s = await this.loadSide(ex, symbol);
          if (s) sides.set(ex, s);
        } catch { /* 해당 거래소 조회 실패 — 그 쌍 제외 */ }
      }));
      if (sides.size < 2) return { executed: false, reason: '호가 조회 실패' };

      const cands: UsdtCandidate[] = [];
      for (const [exA, exB] of Object.values(USDT_ARB_PAIRS)) {
        const sa = sides.get(exA); const sb = sides.get(exB);
        if (!sa || !sb) continue;
        const dir1 = evalCandidateDirection({
          symbol, direction: `buy_${exA}_sell_${exB}`, buyExchange: exA, sellExchange: exB,
          buyAskLevels: sa.askLevels, sellBidLevels: sb.bidLevels,
          sellCoinBal: sb.coinBalance, buyCashBal: Math.min(sa.usdtBalance, cappedMax),
        });
        const dir2 = evalCandidateDirection({
          symbol, direction: `buy_${exB}_sell_${exA}`, buyExchange: exB, sellExchange: exA,
          buyAskLevels: sb.askLevels, sellBidLevels: sa.bidLevels,
          sellCoinBal: sa.coinBalance, buyCashBal: Math.min(sb.usdtBalance, cappedMax),
        });
        if (dir1) cands.push(dir1);
        if (dir2) cands.push(dir2);
      }
      const best = cands.sort((x, y) => y.netSpreadPct - x.netSpreadPct)[0];
      if (!best) return { executed: false, reason: '현재 갭/실행가능 규모 없음 — 기회 사라짐' };
      if (best.netSpreadPct < minNetPct) {
        return { executed: false, reason: `현재 순차익 ${best.netSpreadPct.toFixed(2)}% < 임계 ${minNetPct}% — 기회 사라짐` };
      }

      // 규모 상한: maxUsdt 캡 (buyCashBal에 이미 반영됐지만 크로싱/재고가 더 클 수 있어 재차 캡)
      const qty = Math.min(best.executableQty, Math.floor(cappedMax / best.buyPrice));
      const notional = qty * best.buyPrice;
      const minOrder = pairMinOrderUsdt(best.buyExchange, best.sellExchange);
      if (qty < MIN_BASE_UNIT || notional < minOrder) {
        return { executed: false, reason: `실행가능 규모(${notional.toFixed(2)} USDT)가 최소주문(${minOrder}) 미만` };
      }

      // record-before-fire (수동 sentinel 봇에 기록)
      const manualBot = await this.getOrCreateManualBot(userId);
      const trade = await mainPrisma.usdtInventoryArbTrade.create({
        data: {
          botId: manualBot.id, symbol,
          buyExchange: best.buyExchange, sellExchange: best.sellExchange,
          qty, buyPrice: best.buyPrice, sellPrice: best.sellPrice,
          status: 'detected', note: `수동실행 pre-fire ${best.direction} net=${best.netSpreadPct.toFixed(2)}%`,
        },
      });

      const buyLeg = await this.getLeg(best.buyExchange);
      const sellLeg = await this.getLeg(best.sellExchange);
      const sellSideAsk = sides.get(best.sellExchange)!.ask;
      const result = await executeArb({
        buyLeg, sellLeg, symbol, qty,
        buyPrice: best.buyPrice, sellPrice: best.sellPrice,
        fallbackMode: 'market_flatten',
        minOrderQuote: pairMinOrderUsdt(best.buyExchange, best.sellExchange),
        flattenBuyRefPrice: sellSideAsk,
      });
      // persistResult에 실제 심볼을 덮어쓴 봇 전달 — flatten_failed 긴급 알림이 sentinel 대신 실제 코인 명시
      await this.persistResult({ ...manualBot, symbol }, trade.id, result);

      const netUsdt = result.kind === 'filled' || result.kind === 'partial_flattened' ? result.netKrw : undefined;
      const note = 'note' in result ? result.note : 'reason' in result ? (result as any).reason : undefined;
      return {
        executed: true, kind: result.kind, symbol, direction: best.direction,
        qty, notionalUsdt: notional, netSpreadPct: best.netSpreadPct, netUsdt, note,
      };
    } catch (err: any) {
      console.error(`[UsdtInventoryArb] 수동실행 ${symbol} 실패:`, err.message);
      return { executed: false, reason: err.message ?? '실행 오류' };
    } finally {
      manualInFlight.delete(key);
    }
  }

  /** 수동 실행 기록용 sentinel 봇 (userId당 1개, enabled=false, 봇 목록에서 숨김) */
  private async getOrCreateManualBot(userId: number): Promise<{ id: number; symbol: string }> {
    const existing = await mainPrisma.usdtInventoryArbBot.findFirst({ where: { userId, symbol: USDT_MANUAL_BOT_SYMBOL } });
    if (existing) return existing;
    return mainPrisma.usdtInventoryArbBot.create({
      data: { userId, symbol: USDT_MANUAL_BOT_SYMBOL, enabled: false, autoExecute: false },
    });
  }

  private async getMexcLeg(): Promise<MexcLeg> {
    if (this.mexcLegCache) return this.mexcLegCache;
    const creds = await getAdminCreds('mexc');
    if (!creds) throw new Error('MEXC credential not found (admin)');
    this.mexcLegCache = new MexcLeg(creds);
    return this.mexcLegCache;
  }

  private async getGateLeg(): Promise<GateLeg> {
    if (this.gateLegCache) return this.gateLegCache;
    const creds = await getAdminCreds('gateio');
    if (!creds) throw new Error('Gate.io credential not found (admin)');
    this.gateLegCache = new GateLeg(creds);
    return this.gateLegCache;
  }

  private async getBinanceLeg(): Promise<BinanceLeg> {
    if (this.binanceLegCache) return this.binanceLegCache;
    const creds = await getAdminCreds('binance');
    if (!creds) throw new Error('Binance credential not found (admin)');
    this.binanceLegCache = new BinanceLeg(creds);
    return this.binanceLegCache;
  }
}

export const usdtInventoryService = new UsdtInventoryService();
