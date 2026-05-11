// 신규상장 자동매수 서비스 (Binance + Bithumb + MEXC)
// 업비트 신규 상장 공지 감지 즉시 시장가 매수

import axios from 'axios';
import crypto from 'crypto';
import https from 'https';
import prisma from '../config/database';
import { decrypt } from '../utils/encryption';
import { BithumbClient } from './exchange/bithumb-client';

const ADMIN_USER_ID = 2; // Binance/Bithumb 인증정보 소유 유저

interface AutoTradeConfig {
  enabled: boolean;
  amountKrw: number;
  useBinance: boolean;
  useBithumb: boolean;
  useMexc: boolean;
  useGateio: boolean;
  autoSellEnabled: boolean;
  takeProfitPct: number;
  stopLossPct: number;
  maxHoldMinutes: number;
}

interface OrderResult {
  exchange: string;
  status: 'filled' | 'pending' | 'failed' | 'skipped';
  orderId?: string;
  amountKrw: number;
  amountUsdt?: number;
  errorMsg?: string;
}

// ── 공통 HMAC-SHA256 서명 (Binance / MEXC 동일 방식) ────────────────────────

function hmacSign(secretKey: string, params: Record<string, string>): string {
  return crypto.createHmac('sha256', secretKey).update(new URLSearchParams(params).toString()).digest('hex');
}

async function signedGet(
  baseUrl: string,
  apiKeyHeader: string,
  apiKey: string,
  secretKey: string,
  endpoint: string,
  params: Record<string, string> = {},
) {
  const timestamp = Date.now().toString();
  const allParams = { ...params, timestamp };
  const signature = hmacSign(secretKey, allParams);
  const qs = new URLSearchParams({ ...allParams, signature }).toString();
  const res = await axios.get(`${baseUrl}${endpoint}?${qs}`, {
    headers: { [apiKeyHeader]: apiKey },
    timeout: 10000,
  });
  return res.data;
}

// paramsInBody: Binance = true (body), MEXC = false (querystring)
async function signedPost(
  baseUrl: string,
  apiKeyHeader: string,
  apiKey: string,
  secretKey: string,
  endpoint: string,
  params: Record<string, string>,
  paramsInBody = true,
) {
  const timestamp = Date.now().toString();
  const allParams = { ...params, timestamp };
  const signature = hmacSign(secretKey, allParams);
  const qs = new URLSearchParams({ ...allParams, signature }).toString();

  if (paramsInBody) {
    const res = await axios.post(`${baseUrl}${endpoint}`, qs, {
      headers: { [apiKeyHeader]: apiKey, 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });
    return res.data;
  } else {
    // MEXC: 파라미터를 querystring으로 전달, body 없음
    // axios가 body=null이어도 Content-Type을 자동 추가하므로 명시적으로 제거
    const res = await axios.post(`${baseUrl}${endpoint}?${qs}`, null, {
      headers: { [apiKeyHeader]: apiKey, 'Content-Type': undefined },
      timeout: 10000,
      transformRequest: [(data: any, headers: any) => {
        delete headers['Content-Type'];
        delete headers['content-type'];
        return data;
      }],
    });
    return res.data;
  }
}

const BINANCE = { baseUrl: 'https://api.binance.com', apiKeyHeader: 'X-MBX-APIKEY', paramsInBody: true };
const MEXC = { baseUrl: 'https://api.mexc.com', apiKeyHeader: 'X-MEXC-APIKEY', paramsInBody: false };
const GATEIO_BASE = 'https://api.gateio.ws';

// Gate.io HMAC-SHA512 서명 (method + path + querystring + body_hash + timestamp)
async function gateioRequest(apiKey: string, secretKey: string, method: string, path: string, queryString = '', body = ''): Promise<any> {
  const timestamp = Math.floor(Date.now() / 1000);
  const bodyHash = crypto.createHash('sha512').update(body).digest('hex');
  const message = `${method}\n${path}\n${queryString}\n${bodyHash}\n${timestamp}`;
  const sign = crypto.createHmac('sha512', secretKey).update(message).digest('hex');
  const url = `${GATEIO_BASE}${path}${queryString ? '?' + queryString : ''}`;
  const res = await axios({
    method: method.toLowerCase() as 'get' | 'post',
    url,
    data: body || undefined,
    headers: { 'KEY': apiKey, 'Timestamp': String(timestamp), 'SIGN': sign, 'Content-Type': 'application/json' },
    timeout: 10000,
  });
  return res.data;
}

// MEXC POST: axios가 Content-Type을 강제 추가하므로 Node.js https 모듈 직접 사용
function mexcPost(apiKey: string, secretKey: string, endpoint: string, params: Record<string, string>): Promise<any> {
  const timestamp = Date.now().toString();
  const allParams = { ...params, timestamp };
  const signature = hmacSign(secretKey, allParams);
  const qs = new URLSearchParams({ ...allParams, signature }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.mexc.com',
      path: `${endpoint}?${qs}`,
      method: 'POST',
      headers: { 'X-MEXC-APIKEY': apiKey },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', (c: string) => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // MEXC는 비즈니스 에러(잔고 부족 등)를 HTTP 200으로 반환하면서 body에 code 필드로 구분
          const isHttpError = res.statusCode && res.statusCode >= 400;
          const isBodyError = parsed.code && parsed.code !== 200 && !parsed.orderId;
          if (isHttpError || isBodyError) {
            const err: any = new Error(parsed.msg ?? `MEXC 오류 code=${parsed.code}`);
            err.response = { data: parsed };
            reject(err);
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`MEXC 파싱 실패: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('MEXC timeout')); });
    req.end();
  });
}

// ── 설정 관리 ──────────────────────────────────────────────────────────────────

class ListingAutoTraderService {
  async getConfig(): Promise<AutoTradeConfig> {
    const row = await (prisma as any).listingAutoTradeConfig.findUnique({ where: { id: 1 } });
    if (!row) {
      // DB에 설정이 없으면 기본값 반환
      return {
        enabled: false,
        amountKrw: 100000,
        useBinance: true,
        useBithumb: true,
        useMexc: false,
        useGateio: false,
        autoSellEnabled: true,
        takeProfitPct: 20,
        stopLossPct: 10,
        maxHoldMinutes: 30,
      };
    }
    return {
      enabled: row.enabled,
      amountKrw: row.amountKrw,
      useBinance: row.useBinance,
      useBithumb: row.useBithumb,
      useMexc: row.useMexc ?? false,
      useGateio: row.useGateio ?? false,
      autoSellEnabled: row.autoSellEnabled ?? true,
      takeProfitPct: row.takeProfitPct ?? 20,
      stopLossPct: row.stopLossPct ?? 10,
      maxHoldMinutes: row.maxHoldMinutes ?? 30,
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
        useMexc: data.useMexc ?? false,
        useGateio: data.useGateio ?? false,
        autoSellEnabled: data.autoSellEnabled ?? true,
        takeProfitPct: data.takeProfitPct ?? 20,
        stopLossPct: data.stopLossPct ?? 10,
        maxHoldMinutes: data.maxHoldMinutes ?? 30,
      },
      update: data,
    });
    return {
      enabled: row.enabled,
      amountKrw: row.amountKrw,
      useBinance: row.useBinance,
      useBithumb: row.useBithumb,
      useMexc: row.useMexc ?? false,
      useGateio: row.useGateio ?? false,
      autoSellEnabled: row.autoSellEnabled ?? true,
      takeProfitPct: row.takeProfitPct ?? 20,
      stopLossPct: row.stopLossPct ?? 10,
      maxHoldMinutes: row.maxHoldMinutes ?? 30,
    };
  }

  // ── Binance 권한 확인 ──────────────────────────────────────────────────────

  async checkBinancePermissions(): Promise<{ hasKey: boolean; permissions: string[]; canSpot: boolean; error?: string }> {
    const cred = await this.getBinanceCreds();
    if (!cred) return { hasKey: false, permissions: [], canSpot: false, error: 'Binance 인증정보 없음 (userId=2)' };

    try {
      const data = await signedGet(BINANCE.baseUrl, BINANCE.apiKeyHeader, cred.apiKey, cred.secretKey, '/api/v3/account');
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
      config.useMexc ? this.buyOnMexc(announcementId, ticker, config.amountKrw) : null,
      config.useGateio ? this.buyOnGateio(announcementId, ticker, config.amountKrw) : null,
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

      const data = await signedPost(BINANCE.baseUrl, BINANCE.apiKeyHeader, cred.apiKey, cred.secretKey, '/api/v3/order', {
        symbol: `${ticker}USDT`,
        side: 'BUY',
        type: 'MARKET',
        quoteOrderQty: usdtAmount.toFixed(2),
      }, BINANCE.paramsInBody);

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

      // 빗썸 시장가 매수는 즉시 체결량을 반환하지 않으므로 getOrder()로 폴링
      let filledQty: number | null = null;
      let filledPrice: number | null = null;
      for (let i = 0; i < 4; i++) {
        if (i > 0) await new Promise<void>(r => setTimeout(r, 1500));
        try {
          const detail = await client.getOrder(placed.orderId);
          if (detail.filledQty > 0) {
            filledQty = detail.filledQty;
            filledPrice = detail.avgFillPrice > 0 ? detail.avgFillPrice : null;
            break;
          }
        } catch {}
      }
      // 폴링 실패 시 현재가로 수량 추정 (폴백)
      if (filledQty === null) {
        const currentKrwPrice = await this.fetchBithumbCurrentPrice(ticker);
        filledQty = currentKrwPrice && currentKrwPrice > 0 ? (amountKrw / 1.02) / currentKrwPrice : null;
        filledPrice = currentKrwPrice ?? null;
      }

      await (prisma as any).listingAutoOrder.update({
        where: { id: dbRow.id },
        data: {
          orderId: placed.orderId,
          status: 'filled',
          filledPrice: filledPrice ?? undefined,
          filledQty: filledQty ?? undefined,
        },
      });
      return { exchange, status: 'filled', orderId: placed.orderId, amountKrw };
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      await this.updateOrderFailed(dbRow.id, msg);
      return { exchange, status: 'failed', amountKrw, errorMsg: msg };
    }
  }

  // 빗썸 현재가 조회 (Public API)
  private async fetchBithumbCurrentPrice(ticker: string): Promise<number | null> {
    try {
      const res = await axios.get(
        `https://api.bithumb.com/public/ticker/${ticker.toUpperCase()}_KRW`,
        { timeout: 3000 },
      );
      if (res.data?.status !== '0000') return null;
      return parseFloat(res.data.data.closing_price);
    } catch {
      return null;
    }
  }

  // ── Private: MEXC 시장가 매수 ─────────────────────────────────────────────

  private async buyOnMexc(announcementId: number, ticker: string, amountKrw: number): Promise<OrderResult> {
    const exchange = 'mexc';
    const existing = await (prisma as any).listingAutoOrder.findUnique({
      where: { announcementId_exchange: { announcementId, exchange } },
    });
    if (existing) return { exchange, status: 'skipped', amountKrw, orderId: existing.orderId };

    const dbRow = await (prisma as any).listingAutoOrder.create({
      data: { announcementId, exchange, ticker, amountKrw, status: 'pending' },
    });

    const cred = await this.getMexcCreds();
    if (!cred) {
      await this.updateOrderFailed(dbRow.id, 'MEXC 인증정보 없음');
      return { exchange, status: 'failed', amountKrw, errorMsg: 'MEXC 인증정보 없음' };
    }

    try {
      const krwPerUsdt = await this.fetchKrwPerUsdt();
      const usdtAmount = Math.floor((amountKrw / krwPerUsdt) * 100) / 100;

      const data = await mexcPost(cred.apiKey, cred.secretKey, '/api/v3/order', {
        symbol: `${ticker}USDT`,
        side: 'BUY',
        type: 'MARKET',
        quoteOrderQty: usdtAmount.toFixed(2),
      });

      const orderId = String(data.orderId ?? '');

      // MEXC quoteOrderQty 매수는 즉시 응답에서 executedQty=0을 반환하므로 폴링으로 실제 체결량 확인
      let filledQty = parseFloat(data.executedQty ?? '0');
      if (filledQty <= 0 && orderId) {
        filledQty = await this.pollMexcFilledQty(cred.apiKey, cred.secretKey, `${ticker}USDT`, orderId);
      }
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

  // ── Private: Gate.io 시장가 매수 ──────────────────────────────────────────

  private async buyOnGateio(announcementId: number, ticker: string, amountKrw: number): Promise<OrderResult> {
    const exchange = 'gateio';
    const existing = await (prisma as any).listingAutoOrder.findUnique({
      where: { announcementId_exchange: { announcementId, exchange } },
    });
    if (existing) return { exchange, status: 'skipped', amountKrw, orderId: existing.orderId };

    const dbRow = await (prisma as any).listingAutoOrder.create({
      data: { announcementId, exchange, ticker, amountKrw, status: 'pending' },
    });

    const cred = await this.getGateioCreds();
    if (!cred) {
      await this.updateOrderFailed(dbRow.id, 'Gate.io 인증정보 없음');
      return { exchange, status: 'failed', amountKrw, errorMsg: 'Gate.io 인증정보 없음' };
    }

    try {
      const krwPerUsdt = await this.fetchKrwPerUsdt();
      const usdtAmount = Math.floor((amountKrw / krwPerUsdt) * 100) / 100;

      // Gate.io market buy: amount = quote currency (USDT)
      const body = JSON.stringify({
        currency_pair: `${ticker}_USDT`,
        type: 'market',
        side: 'buy',
        amount: usdtAmount.toFixed(2),
        time_in_force: 'ioc',
      });

      const data = await gateioRequest(cred.apiKey, cred.secretKey, 'POST', '/api/v4/spot/orders', '', body);
      const orderId = String(data.id ?? '');
      const fillPrice = parseFloat(data.fill_price ?? '0');
      const filledTotal = parseFloat(data.filled_total ?? '0');

      // fill_price = 코인당 USDT 가격, filledTotal = 실제 소비한 USDT
      let filledQty = fillPrice > 0 ? filledTotal / fillPrice : 0;
      if (filledQty <= 0 && orderId) {
        filledQty = await this.pollGateioFilledQty(cred.apiKey, cred.secretKey, orderId, ticker);
      }
      const filledPrice = filledQty > 0 ? usdtAmount / filledQty : 0;

      await (prisma as any).listingAutoOrder.update({
        where: { id: dbRow.id },
        data: { orderId, amountUsdt: usdtAmount, status: 'filled', filledQty, filledPrice },
      });
      return { exchange, status: 'filled', orderId, amountKrw, amountUsdt: usdtAmount };
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? err?.response?.data?.label ?? err.message;
      await this.updateOrderFailed(dbRow.id, msg);
      return { exchange, status: 'failed', amountKrw, errorMsg: msg };
    }
  }

  // Gate.io 체결량 폴링 (fill_price=0 대응)
  private async pollGateioFilledQty(apiKey: string, secretKey: string, orderId: string, ticker: string, maxRetries = 4): Promise<number> {
    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) await new Promise<void>(r => setTimeout(r, 1500));
      try {
        const data = await gateioRequest(apiKey, secretKey, 'GET', `/api/v4/spot/orders/${orderId}`, `currency_pair=${ticker}_USDT`);
        const fillPrice = parseFloat(data.fill_price ?? '0');
        const filledTotal = parseFloat(data.filled_total ?? '0');
        if (fillPrice > 0 && filledTotal > 0) return filledTotal / fillPrice;
      } catch {}
    }
    return 0;
  }

  // MEXC 주문 체결량 폴링 (quoteOrderQty 매수 후 executedQty=0 대응)
  private async pollMexcFilledQty(apiKey: string, secretKey: string, symbol: string, orderId: string, maxRetries = 4): Promise<number> {
    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) await new Promise<void>(r => setTimeout(r, 1500));
      try {
        const data = await signedGet(MEXC.baseUrl, MEXC.apiKeyHeader, apiKey, secretKey, '/api/v3/order', { symbol, orderId });
        const qty = parseFloat(data.executedQty ?? '0');
        if (qty > 0) return qty;
      } catch {}
    }
    return 0;
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

  private async getMexcCreds(): Promise<{ apiKey: string; secretKey: string } | null> {
    const row = await prisma.credential.findFirst({
      where: { userId: ADMIN_USER_ID, exchange: 'mexc' as any },
      select: { apiKey: true, secretKey: true },
    });
    if (!row) return null;
    return { apiKey: decrypt(row.apiKey), secretKey: decrypt(row.secretKey) };
  }

  private async getGateioCreds(): Promise<{ apiKey: string; secretKey: string } | null> {
    const row = await prisma.credential.findFirst({
      where: { userId: ADMIN_USER_ID, exchange: 'gateio' as any },
      select: { apiKey: true, secretKey: true },
    });
    if (row) return { apiKey: decrypt(row.apiKey), secretKey: decrypt(row.secretKey) };
    // DB에 없으면 환경변수 fallback (GATEWAY_API_KEY / GATEWAY_SECRET_KEY)
    const envKey = process.env.GATEWAY_API_KEY;
    const envSecret = process.env.GATEWAY_SECRET_KEY;
    if (envKey && envSecret) return { apiKey: envKey, secretKey: envSecret };
    return null;
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
