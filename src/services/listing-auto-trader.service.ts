// 신규상장 자동매수 서비스 (Binance + Bithumb)
// 업비트 신규 상장 공지 감지 즉시 시장가 매수

import axios from 'axios';
import crypto from 'crypto';
import prisma from '../config/database';
import { decrypt } from '../utils/encryption';
import { BithumbClient } from './exchange/bithumb-client';

const ADMIN_USER_ID = 2; // Binance/Bithumb 인증정보 소유 유저

interface AutoTradeConfig {
  enabled: boolean;
  amountKrw: number;
  useBinance: boolean;
  useBithumb: boolean;
}

interface OrderResult {
  exchange: string;
  status: 'filled' | 'pending' | 'failed' | 'skipped';
  orderId?: string;
  amountKrw: number;
  amountUsdt?: number;
  errorMsg?: string;
}

// ── Binance HMAC-SHA256 서명 ──────────────────────────────────────────────────

function binanceSign(secretKey: string, params: Record<string, string>): string {
  const qs = new URLSearchParams(params).toString();
  return crypto.createHmac('sha256', secretKey).update(qs).digest('hex');
}

async function binanceSignedGet(apiKey: string, secretKey: string, endpoint: string, params: Record<string, string> = {}) {
  const timestamp = Date.now().toString();
  const allParams = { ...params, timestamp };
  const signature = binanceSign(secretKey, allParams);
  const qs = new URLSearchParams({ ...allParams, signature }).toString();
  const res = await axios.get(`https://api.binance.com${endpoint}?${qs}`, {
    headers: { 'X-MBX-APIKEY': apiKey },
    timeout: 10000,
  });
  return res.data;
}

async function binanceSignedPost(apiKey: string, secretKey: string, endpoint: string, params: Record<string, string>) {
  const timestamp = Date.now().toString();
  const allParams = { ...params, timestamp };
  const signature = binanceSign(secretKey, allParams);
  const body = new URLSearchParams({ ...allParams, signature });
  const res = await axios.post(`https://api.binance.com${endpoint}`, body.toString(), {
    headers: {
      'X-MBX-APIKEY': apiKey,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    timeout: 10000,
  });
  return res.data;
}

// ── 설정 관리 ──────────────────────────────────────────────────────────────────

class ListingAutoTraderService {
  async getConfig(): Promise<AutoTradeConfig> {
    const row = await (prisma as any).listingAutoTradeConfig.findUnique({ where: { id: 1 } });
    if (!row) {
      return { enabled: false, amountKrw: 100000, useBinance: true, useBithumb: true };
    }
    return {
      enabled: row.enabled,
      amountKrw: row.amountKrw,
      useBinance: row.useBinance,
      useBithumb: row.useBithumb,
    };
  }

  async updateConfig(data: Partial<AutoTradeConfig>): Promise<AutoTradeConfig> {
    const row = await (prisma as any).listingAutoTradeConfig.upsert({
      where: { id: 1 },
      create: {
        enabled: data.enabled ?? false,
        amountKrw: data.amountKrw ?? 100000,
        useBinance: data.useBinance ?? true,
        useBithumb: data.useBithumb ?? true,
      },
      update: data,
    });
    return {
      enabled: row.enabled,
      amountKrw: row.amountKrw,
      useBinance: row.useBinance,
      useBithumb: row.useBithumb,
    };
  }

  // ── Binance 권한 확인 ──────────────────────────────────────────────────────

  async checkBinancePermissions(): Promise<{ hasKey: boolean; permissions: string[]; canSpot: boolean; error?: string }> {
    const cred = await this.getBinanceCreds();
    if (!cred) return { hasKey: false, permissions: [], canSpot: false, error: 'Binance 인증정보 없음 (userId=2)' };

    try {
      const data = await binanceSignedGet(cred.apiKey, cred.secretKey, '/api/v3/account');
      const permissions: string[] = data.permissions ?? [];
      return {
        hasKey: true,
        permissions,
        canSpot: permissions.includes('SPOT'),
      };
    } catch (err: any) {
      const msg = err?.response?.data?.msg ?? err.message;
      return { hasKey: true, permissions: [], canSpot: false, error: msg };
    }
  }

  // ── 자동매수 실행 ─────────────────────────────────────────────────────────

  async executeBuy(announcementId: number, ticker: string): Promise<OrderResult[]> {
    const config = await this.getConfig();
    if (!config.enabled) return [];

    const results = await Promise.allSettled([
      config.useBinance ? this.buyOnBinance(announcementId, ticker, config.amountKrw) : null,
      config.useBithumb ? this.buyOnBithumb(announcementId, ticker, config.amountKrw) : null,
    ]);

    const orders: OrderResult[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value !== null) orders.push(r.value);
    }
    return orders;
  }

  // ── 최근 주문 조회 ────────────────────────────────────────────────────────

  async listRecentOrders(limit = 50): Promise<any[]> {
    const rows = await (prisma as any).listingAutoOrder.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        announcement: { select: { id: true, title: true, ticker: true, announcedAt: true } },
      },
    });
    return rows;
  }

  // ── Private: Binance 시장가 매수 ──────────────────────────────────────────

  private async buyOnBinance(announcementId: number, ticker: string, amountKrw: number): Promise<OrderResult> {
    const exchange = 'binance';
    const existing = await (prisma as any).listingAutoOrder.findUnique({
      where: { announcementId_exchange: { announcementId, exchange } },
    });
    if (existing) return { exchange, status: 'skipped', amountKrw, orderId: existing.orderId };

    const dbRow = await (prisma as any).listingAutoOrder.create({
      data: { announcementId, exchange, ticker, amountKrw, status: 'pending' },
    });

    const cred = await this.getBinanceCreds();
    if (!cred) {
      await this.updateOrderFailed(dbRow.id, 'Binance 인증정보 없음');
      return { exchange, status: 'failed', amountKrw, errorMsg: 'Binance 인증정보 없음' };
    }

    try {
      const krwPerUsdt = await this.fetchKrwPerUsdt();
      const usdtAmount = Math.floor((amountKrw / krwPerUsdt) * 100) / 100; // 소수점 2자리

      const data = await binanceSignedPost(cred.apiKey, cred.secretKey, '/api/v3/order', {
        symbol: `${ticker}USDT`,
        side: 'BUY',
        type: 'MARKET',
        quoteOrderQty: usdtAmount.toFixed(2),
      });

      const orderId = String(data.orderId ?? '');
      const filledQty = parseFloat(data.executedQty ?? '0');
      const filledPrice = filledQty > 0 ? usdtAmount / filledQty : 0;

      await (prisma as any).listingAutoOrder.update({
        where: { id: dbRow.id },
        data: { orderId, amountUsdt: usdtAmount, status: 'filled', filledQty, filledPrice },
      });
      return { exchange, status: 'filled', orderId, amountKrw, amountUsdt: usdtAmount };
    } catch (err: any) {
      const msg = err?.response?.data?.msg ?? err.message;
      await this.updateOrderFailed(dbRow.id, msg);
      return { exchange, status: 'failed', amountKrw, errorMsg: msg };
    }
  }

  // ── Private: Bithumb 시장가 매수 ─────────────────────────────────────────

  private async buyOnBithumb(announcementId: number, ticker: string, amountKrw: number): Promise<OrderResult> {
    const exchange = 'bithumb';
    const existing = await (prisma as any).listingAutoOrder.findUnique({
      where: { announcementId_exchange: { announcementId, exchange } },
    });
    if (existing) return { exchange, status: 'skipped', amountKrw, orderId: existing.orderId };

    const dbRow = await (prisma as any).listingAutoOrder.create({
      data: { announcementId, exchange, ticker, amountKrw, status: 'pending' },
    });

    const cred = await this.getBithumbCreds();
    if (!cred) {
      await this.updateOrderFailed(dbRow.id, 'Bithumb 인증정보 없음');
      return { exchange, status: 'failed', amountKrw, errorMsg: 'Bithumb 인증정보 없음' };
    }

    try {
      const client = new BithumbClient({ accessKey: cred.apiKey, secretKey: cred.secretKey });
      // ord_type:'price' 방식 — body.price = amountKrw
      // placeMarketOrder(side, symbol, qty, krwPerUnit) → price = qty * krwPerUnit * 1.02
      // qty=1, krwPerUnit=amountKrw/1.02 → price = amountKrw
      const placed = await client.placeMarketOrder('buy', ticker, 1, amountKrw / 1.02);

      await (prisma as any).listingAutoOrder.update({
        where: { id: dbRow.id },
        data: { orderId: placed.orderId, status: 'filled' },
      });
      return { exchange, status: 'filled', orderId: placed.orderId, amountKrw };
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      await this.updateOrderFailed(dbRow.id, msg);
      return { exchange, status: 'failed', amountKrw, errorMsg: msg };
    }
  }

  // ── Private: 헬퍼 ────────────────────────────────────────────────────────

  private async getBinanceCreds(): Promise<{ apiKey: string; secretKey: string } | null> {
    const row = await prisma.credential.findFirst({
      where: { userId: ADMIN_USER_ID, exchange: 'binance' },
      select: { apiKey: true, secretKey: true },
    });
    if (!row) return null;
    return { apiKey: decrypt(row.apiKey), secretKey: decrypt(row.secretKey) };
  }

  private async getBithumbCreds(): Promise<{ apiKey: string; secretKey: string } | null> {
    const row = await prisma.credential.findFirst({
      where: { userId: ADMIN_USER_ID, exchange: 'bithumb' },
      select: { apiKey: true, secretKey: true },
    });
    if (!row) return null;
    return { apiKey: decrypt(row.apiKey), secretKey: decrypt(row.secretKey) };
  }

  private async fetchKrwPerUsdt(): Promise<number> {
    try {
      const res = await axios.get('https://api.upbit.com/v1/ticker?markets=KRW-USDT', { timeout: 5000 });
      const price = res.data?.[0]?.trade_price;
      if (price && price > 0) return price;
    } catch {}
    return 1360; // fallback: 대략적인 KRW/USDT 환율
  }

  private async updateOrderFailed(id: number, errorMsg: string): Promise<void> {
    await (prisma as any).listingAutoOrder.update({
      where: { id },
      data: { status: 'failed', errorMsg },
    });
  }
}

export const listingAutoTraderService = new ListingAutoTraderService();
