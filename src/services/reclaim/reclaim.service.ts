import mainPrisma from '../../config/database';
import { config } from '../../config/env';
import { decrypt } from '../../utils/encryption';
import { UpbitService } from '../upbit.service';
import { BithumbClient } from '../exchange/bithumb-client';
import { UpbitLeg, BithumbLeg, type ExchangeLeg } from '../exchange-leg';
import { fetchOrderbookDepth, fetchUpbitDepthBatch } from '../inventory-arb/orderbook-depth';
import { inventoryArbService } from '../inventory-arb.service';
import { selectReclaimTargets } from './target-selector';
import { shouldReclaim, RECLAIM_FEE_BPS } from './net';
import { computeReclaimQty } from './sizing';
import { checkReclaimGate } from './gate';
import { executeReclaim } from './executor';

const UPBIT_BUY_FEE_BPS = 5;
const MIN_ORDER_KRW = 5000;
const KST = 9 * 3600 * 1000;

function kstDayStart(): Date {
  const n = new Date(Date.now() + KST);
  n.setUTCHours(0, 0, 0, 0);
  return new Date(n.getTime() - KST);
}

class ReclaimService {
  private upbitLegs = new Map<number, ExchangeLeg>();
  private bithumbLegs = new Map<number, ExchangeLeg>();
  private upbitMarketsCache: { at: number; set: Set<string> } | null = null;

  private async adminUserId(): Promise<number | null> {
    if (!config.adminEmail) return null;
    const u = await mainPrisma.user.findFirst({ where: { email: config.adminEmail }, select: { id: true } });
    return u?.id ?? null;
  }

  private async getLegs(userId: number): Promise<{ upbit: ExchangeLeg; bithumb: ExchangeLeg }> {
    if (!this.upbitLegs.has(userId)) {
      const c = await mainPrisma.credential.findFirst({ where: { userId, exchange: 'upbit' } });
      if (!c) throw new Error('upbit cred 없음');
      const creds = { accessKey: decrypt(c.apiKey), secretKey: decrypt(c.secretKey) };
      this.upbitLegs.set(userId, new UpbitLeg(new UpbitService(creds)));
    }
    if (!this.bithumbLegs.has(userId)) {
      const c = await mainPrisma.credential.findFirst({ where: { userId, exchange: 'bithumb' } });
      if (!c) throw new Error('bithumb cred 없음');
      this.bithumbLegs.set(userId, new BithumbLeg(new BithumbClient({ accessKey: decrypt(c.apiKey), secretKey: decrypt(c.secretKey) })));
    }
    return { upbit: this.upbitLegs.get(userId)!, bithumb: this.bithumbLegs.get(userId)! };
  }

  private async upbitMarkets(): Promise<Set<string>> {
    if (this.upbitMarketsCache && Date.now() - this.upbitMarketsCache.at < 3600_000) return this.upbitMarketsCache.set;
    const r = await fetch('https://api.upbit.com/v1/market/all');
    const arr = await r.json();
    const set = new Set<string>((arr as any[]).filter((m) => String(m.market).startsWith('KRW-')).map((m) => String(m.market).slice(4)));
    this.upbitMarketsCache = { at: Date.now(), set };
    return set;
  }

  async getConfig(userId: number) {
    return mainPrisma.arbReclaimConfig.upsert({ where: { userId }, update: {}, create: { userId } });
  }

  async putConfig(userId: number, data: Record<string, any>) {
    return mainPrisma.arbReclaimConfig.upsert({ where: { userId }, update: data, create: { userId, ...data } });
  }

  private async todayUsage(userId: number) {
    const rows = await mainPrisma.arbReclaimTrade.findMany({
      where: { userId, createdAt: { gte: kstDayStart() }, status: { in: ['filled', 'partial'] } },
      select: { qty: true, upbitBuyPrice: true, sellFilled: true, buyFilled: true },
    });
    const count = rows.length;
    const notionalKrw = rows.reduce((s, r) => s + r.qty * r.upbitBuyPrice, 0);
    const imbalanceKrw = rows.reduce((s, r) => s + Math.abs(r.sellFilled - r.buyFilled) * r.upbitBuyPrice, 0);
    return { count, notionalKrw, imbalanceKrw };
  }

  /** 에이전트가 주기 호출. 게이트 통과 시 대상 스캔 → 순차익≥임계 → 사이징 → 집행 → 기록. */
  async scanOnce(): Promise<void> {
    const userId = await this.adminUserId();
    if (userId == null) return;
    const cfg = await this.getConfig(userId);
    const usage = await this.todayUsage(userId);
    const gate = checkReclaimGate({
      enabled: cfg.enabled, killSwitch: cfg.killSwitch,
      todayCount: usage.count, dailyMaxCount: cfg.dailyMaxCount,
      todayNotionalKrw: usage.notionalKrw, dailyMaxKrw: cfg.dailyMaxKrw,
      imbalanceKrw: usage.imbalanceKrw, imbalanceCapKrw: cfg.imbalanceCapKrw,
    });
    if (!gate.ok) {
      if (gate.reason === 'imbalanceCap') console.warn('[Reclaim] 불균형 한도 — 스캔 정지');
      return;
    }

    const holdings = await inventoryArbService.getKrwHoldings(userId);
    const markets = await this.upbitMarkets();
    // 대상 선별 (출금수수료율은 별도 캐시 로직 — 초기엔 빈 객체로 두어 미확인=포함, 후속 캐시 채움)
    const targets = selectReclaimTargets({
      holdings: holdings.bithumb, upbitMarkets: markets, withdrawFeePct: {}, thresholdPct: cfg.withdrawFeePctThreshold,
    });
    if (targets.length === 0) return;

    const legs = await this.getLegs(userId);
    const upbitDepth = await fetchUpbitDepthBatch(targets);
    for (const sym of targets) {
      try {
        const up = upbitDepth.get(sym);
        const bt = await fetchOrderbookDepth('bithumb', sym);
        if (!up || !bt) continue;
        if (!shouldReclaim(bt.bid, up.ask, cfg.minNetPct, RECLAIM_FEE_BPS)) continue;
        const qty = computeReclaimQty({
          bithumbBidQty: bt.bidQty, upbitAskQty: up.askQty,
          bithumbHolding: holdings.bithumb[sym] ?? 0, upbitKrw: holdings.upbit['KRW'] ?? 0,
          upbitAsk: up.ask, maxOrderKrw: cfg.maxOrderKrw, feeBps: UPBIT_BUY_FEE_BPS,
        });
        if (qty * up.ask < MIN_ORDER_KRW) continue;
        const r = await executeReclaim({ bithumbLeg: legs.bithumb, upbitLeg: legs.upbit, symbol: sym, qty, bithumbBid: bt.bid, upbitAsk: up.ask });
        await mainPrisma.arbReclaimTrade.create({
          data: {
            userId, symbol: sym, qty, bithumbSellPrice: bt.bid, upbitBuyPrice: up.ask,
            sellFilled: r.sellFilled, buyFilled: r.buyFilled,
            grossKrw: Math.round(r.sellGrossKrw - r.buyGrossKrw), feeKrw: Math.round(r.feeKrw), netKrw: Math.round(r.netKrw),
            status: r.status, note: r.note,
          },
        });
        console.log(`[Reclaim] ${sym} ${r.status} net ${Math.round(r.netKrw)} (${r.note})`);
      } catch (e: any) {
        console.error(`[Reclaim] ${sym} 실패:`, e?.message);
      }
    }
  }

  async getStatus(userId: number) {
    const cfg = await this.getConfig(userId);
    const usage = await this.todayUsage(userId);
    const recent = await mainPrisma.arbReclaimTrade.findMany({ where: { userId }, orderBy: { id: 'desc' }, take: 10 });
    return { config: cfg, today: usage, recentTrades: recent };
  }
}

export const reclaimService = new ReclaimService();
