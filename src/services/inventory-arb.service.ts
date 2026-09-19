// 재고형 아비 오케스트레이션 서비스: 봇별 감지→게이트→(자동 실행 or 알림)→기록
// - flatten_failed(터미널) 발생 시 killSwitch ON + 봇 정지 + 긴급 카톡, 재시도 금지
// - record-before-fire: leg 발주 전에 pending(detected) 행을 먼저 생성
// - 봇별 in-flight 락으로 동시 중복 실행 방지
import mainPrisma from '../config/database';
import { decrypt } from '../utils/encryption';
import { UpbitService } from './upbit.service';
import { UpbitClient } from './exchange/upbit-client';
import { BithumbClient } from './exchange/bithumb-client';
import { UpbitLeg, BithumbLeg, type ExchangeLeg } from './exchange-leg';
import { detectOpportunity } from './inventory-arb/spread-detector';
import { evaluateFeasibility } from './inventory-arb/feasibility-gate';
import { executeArb } from './inventory-arb/executor';
import type { BookTop, ExchangeName, ExecutorResult, SpreadOpportunity } from './inventory-arb/types';
import { kakaoNotifyService } from './kakao-notify.service';

// ── 순수 결정 헬퍼 (테스트 대상) ──────────────────────────────────────────
export function decideAction(bot: { enabled: boolean; killSwitch: boolean; autoExecute: boolean }):
  { action: 'skip' | 'execute' | 'notify' } {
  if (bot.killSwitch || !bot.enabled) return { action: 'skip' };
  return { action: bot.autoExecute ? 'execute' : 'notify' };
}

export function buildEmergencyMessage(symbol: string, imbalanceQty: number, note: string): string {
  return `🚨 재고형 아비 flatten 실패 — ${symbol} 방향노출 ${imbalanceQty} 잔존!\n봇 killSwitch ON + 정지됨. 수동 확인 필요.\n(${note})`;
}

// ── 동시성 락: 같은 봇 중복 실행 방지 ────────────────────────────────────
const inFlightBots = new Set<number>();

/**
 * userId별 업비트 클라이언트 묶음.
 * - client(UpbitClient): getOrderbookTop/getBalances 등 ExchangeClient 인터페이스 (public REST, 인증 불필요)
 * - service(UpbitService): ExchangeLeg(UpbitLeg) 생성용 — 실주문/인증 API
 * UpbitClient 내부에도 UpbitService가 있으나 private이라 꺼낼 수 없어, 같은 자격증명으로 둘 다 생성한다.
 * (둘 다 상태 없는 HTTP 클라이언트라 중복 비용 무시 가능)
 */
interface UpbitBundle {
  client: UpbitClient;
  service: UpbitService;
}

class InventoryArbService {
  private upbitClients = new Map<number, UpbitBundle>();
  private bithumbClients = new Map<number, BithumbClient>();

  /** 에이전트가 사이클마다 호출 */
  async scanOnce(): Promise<void> {
    const bots = await mainPrisma.inventoryArbBot.findMany({ where: { enabled: true, killSwitch: false } });
    for (const bot of bots) {
      if (inFlightBots.has(bot.id)) continue;
      inFlightBots.add(bot.id);
      try {
        await this.processBot(bot);
      } catch (err: any) {
        console.error(`[InventoryArb] bot ${bot.id} 처리 실패:`, err.message);
      } finally {
        inFlightBots.delete(bot.id);
      }
    }
  }

  private async processBot(bot: any): Promise<void> {
    // 1. 양쪽 호가 (top-level REST) — spec §6 대비 축소(선행조건: canary 확대 전 full-depth)
    const upbit = await this.getUpbit(bot.userId);
    const bithumbClient = await this.getBithumb(bot.userId);
    const [upbitTop, bithumbTop] = await Promise.all([
      upbit.client.getOrderbookTop(bot.symbol),
      bithumbClient.getOrderbookTop(bot.symbol),
    ]);
    if (!upbitTop || !bithumbTop) return;

    const upbitBook: BookTop = { bid: upbitTop.bid, ask: upbitTop.ask, bidQty: upbitTop.bidQty, askQty: upbitTop.askQty };
    const bithumbBook: BookTop = { bid: bithumbTop.bid, ask: bithumbTop.ask, bidQty: bithumbTop.bidQty, askQty: bithumbTop.askQty };

    // 2. 감지
    const opp = detectOpportunity(upbitBook, bithumbBook);
    if (!opp) return;

    // 3. 잔고 조회 (게이트 사이징용 — 매도측 코인, 매수측 KRW)
    const { sellCoinBalance, buyKrwBalance } =
      await this.fetchBalances(bot, opp, upbit.service, bithumbClient);

    // 4. 오늘 집행량
    const { todayNotionalKrw, todayCount } = await this.fetchTodayUsage(bot.id);

    // 5. 게이트
    const feas = evaluateFeasibility({
      opp, minSpreadBps: bot.minSpreadBps, anomalyMaxBps: bot.anomalyMaxBps,
      maxOrderKrw: bot.maxOrderKrw, dailyMaxKrw: bot.dailyMaxKrw, dailyMaxCount: bot.dailyMaxCount,
      todayNotionalKrw, todayCount, sellCoinBalance, buyKrwBalance, buyFeeBps: bot.buyFeeBps,
    });
    if (!feas.ok) {
      console.log(`[InventoryArb] bot ${bot.id} gate: ${feas.reason}`);
      return;
    }

    // 6. 실행 여부 결정
    const decision = decideAction(bot);
    if (decision.action === 'notify') {
      await this.notifyOpportunity(bot, opp, feas);
      await this.recordDetected(bot, opp, feas);
      return;
    }

    // 7. record-before-fire
    const trade = await mainPrisma.inventoryArbTrade.create({
      data: {
        botId: bot.id, symbol: bot.symbol, direction: opp.direction, qty: feas.qty,
        buyExchange: opp.buyExchange, buyPrice: opp.buyPrice,
        sellExchange: opp.sellExchange, sellPrice: opp.sellPrice,
        notionalKrw: feas.notionalKrw, status: 'detected', note: `pre-fire spread=${opp.spreadBps}bp`,
      },
    });

    // 8. ExchangeLeg 매핑
    const { buyLeg, sellLeg } = this.buildLegs(opp, upbit.service, bithumbClient);

    // 9. 실행 (flatten 가능 여부는 executor가 실제 주문 결과로 판정 — 사전 잔고 전달 불필요)
    const result = await executeArb({
      buyLeg, sellLeg, symbol: bot.symbol, qty: feas.qty,
      buyPrice: opp.buyPrice, sellPrice: opp.sellPrice, fallbackMode: bot.fallbackMode,
    });

    // 10. 결과 기록 + 후처리
    await this.persistResult(bot, trade.id, opp, feas, result);
  }

  private async persistResult(bot: any, tradeId: number, opp: SpreadOpportunity, feas: any, result: ExecutorResult): Promise<void> {
    const now = new Date();
    const base = { status: result.kind, executedAt: now };
    if (result.kind === 'filled' || result.kind === 'partial_flattened') {
      const gross = result.sellGrossKrw - result.buyGrossKrw;
      await mainPrisma.inventoryArbTrade.update({
        where: { id: tradeId },
        data: { ...base, grossKrw: +gross.toFixed(4), feeKrw: +result.feeKrw.toFixed(4), netKrw: +result.netKrw.toFixed(4), note: result.note },
      });
      await this.notifyResult(bot, opp, result);
    } else if (result.kind === 'flatten_failed') {
      // 터미널: killSwitch ON + 봇 정지 + 긴급 카톡. 재시도 금지.
      await mainPrisma.inventoryArbBot.update({ where: { id: bot.id }, data: { killSwitch: true, enabled: false } });
      await mainPrisma.inventoryArbTrade.update({ where: { id: tradeId }, data: { ...base, note: result.note } });
      try { await kakaoNotifyService.sendToMe(buildEmergencyMessage(bot.symbol, result.imbalanceQty, result.note)); } catch {}
    } else {
      // partial_hold | failed
      await mainPrisma.inventoryArbTrade.update({ where: { id: tradeId }, data: { ...base, note: result.kind === 'partial_hold' ? result.note : result.reason } });
    }
  }

  // ── 아래 헬퍼는 maker-taker-simulator-agent.ts 패턴을 그대로 따른다 ──
  private async getUpbit(userId: number): Promise<UpbitBundle> {
    const cached = this.upbitClients.get(userId);
    if (cached) return cached;
    const cred = await mainPrisma.credential.findFirst({ where: { userId, exchange: 'upbit' } });
    if (!cred) throw new Error(`Upbit credential not found: userId=${userId}`);
    const creds = { accessKey: decrypt(cred.apiKey), secretKey: decrypt(cred.secretKey) };
    // UpbitClient(오더북/잔고 조회용)와 UpbitService(ExchangeLeg 실주문용)를 같은 자격증명으로 각각 생성.
    // UpbitClient 내부에 UpbitService가 있으나 private이라 재사용 불가 — 둘 다 상태 없는 HTTP 클라이언트라 무해.
    const bundle: UpbitBundle = { client: new UpbitClient(creds), service: new UpbitService(creds) };
    this.upbitClients.set(userId, bundle);
    return bundle;
  }

  private async getBithumb(userId: number): Promise<BithumbClient> {
    const cached = this.bithumbClients.get(userId);
    if (cached) return cached;
    const cred = await mainPrisma.credential.findFirst({ where: { userId, exchange: 'bithumb' } });
    if (!cred) throw new Error(`Bithumb credential not found: userId=${userId}`);
    const c = new BithumbClient({ accessKey: decrypt(cred.apiKey), secretKey: decrypt(cred.secretKey) });
    this.bithumbClients.set(userId, c);
    return c;
  }

  private buildLegs(opp: SpreadOpportunity, upbit: UpbitService, bithumb: BithumbClient): { buyLeg: ExchangeLeg; sellLeg: ExchangeLeg } {
    const upbitLeg = new UpbitLeg(upbit);
    const bithumbLeg = new BithumbLeg(bithumb);
    return opp.buyExchange === 'upbit'
      ? { buyLeg: upbitLeg, sellLeg: bithumbLeg }
      : { buyLeg: bithumbLeg, sellLeg: upbitLeg };
  }

  private async fetchBalances(bot: any, opp: SpreadOpportunity, upbit: UpbitService, bithumb: BithumbClient):
    Promise<{ sellCoinBalance: number; buyKrwBalance: number }> {
    // 게이트 사이징용 잔고만 조회. flatten 잔고는 executor가 실제 주문 결과로 판정하므로 불필요.
    // 업비트: getAccounts() → {currency, balance}; 빗썸: getBalances() → {available}
    const upbitAccounts = await upbit.getAccounts(); // any[]
    const upbitBal = (cur: string) => Number(upbitAccounts.find((a: any) => a.currency === cur)?.balance ?? 0);
    const bithumbBalances = await bithumb.getBalances(); // Record<string,{available}>
    const bithumbBal = (cur: string) => bithumbBalances[cur]?.available ?? 0;

    const coinOf = (ex: ExchangeName, type: 'coin' | 'krw') =>
      ex === 'upbit'
        ? (type === 'coin' ? upbitBal(bot.symbol) : upbitBal('KRW'))
        : (type === 'coin' ? bithumbBal(bot.symbol) : bithumbBal('KRW'));

    return {
      sellCoinBalance: coinOf(opp.sellExchange, 'coin'), // 매도측 코인 재고 (매도 사이징)
      buyKrwBalance: coinOf(opp.buyExchange, 'krw'), // 매수측 KRW (매수 사이징)
    };
  }

  private async fetchTodayUsage(botId: number): Promise<{ todayNotionalKrw: number; todayCount: number }> {
    const start = new Date(); start.setHours(0, 0, 0, 0); // 서버 로컬 자정 (KST 서버 가정, 배포시 확인)
    const rows = await mainPrisma.inventoryArbTrade.findMany({
      where: { botId, executedAt: { gte: start }, status: { in: ['filled', 'partial_flattened'] } },
      select: { notionalKrw: true },
    });
    return { todayNotionalKrw: rows.reduce((s, r) => s + r.notionalKrw, 0), todayCount: rows.length };
  }

  private async recordDetected(bot: any, opp: SpreadOpportunity, feas: any): Promise<void> {
    await mainPrisma.inventoryArbTrade.create({
      data: {
        botId: bot.id, symbol: bot.symbol, direction: opp.direction, qty: feas.qty,
        buyExchange: opp.buyExchange, buyPrice: opp.buyPrice, sellExchange: opp.sellExchange, sellPrice: opp.sellPrice,
        notionalKrw: feas.notionalKrw, status: 'detected', note: `반자동 감지 spread=${opp.spreadBps}bp (미실행)`,
      },
    });
  }

  private async notifyOpportunity(bot: any, opp: SpreadOpportunity, feas: any): Promise<void> {
    const msg = `🔔 재고형 아비 기회 · ${bot.symbol}\n방향: ${opp.direction}\n스프레드: ${opp.spreadBps}bp\n예상 물량: ${feas.qty} (≈${Math.round(feas.notionalKrw)} KRW)\n※ 반자동 모드 — 실행 안 함`;
    try { await kakaoNotifyService.sendToMe(msg); } catch (e: any) { console.error('[InventoryArb] 카톡 실패:', e.message); }
  }

  private async notifyResult(bot: any, opp: SpreadOpportunity, result: ExecutorResult): Promise<void> {
    if (result.kind !== 'filled' && result.kind !== 'partial_flattened') return;
    const tag = result.kind === 'partial_flattened' ? '⚠️부분체결→flatten' : '✅체결';
    const msg = `${tag} 재고형 아비 · ${bot.symbol}\n${opp.direction} netKrw=${result.netKrw}\n${result.note}`;
    try { await kakaoNotifyService.sendToMe(msg); } catch (e: any) { console.error('[InventoryArb] 카톡 실패:', e.message); }
  }
}

export const inventoryArbService = new InventoryArbService();
