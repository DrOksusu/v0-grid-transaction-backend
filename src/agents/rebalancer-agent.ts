/**
 * RebalancerAgent
 *
 * 거래소별로 스테이블코인 가용 잔고가 5000개를 초과하면
 * 수수료를 커버하는 스프레드가 있을 때 초과분을 다른 코인으로 스왑한다.
 *
 * 수수료 (편도 bps):  업비트 5bp / 빗썸 4bp / 코인원 2bp
 * 실행 조건:          (sellCoin_bid - buyCoin_ask) / buyCoin_ask × 10000 ≥ 편도×2
 * 사이클:             60초마다
 * 쿨다운:             거래소당 실행 후 30분
 */

import { BaseAgent } from './base-agent';
import mainPrisma from '../config/database';
import { stablecoinPrisma as prisma } from '../config/database';
import { UpbitService } from '../services/upbit.service';
import { BalanceCache } from '../services/upbit-balance-cache';
import { BithumbClient } from '../services/exchange/bithumb-client';
import { CoinoneClient } from '../services/exchange/coinone-client';
import { UpbitLeg, BithumbLeg, CoinoneLeg } from '../services/exchange-leg';
import { decrypt } from '../utils/encryption';
import {
  getUpbitOrderbookForTrading,
  subscribeStablecoinOrderbooks,
  unsubscribeStablecoinOrderbooks,
} from '../services/upbit-price-manager';
import {
  getBithumbOrderbookForTrading,
  subscribeBithumbStablecoinOrderbooks,
  unsubscribeBithumbStablecoinOrderbooks,
} from '../services/bithumb-stablecoin-ws-manager';
import {
  getCoinoneOrderbookForTrading,
  subscribeCoinoneStablecoinOrderbooks,
  unsubscribeCoinoneStablecoinOrderbooks,
} from '../services/coinone-stablecoin-price-manager';

const STABLECOINS = ['USDS', 'USDT', 'USDC', 'USDE', 'USD1'] as const;
type Stablecoin = (typeof STABLECOINS)[number];

const THRESHOLD = 5_000;
const COOLDOWN_MS = 30 * 60 * 1000;
const MIN_SWAP_QTY = 10;

// 편도 수수료 bps (round-trip = × 2)
const FEE_BPS_PER_LEG: Record<string, number> = {
  upbit: 5,
  bithumb: 4,
  coinone: 2,
};

interface BookPrice {
  bid: number;
  ask: number;
}

export class RebalancerAgent extends BaseAgent {
  private upbitClients = new Map<number, { upbit: UpbitService; cache: BalanceCache }>();
  private bithumbClients = new Map<number, BithumbClient>();
  private coinoneClients = new Map<number, CoinoneClient>();

  private bithumbBalanceCaches = new Map<number, { data: Record<string, number>; at: number }>();
  private coinoneBalanceCaches = new Map<number, { data: Record<string, number>; at: number }>();

  // `${userId}:${exchange}` → 쿨다운 만료 시각 (ms)
  private cooldownMap = new Map<string, number>();

  constructor() {
    super({
      id: 'rebalancer',
      name: 'RebalancerAgent',
      description: '스테이블코인 5000개 초과 시 수수료 이상 스프레드 조건에서 자동 스왑',
      cycleIntervalMs: 60_000,
    });
  }

  protected async onStart(): Promise<void> {
    subscribeStablecoinOrderbooks();
    subscribeBithumbStablecoinOrderbooks();
    subscribeCoinoneStablecoinOrderbooks();
    console.log('[RebalancerAgent] 호가 구독 시작');
  }

  protected async onStop(): Promise<void> {
    unsubscribeStablecoinOrderbooks();
    unsubscribeBithumbStablecoinOrderbooks();
    unsubscribeCoinoneStablecoinOrderbooks();
    this.upbitClients.clear();
    this.bithumbClients.clear();
    this.coinoneClients.clear();
    this.bithumbBalanceCaches.clear();
    this.coinoneBalanceCaches.clear();
  }

  protected async onCycle(): Promise<void> {
    const botRows = await (prisma.makerTakerSimBot as any).findMany({
      where: { enabled: true },
      select: { userId: true },
      distinct: ['userId'],
    });
    const userIds: number[] = botRows.map((r: any) => r.userId);
    if (userIds.length === 0) return;

    for (const userId of userIds) {
      await this.rebalanceUser(userId);
    }
  }

  private async rebalanceUser(userId: number): Promise<void> {
    for (const exchange of ['upbit', 'bithumb', 'coinone'] as const) {
      await this.rebalanceOnExchange(userId, exchange);
    }
  }

  private isCoolingDown(userId: number, exchange: string): boolean {
    const key = `${userId}:${exchange}`;
    const expireAt = this.cooldownMap.get(key);
    if (!expireAt) return false;
    if (Date.now() >= expireAt) {
      this.cooldownMap.delete(key);
      return false;
    }
    return true;
  }

  private setCooldown(userId: number, exchange: string): void {
    const key = `${userId}:${exchange}`;
    this.cooldownMap.set(key, Date.now() + COOLDOWN_MS);
    console.log(`[RebalancerAgent] userId=${userId} ${exchange} 쿨다운 30분 시작`);
  }

  private async rebalanceOnExchange(userId: number, exchange: string): Promise<void> {
    try {
      if (this.isCoolingDown(userId, exchange)) return;

      const balances = await this.getBalances(userId, exchange);
      if (!balances) return;

      const minSpreadBps = (FEE_BPS_PER_LEG[exchange] ?? 5) * 2;

      for (const sellCoin of STABLECOINS) {
        const sellBalance = balances[sellCoin] ?? 0;
        if (sellBalance <= THRESHOLD) continue;

        const excessQty = Math.floor(sellBalance - THRESHOLD);
        if (excessQty < MIN_SWAP_QTY) continue;

        const best = this.findBestBuyCoin(sellCoin, balances, exchange, minSpreadBps);
        if (!best) {
          console.log(
            `[RebalancerAgent] userId=${userId} ${exchange} ${sellCoin} 초과=${excessQty} — 수익성 있는 매수 대상 없음`,
          );
          continue;
        }

        const { buyCoin, sellBid, buyAsk, spreadBps } = best;
        console.log(
          `[RebalancerAgent] userId=${userId} ${exchange} ${sellCoin}→${buyCoin} ` +
            `${excessQty}개 | spread=${spreadBps.toFixed(1)}bp (최소 ${minSpreadBps}bp)`,
        );

        await this.executeSwap(userId, exchange, sellCoin, buyCoin, excessQty, sellBid, buyAsk);
        this.setCooldown(userId, exchange);
        break; // 거래소당 1회 스왑 후 다음 사이클
      }
    } catch (err: any) {
      if (err.message?.includes('credential not found')) return; // 해당 거래소 미사용 유저
      console.error(`[RebalancerAgent] userId=${userId} ${exchange} 오류:`, err.message);
    }
  }

  private findBestBuyCoin(
    sellCoin: string,
    balances: Record<string, number>,
    exchange: string,
    minSpreadBps: number,
  ): { buyCoin: string; sellBid: number; buyAsk: number; spreadBps: number } | null {
    const sellBook = this.getBook(exchange, sellCoin);
    if (!sellBook) return null;
    const { bid: sellBid } = sellBook;

    let best: { buyCoin: string; sellBid: number; buyAsk: number; spreadBps: number } | null = null;

    for (const buyCoin of STABLECOINS) {
      if ((buyCoin as string) === sellCoin) continue;

      const buyBook = this.getBook(exchange, buyCoin);
      if (!buyBook || buyBook.ask <= 0) continue;

      const buyAsk = buyBook.ask;
      const spreadBps = ((sellBid - buyAsk) / buyAsk) * 10_000;
      if (spreadBps < minSpreadBps) continue;

      const buyCoinBalance = balances[buyCoin] ?? 0;
      const bestBalance = best ? (balances[best.buyCoin] ?? 0) : Infinity;

      // 잔고 가장 적은 코인 우선, 동률이면 스프레드 높은 쪽 우선
      if (buyCoinBalance < bestBalance || (buyCoinBalance === bestBalance && spreadBps > (best?.spreadBps ?? 0))) {
        best = { buyCoin, sellBid, buyAsk, spreadBps };
      }
    }
    return best;
  }

  private getBook(exchange: string, coin: string): BookPrice | null {
    if (exchange === 'upbit') {
      const book = getUpbitOrderbookForTrading(`KRW-${coin}`);
      if (!book) return null;
      return { bid: book.bid.price, ask: book.ask.price };
    }
    if (exchange === 'bithumb') {
      const book = getBithumbOrderbookForTrading(coin);
      if (!book) return null;
      return { bid: book.bid, ask: book.ask };
    }
    if (exchange === 'coinone') {
      const book = getCoinoneOrderbookForTrading(coin);
      if (!book) return null;
      return { bid: book.bid, ask: book.ask };
    }
    return null;
  }

  private async executeSwap(
    userId: number,
    exchange: string,
    sellCoin: string,
    buyCoin: string,
    excessQty: number,
    sellBid: number,
    buyAsk: number,
  ): Promise<void> {
    const leg = await this.getLeg(userId, exchange);
    if (!leg) return;

    // Leg-1: 초과 코인 시장가 매도
    const sellResult = await leg.sellIoc(sellCoin, excessQty, sellBid);
    if (!sellResult || sellResult.filledQty === 0) {
      console.log(`[RebalancerAgent] userId=${userId} ${exchange} ${sellCoin} 매도 미체결 — 스킵`);
      return;
    }

    const netKrw = sellResult.grossKrw - sellResult.feeKrw;
    console.log(
      `[RebalancerAgent] userId=${userId} ${exchange} ${sellCoin} 매도 ${sellResult.filledQty.toFixed(4)}개 → ${netKrw.toFixed(0)} KRW`,
    );

    // Leg-2: 대상 코인 매수 (매도 순수익 한도 내)
    const buyResult = await leg.buyIoc(buyCoin, sellResult.filledQty, buyAsk, netKrw);
    if (!buyResult || buyResult.filledQty === 0) {
      console.log(`[RebalancerAgent] userId=${userId} ${exchange} ${buyCoin} 매수 미체결 — KRW 잔여`);
      return;
    }

    const pnl = netKrw - buyResult.grossKrw - buyResult.feeKrw;
    console.log(
      `[RebalancerAgent] 완료 userId=${userId} ${exchange} ${sellCoin}→${buyCoin} ` +
        `${buyResult.filledQty.toFixed(4)}개 | P&L=${pnl.toFixed(0)} KRW`,
    );
  }

  private async getLeg(
    userId: number,
    exchange: string,
  ): Promise<UpbitLeg | BithumbLeg | CoinoneLeg | null> {
    if (exchange === 'upbit') {
      const { upbit } = await this.getUpbitClientFor(userId);
      return new UpbitLeg(upbit);
    }
    if (exchange === 'bithumb') {
      return new BithumbLeg(await this.getBithumbClientFor(userId));
    }
    if (exchange === 'coinone') {
      return new CoinoneLeg(await this.getCoinoneClientFor(userId));
    }
    return null;
  }

  private async getBalances(userId: number, exchange: string): Promise<Record<string, number> | null> {
    if (exchange === 'upbit') {
      const { cache } = await this.getUpbitClientFor(userId);
      return await cache.get();
    }
    if (exchange === 'bithumb') {
      const client = await this.getBithumbClientFor(userId);
      return await this.getBithumbAvailableBalances(userId, client);
    }
    if (exchange === 'coinone') {
      const client = await this.getCoinoneClientFor(userId);
      return await this.getCoinoneAvailableBalances(userId, client);
    }
    return null;
  }

  // ── 클라이언트 팩토리 ─────────────────────────────────────────────────────

  private async getUpbitClientFor(userId: number): Promise<{ upbit: UpbitService; cache: BalanceCache }> {
    const existing = this.upbitClients.get(userId);
    if (existing) return existing;

    const credential = await mainPrisma.credential.findFirst({ where: { userId, exchange: 'upbit' } });
    if (!credential) throw new Error(`Upbit credential not found for userId=${userId}`);

    const upbit = new UpbitService({
      accessKey: decrypt(credential.apiKey),
      secretKey: decrypt(credential.secretKey),
    });
    const cache = new BalanceCache({ ttlMs: 5_000, fetcher: () => upbit.getAccounts() });
    const client = { upbit, cache };
    this.upbitClients.set(userId, client);
    return client;
  }

  private async getBithumbClientFor(userId: number): Promise<BithumbClient> {
    const existing = this.bithumbClients.get(userId);
    if (existing) return existing;

    const credential = await mainPrisma.credential.findFirst({ where: { userId, exchange: 'bithumb' } });
    if (!credential) throw new Error(`Bithumb credential not found for userId=${userId}`);

    const client = new BithumbClient({
      accessKey: decrypt(credential.apiKey),
      secretKey: decrypt(credential.secretKey),
    });
    this.bithumbClients.set(userId, client);
    return client;
  }

  private async getBithumbAvailableBalances(
    userId: number,
    client: BithumbClient,
  ): Promise<Record<string, number>> {
    const TTL_MS = 10_000;
    const cached = this.bithumbBalanceCaches.get(userId);
    if (cached && Date.now() - cached.at < TTL_MS) return cached.data;

    const full = await client.getBalances();
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(full)) out[k] = (v as any).available;
    this.bithumbBalanceCaches.set(userId, { data: out, at: Date.now() });
    return out;
  }

  private async getCoinoneClientFor(userId: number): Promise<CoinoneClient> {
    const existing = this.coinoneClients.get(userId);
    if (existing) return existing;

    const credential = await mainPrisma.credential.findFirst({
      where: { userId, exchange: 'coinone' as any },
    });
    if (!credential) throw new Error(`Coinone credential not found for userId=${userId}`);

    const client = new CoinoneClient({
      accessKey: decrypt(credential.apiKey),
      secretKey: decrypt(credential.secretKey),
    });
    this.coinoneClients.set(userId, client);
    return client;
  }

  private async getCoinoneAvailableBalances(
    userId: number,
    client: CoinoneClient,
  ): Promise<Record<string, number>> {
    const TTL_MS = 10_000;
    const cached = this.coinoneBalanceCaches.get(userId);
    if (cached && Date.now() - cached.at < TTL_MS) return cached.data;

    const full = await client.getBalances();
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(full)) out[k] = (v as any).available;
    this.coinoneBalanceCaches.set(userId, { data: out, at: Date.now() });
    return out;
  }
}
