// USDT권 재고형 아비(Gate↔MEXC) 오케스트레이션: 스캔→순차익 게이트→(자동)실행→기록
// - 실행 방향은 재고 배치상 고정: Gate에서 ALEO 매수 + MEXC에서 ALEO 매도(동시). 전송 없음.
// - 재고 소진(MEXC ALEO 또는 Gate USDT 부족) → 자동 정지(enabled=false) + 카톡
// - flatten_failed(터미널) → killSwitch ON + 봇 정지 + 긴급 카톡 (KRW inventory-arb.service와 동일 패턴)
// - autoExecute=false(반자동)면 기회를 감지해도 절대 발주하지 않음
import mainPrisma from '../../config/database';
import { getAdminCreds } from '../admin-credentials';
import { MexcLeg } from '../exchange/mexc-leg';
import { GateLeg } from '../exchange/gate-leg';
import { fetchGateioDepth, fetchMexcDepth } from '../multi-arb-depth.service';
import { computeNet } from '../multi-arb-net-calculator';
import { executeArb } from './executor';
import { checkInventoryStable, peekInventoryStable } from './inventory-stability';
import { kakaoNotifyService } from '../kakao-notify.service';
import type { BookLevel } from '../multi-arb-types';

// Gate taker 0.2% / MEXC taker 0.1% — 실측 미확정 시 보수적 상한값(더 낮은 실제 수수료면 net이 과소평가되어 안전측)
export const GATE_FEE_BPS = 20;
export const MEXC_FEE_BPS = 10;

const GATE_MIN_ORDER_USDT = 3; // GateLeg 최소주문(spec §0) — executor dust 임계로 그대로 전달
const MIN_BASE_UNIT = 1; // ALEO 등 정수 단위 최소 체결수량

// ── (a) 순수 판정 함수 (양방향) ────────────────────────────────────────────
export type UsdtArbDirection = 'buy_gate_sell_mexc' | 'buy_mexc_sell_gate';

export interface ShouldExecuteInput {
  gateAsk: number;
  gateBid: number;
  mexcAsk: number;
  mexcBid: number;
  gateAskLevels: BookLevel[];
  gateBidLevels: BookLevel[];
  mexcAskLevels: BookLevel[];
  mexcBidLevels: BookLevel[];
  gateAleoBalance: number;
  gateUsdtBalance: number;
  mexcAleoBalance: number;
  mexcUsdtBalance: number;
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
  buyExchange?: 'gateio' | 'mexc';
  sellExchange?: 'gateio' | 'mexc';
  qty?: number;
  buyPrice?: number;       // 매수 거래소 ask (지불)
  sellPrice?: number;      // 매도 거래소 bid (수취)
  flattenRefPrice?: number; // 매도 거래소 ask (net-short flatten 되사기 예산 기준)
  netSpreadPct?: number;
  reason?: string;
}

/**
 * 순수 판정 함수(I/O 없음). **양방향**:
 *  - 방향A(buy_gate_sell_mexc): MEXC가 비쌀 때(mexcBid>gateAsk) — Gate 매수 + MEXC 매도. 재고: MEXC ALEO(매도)+Gate USDT(매수).
 *  - 방향B(buy_mexc_sell_gate): Gate가 비쌀 때(gateBid>mexcAsk) — MEXC 매수 + Gate 매도. 재고: Gate ALEO(매도)+MEXC USDT(매수).
 * 두 방향 중 순차익 최대이면서 모든 게이트(깊이·임계·재고)를 통과하는 것을 선택.
 * 재고 소진은 자동정지가 아니라 skip(양방향이라 반대 방향/시세 변동으로 자가 리밸런싱됨).
 */
export function shouldExecute(input: ShouldExecuteInput): ShouldExecuteResult {
  const {
    gateAsk, gateBid, mexcAsk, mexcBid,
    gateAskLevels, gateBidLevels, mexcAskLevels, mexcBidLevels,
    gateAleoBalance, gateUsdtBalance, mexcAleoBalance, mexcUsdtBalance, bot,
  } = input;

  if (bot.killSwitch) return { go: false, reason: 'kill_switch' };

  interface Cand {
    direction: UsdtArbDirection;
    buyExchange: 'gateio' | 'mexc';
    sellExchange: 'gateio' | 'mexc';
    buyAsk: number; sellBid: number; sellAsk: number;
    buyLevels: BookLevel[]; sellLevels: BookLevel[];
    sellCoinBal: number; buyCashBal: number;
  }
  const candidates: Cand[] = [];
  // 방향A: MEXC 비쌈 → Gate 매수(ask) + MEXC 매도(bid)
  if (mexcBid > gateAsk) {
    candidates.push({
      direction: 'buy_gate_sell_mexc', buyExchange: 'gateio', sellExchange: 'mexc',
      buyAsk: gateAsk, sellBid: mexcBid, sellAsk: mexcAsk,
      buyLevels: gateAskLevels, sellLevels: mexcBidLevels,
      sellCoinBal: mexcAleoBalance, buyCashBal: gateUsdtBalance,
    });
  }
  // 방향B: Gate 비쌈 → MEXC 매수(ask) + Gate 매도(bid)
  if (gateBid > mexcAsk) {
    candidates.push({
      direction: 'buy_mexc_sell_gate', buyExchange: 'mexc', sellExchange: 'gateio',
      buyAsk: mexcAsk, sellBid: gateBid, sellAsk: gateAsk,
      buyLevels: mexcAskLevels, sellLevels: gateBidLevels,
      sellCoinBal: gateAleoBalance, buyCashBal: mexcUsdtBalance,
    });
  }
  if (candidates.length === 0) return { go: false, reason: 'no_gap_or_wrong_direction' };

  // 각 방향 평가 → 게이트 통과분 중 순차익 최대 선택
  let best: (ShouldExecuteResult & { netSpreadPct: number }) | null = null;
  let lastReason = 'net_spread_below_threshold';
  for (const c of candidates) {
    const qty = Math.floor(bot.orderUsdt / c.buyAsk);
    if (qty < MIN_BASE_UNIT) { lastReason = 'qty_below_min_base_unit'; continue; }
    const net = computeNet({
      buyLevels: c.buyLevels, sellLevels: c.sellLevels, minNotional: bot.orderUsdt,
      buyFeeBps: c.buyExchange === 'gateio' ? GATE_FEE_BPS : MEXC_FEE_BPS,
      sellFeeBps: c.sellExchange === 'gateio' ? GATE_FEE_BPS : MEXC_FEE_BPS,
      withdrawFee: null, thresholdPct: bot.thresholdPct,
    });
    if (!net.depthOk) { lastReason = 'depth_insufficient'; continue; }
    if (net.netSpreadPct < bot.thresholdPct) { lastReason = 'net_spread_below_threshold'; continue; }
    if (c.sellCoinBal < qty) { lastReason = 'sell_inventory_insufficient'; continue; }
    if (c.buyCashBal < bot.orderUsdt) { lastReason = 'buy_cash_insufficient'; continue; }
    if (!best || net.netSpreadPct > best.netSpreadPct) {
      best = {
        go: true, direction: c.direction, buyExchange: c.buyExchange, sellExchange: c.sellExchange,
        qty, buyPrice: c.buyAsk, sellPrice: c.sellBid, flattenRefPrice: c.sellAsk, netSpreadPct: net.netSpreadPct,
      };
    }
  }
  return best ?? { go: false, reason: lastReason };
}

// ── (b) 오케스트레이션 ──────────────────────────────────────────────────
class UsdtInventoryService {
  private mexcLegCache: MexcLeg | null = null;
  private gateLegCache: GateLeg | null = null;

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

      // 2. leg + depth + 잔고 조회
      const mexcLeg = await this.getMexcLeg();
      const gateLeg = await this.getGateLeg();
      const [gateDepth, mexcDepth] = await Promise.all([
        fetchGateioDepth(bot.symbol),
        fetchMexcDepth(bot.symbol),
      ]);
      if (!gateDepth || !mexcDepth) return; // 조회 실패 — 이번 사이클 skip
      if (gateDepth.askLevels.length === 0 || gateDepth.bidLevels.length === 0
        || mexcDepth.askLevels.length === 0 || mexcDepth.bidLevels.length === 0) return;

      // 양방향 판정을 위해 양쪽 거래소의 ALEO·USDT 4잔고 모두 조회
      const [mexcAleoBalance, mexcUsdtBalance, gateAleoBalance, gateUsdtBalance] = await Promise.all([
        mexcLeg.getBalance(bot.symbol),
        mexcLeg.getBalance('USDT'),
        gateLeg.getBalance(bot.symbol),
        gateLeg.getBalance('USDT'),
      ]);

      const gateAsk = gateDepth.askLevels[0].price;
      const gateBid = gateDepth.bidLevels[0].price;
      const mexcAsk = mexcDepth.askLevels[0].price;
      const mexcBid = mexcDepth.bidLevels[0].price;

      // 3. 양방향 게이트
      const decision = shouldExecute({
        gateAsk, gateBid, mexcAsk, mexcBid,
        gateAskLevels: gateDepth.askLevels, gateBidLevels: gateDepth.bidLevels,
        mexcAskLevels: mexcDepth.askLevels, mexcBidLevels: mexcDepth.bidLevels,
        gateAleoBalance, gateUsdtBalance, mexcAleoBalance, mexcUsdtBalance,
        bot,
      });

      if (!decision.go) {
        console.log(`[UsdtInventoryArb] bot ${bot.id} gate: ${decision.reason}`);
        return;
      }

      // 방향에 따라 leg·매도측 재고 결정
      const buyLeg = decision.buyExchange === 'gateio' ? gateLeg : mexcLeg;
      const sellLeg = decision.sellExchange === 'gateio' ? gateLeg : mexcLeg;
      const sellSideBalance = decision.sellExchange === 'mexc' ? mexcAleoBalance : gateAleoBalance;

      // 3.5 재고 안정화 게이트: 매도측 재고가 최근 무변동일 때만 실행(그리드봇 경합·자기 밀어올림 방지)
      const stab = checkInventoryStable(`usdt:${bot.id}`, sellSideBalance, bot.inventoryStableSec);
      if (!stab.stable) {
        console.log(`[UsdtInventoryArb] bot ${bot.id} 재고 안정화 대기 (${Math.ceil(stab.waitMs / 1000)}s 남음, ${decision.sellExchange}재고=${sellSideBalance})`);
        return;
      }

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
        minOrderQuote: GATE_MIN_ORDER_USDT,
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
  }): Promise<{
    symbol: string;
    gateAsk: number; gateBid: number; mexcAsk: number; mexcBid: number;
    topSpreadPct: number;      // 활성(최적) 방향의 실현 최우선호가 갭 %
    netSpreadPct: number;      // 활성 방향의 깊이 VWAP + 거래수수료 반영 순차익
    depthOk: boolean;
    thresholdPct: number;
    qty: number | null;        // 실행 예정 수량(조건 충족 시)
    direction: string;         // 활성 방향(buy_gate_sell_mexc | buy_mexc_sell_gate)
    mexcAleoBalance: number;
    gateUsdtBalance: number;
    gateAleoBalance: number;
    mexcUsdtBalance: number;
    decision: string;          // 'ready' | shouldExecute reason 코드
    autoExecute: boolean; enabled: boolean; killSwitch: boolean;
    fetchedAt: string;
    error?: string;
  }> {
    const base = {
      symbol: bot.symbol, thresholdPct: bot.thresholdPct,
      autoExecute: bot.autoExecute, enabled: bot.enabled, killSwitch: bot.killSwitch,
      fetchedAt: new Date().toISOString(),
    };
    try {
      const mexcLeg = await this.getMexcLeg();
      const gateLeg = await this.getGateLeg();
      const [gateDepth, mexcDepth] = await Promise.all([
        fetchGateioDepth(bot.symbol),
        fetchMexcDepth(bot.symbol),
      ]);
      const zeros = {
        gateAsk: 0, gateBid: 0, mexcAsk: 0, mexcBid: 0, topSpreadPct: 0, netSpreadPct: 0, depthOk: false,
        qty: null, direction: 'none', mexcAleoBalance: 0, gateUsdtBalance: 0, gateAleoBalance: 0, mexcUsdtBalance: 0,
      };
      if (!gateDepth || !mexcDepth || gateDepth.askLevels.length === 0 || gateDepth.bidLevels.length === 0
        || mexcDepth.askLevels.length === 0 || mexcDepth.bidLevels.length === 0) {
        return { ...base, ...zeros, decision: 'depth_unavailable', error: '호가 조회 실패' };
      }
      const [mexcAleoBalance, mexcUsdtBalance, gateAleoBalance, gateUsdtBalance] = await Promise.all([
        mexcLeg.getBalance(bot.symbol).catch(() => 0),
        mexcLeg.getBalance('USDT').catch(() => 0),
        gateLeg.getBalance(bot.symbol).catch(() => 0),
        gateLeg.getBalance('USDT').catch(() => 0),
      ]);
      const gateAsk = gateDepth.askLevels[0].price;
      const gateBid = gateDepth.bidLevels[0].price;
      const mexcAsk = mexcDepth.askLevels[0].price;
      const mexcBid = mexcDepth.bidLevels[0].price;

      // 양방향 실현 최우선호가 갭 → 큰 쪽을 활성 방향으로 표시
      const dirAPct = gateAsk > 0 ? ((mexcBid - gateAsk) / gateAsk) * 100 : -Infinity; // MEXC 비쌈
      const dirBPct = mexcAsk > 0 ? ((gateBid - mexcAsk) / mexcAsk) * 100 : -Infinity; // Gate 비쌈
      const activeIsA = dirAPct >= dirBPct;
      const netInput = activeIsA
        ? { buyLevels: gateDepth.askLevels, sellLevels: mexcDepth.bidLevels, buyFeeBps: GATE_FEE_BPS, sellFeeBps: MEXC_FEE_BPS }
        : { buyLevels: mexcDepth.askLevels, sellLevels: gateDepth.bidLevels, buyFeeBps: MEXC_FEE_BPS, sellFeeBps: GATE_FEE_BPS };
      const net = computeNet({ ...netInput, minNotional: bot.orderUsdt, withdrawFee: null, thresholdPct: bot.thresholdPct });

      const decision = shouldExecute({
        gateAsk, gateBid, mexcAsk, mexcBid,
        gateAskLevels: gateDepth.askLevels, gateBidLevels: gateDepth.bidLevels,
        mexcAskLevels: mexcDepth.askLevels, mexcBidLevels: mexcDepth.bidLevels,
        gateAleoBalance, gateUsdtBalance, mexcAleoBalance, mexcUsdtBalance,
        bot: { symbol: bot.symbol, thresholdPct: bot.thresholdPct, orderUsdt: bot.orderUsdt, killSwitch: bot.killSwitch },
      });

      return {
        ...base,
        gateAsk, gateBid, mexcAsk, mexcBid,
        topSpreadPct: activeIsA ? dirAPct : dirBPct,
        netSpreadPct: net.netSpreadPct,
        depthOk: net.depthOk,
        qty: decision.go ? decision.qty ?? null : null,
        direction: decision.go ? decision.direction! : (activeIsA ? 'buy_gate_sell_mexc' : 'buy_mexc_sell_gate'),
        mexcAleoBalance, gateUsdtBalance, gateAleoBalance, mexcUsdtBalance,
        decision: (() => {
          if (!decision.go) return decision.reason ?? 'unknown';
          const stab = bot.enabled ? peekInventoryStable(`usdt:${bot.id}`, bot.inventoryStableSec) : { stable: true, waitMs: 0 };
          return stab.stable ? 'ready' : `재고 안정화 대기 (${Math.ceil(stab.waitMs / 1000)}s)`;
        })(),
      };
    } catch (err: any) {
      return {
        ...base, gateAsk: 0, gateBid: 0, mexcAsk: 0, mexcBid: 0, topSpreadPct: 0, netSpreadPct: 0, depthOk: false,
        qty: null, direction: 'none', mexcAleoBalance: 0, gateUsdtBalance: 0, gateAleoBalance: 0, mexcUsdtBalance: 0,
        decision: 'error', error: err?.message ?? String(err),
      };
    }
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
}

export const usdtInventoryService = new UsdtInventoryService();
