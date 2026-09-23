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
import { kakaoNotifyService } from '../kakao-notify.service';
import type { BookLevel } from '../multi-arb-types';

// Gate taker 0.2% / MEXC taker 0.1% — 실측 미확정 시 보수적 상한값(더 낮은 실제 수수료면 net이 과소평가되어 안전측)
export const GATE_FEE_BPS = 20;
export const MEXC_FEE_BPS = 10;

const GATE_MIN_ORDER_USDT = 3; // GateLeg 최소주문(spec §0) — executor dust 임계로 그대로 전달
const MIN_BASE_UNIT = 1; // ALEO 등 정수 단위 최소 체결수량

// ── (a) 순수 판정 함수 ──────────────────────────────────────────────────
export interface ShouldExecuteInput {
  gateAsk: number;
  gateBid: number;
  mexcAsk: number;
  mexcBid: number;
  gateAskLevels: BookLevel[];
  mexcBidLevels: BookLevel[];
  mexcAleoBalance: number;
  gateUsdtBalance: number;
  bot: {
    symbol: string;
    thresholdPct: number;
    orderUsdt: number;
    killSwitch: boolean;
  };
}

export interface ShouldExecuteResult {
  go: boolean;
  qty?: number;
  buyPrice?: number;
  sellPrice?: number;
  reason?: string;
  stop?: boolean; // true = 재고 소진 등 자동정지 신호
}

/**
 * 순수 판정 함수(I/O 없음). 방향 게이트 → 재고 배치상 실행 가능은
 * "MEXC에서 매도(bid) + Gate에서 매수(ask)"뿐이므로 mexcBid > gateAsk일 때만 검토한다.
 */
export function shouldExecute(input: ShouldExecuteInput): ShouldExecuteResult {
  const { gateAsk, mexcBid, gateAskLevels, mexcBidLevels, mexcAleoBalance, gateUsdtBalance, bot } = input;

  // killSwitch가 최우선 — 재고 소진 stop 신호보다 먼저 걸려야 불필요한 자동정지 알림을 막는다.
  if (bot.killSwitch) return { go: false, reason: 'kill_switch' };

  // 방향 게이트: MEXC가 더 비쌀 때만 재고 배치상 실행 가능(MEXC 매도 + Gate 매수)
  if (!(mexcBid > gateAsk)) {
    return { go: false, reason: 'no_gap_or_wrong_direction' };
  }

  // 목표 수량: orderUsdt만큼 Gate에서 매수할 수 있는 ALEO 수량, 정수 절사(최소 base 단위=1)
  const qty = Math.floor(bot.orderUsdt / gateAsk);
  if (qty < MIN_BASE_UNIT) {
    return { go: false, reason: 'qty_below_min_base_unit' };
  }

  // 순차익 계산 — 재고형은 전송 없음 → withdrawFee null, 폴백 미적용(0)
  const net = computeNet({
    buyLevels: gateAskLevels,
    sellLevels: mexcBidLevels,
    minNotional: bot.orderUsdt,
    buyFeeBps: GATE_FEE_BPS,
    sellFeeBps: MEXC_FEE_BPS,
    withdrawFee: null,
    thresholdPct: bot.thresholdPct,
  });

  if (!net.depthOk) {
    return { go: false, reason: 'depth_insufficient' };
  }
  if (net.netSpreadPct < bot.thresholdPct) {
    return { go: false, reason: 'net_spread_below_threshold' };
  }

  // 재고 가드 — 소진 시 자동정지 신호(stop:true)
  if (mexcAleoBalance < qty) {
    return { go: false, reason: 'mexc_aleo_drained', stop: true };
  }
  if (gateUsdtBalance < bot.orderUsdt) {
    return { go: false, reason: 'gate_usdt_low', stop: true };
  }

  return { go: true, qty, buyPrice: gateAsk, sellPrice: mexcBid };
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
      if (gateDepth.askLevels.length === 0 || mexcDepth.bidLevels.length === 0) return;

      const [mexcAleoBalance, gateUsdtBalance] = await Promise.all([
        mexcLeg.getBalance(bot.symbol),
        gateLeg.getBalance('USDT'),
      ]);

      const gateAsk = gateDepth.askLevels[0].price;
      const gateBid = gateDepth.bidLevels[0]?.price ?? gateAsk;
      const mexcAsk = mexcDepth.askLevels[0]?.price ?? mexcDepth.bidLevels[0].price;
      const mexcBid = mexcDepth.bidLevels[0].price;

      // 3. 게이트
      const decision = shouldExecute({
        gateAsk,
        gateBid,
        mexcAsk,
        mexcBid,
        gateAskLevels: gateDepth.askLevels,
        mexcBidLevels: mexcDepth.bidLevels,
        mexcAleoBalance,
        gateUsdtBalance,
        bot,
      });

      if (decision.stop) {
        const reasonLabel = decision.reason === 'mexc_aleo_drained' ? 'MEXC ALEO 소진' : 'Gate USDT 부족';
        await this.autoStop(bot.id, bot.symbol, `${reasonLabel} — 리밸런싱 필요`);
        return;
      }
      if (!decision.go) {
        console.log(`[UsdtInventoryArb] bot ${bot.id} gate: ${decision.reason}`);
        return;
      }

      // 4. 반자동(autoExecute=false) — 감지만, 발주 금지
      if (!bot.autoExecute) {
        console.log(`[UsdtInventoryArb] bot ${bot.id} detected (반자동, 미실행) qty=${decision.qty}`);
        return;
      }

      // 5. 실행 (record-before-fire)
      const trade = await mainPrisma.usdtInventoryArbTrade.create({
        data: {
          botId: bot.id,
          symbol: bot.symbol,
          buyExchange: 'gateio',
          sellExchange: 'mexc',
          qty: decision.qty!,
          buyPrice: decision.buyPrice!,
          sellPrice: decision.sellPrice!,
          status: 'detected',
          note: 'pre-fire',
        },
      });

      const result = await executeArb({
        buyLeg: gateLeg,
        sellLeg: mexcLeg,
        symbol: bot.symbol,
        qty: decision.qty!,
        buyPrice: decision.buyPrice!,
        sellPrice: decision.sellPrice!,
        fallbackMode: 'market_flatten',
        minOrderQuote: GATE_MIN_ORDER_USDT,
        flattenBuyRefPrice: mexcAsk,
      });

      // 6. 결과 기록 + 후처리
      await this.persistResult(bot, trade.id, result);
    } catch (err: any) {
      console.error(`[UsdtInventoryArb] bot ${bot.id} 처리 실패:`, err.message);
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
