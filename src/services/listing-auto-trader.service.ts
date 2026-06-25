// 신규상장 자동매수 서비스 (Binance + Bithumb + MEXC)
// 업비트 신규 상장 공지 감지 즉시 시장가 매수

import axios from 'axios';
import crypto from 'crypto';
import https from 'https';
import { ListingSource } from '@prisma/client';
import prisma from '../config/database';
import { decrypt } from '../utils/encryption';
import { BithumbClient } from './exchange/bithumb-client';
import { kakaoNotifyService } from './kakao-notify.service';

const ADMIN_USER_ID = 2; // Binance/Bithumb 인증정보 소유 유저

// source 파라미터 타입 — Prisma generated enum 그대로 사용
export type ListingSourceType = ListingSource; // 'UPBIT' | 'BITHUMB'

interface AutoTradeConfig {
  source: ListingSourceType;
  enabled: boolean;
  killSwitch: boolean;
  amountKrw: number;
  useBinance: boolean;
  useBithumb: boolean;
  useMexc: boolean;
  useGateio: boolean;
  autoSellEnabled: boolean;
  takeProfitPct: number;
  stopLossPct: number;
  maxHoldMinutes: number;
  useTrailingStop: boolean;
  trailingStopPct: number;
  minTakerBalance: number | null;
}

// source별 default config (DB에 row 없을 때 / upsert create 분기)
// UPBIT: 기존 운영 default 유지 (amountKrw=100k, useBinance/Bithumb)
// BITHUMB: 빗썸은 빗썸 자체 매수가 빠지고 Binance/MEXC/Gate.io 위주로 더 보수적인 값
function defaultsFor(source: ListingSourceType): Omit<AutoTradeConfig, 'source'> {
  if (source === 'BITHUMB') {
    return {
      enabled: false,
      killSwitch: false,
      amountKrw: 10000,
      useBinance: true,
      useBithumb: false,
      useMexc: true,
      useGateio: true,
      autoSellEnabled: true,
      takeProfitPct: 10,
      stopLossPct: 5,
      maxHoldMinutes: 15,
      useTrailingStop: true,
      trailingStopPct: 10,
      minTakerBalance: null,
    };
  }
  // UPBIT default — 기존 값 유지
  return {
    enabled: false,
    killSwitch: false,
    amountKrw: 100000,
    useBinance: true,
    useBithumb: true,
    useMexc: false,
    useGateio: false,
    autoSellEnabled: true,
    takeProfitPct: 20,
    stopLossPct: 10,
    maxHoldMinutes: 30,
    useTrailingStop: false,
    trailingStopPct: 20,
    minTakerBalance: null,
  };
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
  // source별 자동매수 설정 조회 (DB에 row 없으면 source별 default 반환)
  async getConfig(source: ListingSourceType = 'UPBIT'): Promise<AutoTradeConfig> {
    const row = await prisma.listingAutoTradeConfig.findUnique({ where: { source } });
    if (!row) {
      // DB에 설정이 없으면 source별 기본값 반환
      return { source, ...defaultsFor(source) };
    }
    return {
      source: row.source,
      enabled: row.enabled,
      killSwitch: row.killSwitch,
      amountKrw: row.amountKrw,
      useBinance: row.useBinance,
      useBithumb: row.useBithumb,
      useMexc: row.useMexc,
      useGateio: row.useGateio,
      autoSellEnabled: row.autoSellEnabled,
      takeProfitPct: row.takeProfitPct,
      stopLossPct: row.stopLossPct,
      maxHoldMinutes: row.maxHoldMinutes,
      useTrailingStop: row.useTrailingStop,
      trailingStopPct: row.trailingStopPct,
      minTakerBalance: row.minTakerBalance,
    };
  }

  // source별 자동매수 설정 upsert (DB row 없으면 source default + 전달된 patch로 생성)
  async updateConfig(
    source: ListingSourceType,
    data: Partial<Omit<AutoTradeConfig, 'source'>>,
  ): Promise<AutoTradeConfig> {
    const row = await prisma.listingAutoTradeConfig.upsert({
      where: { source },
      create: { source, ...defaultsFor(source), ...data },
      update: data,
    });
    return {
      source: row.source,
      enabled: row.enabled,
      killSwitch: row.killSwitch,
      amountKrw: row.amountKrw,
      useBinance: row.useBinance,
      useBithumb: row.useBithumb,
      useMexc: row.useMexc,
      useGateio: row.useGateio,
      autoSellEnabled: row.autoSellEnabled,
      takeProfitPct: row.takeProfitPct,
      stopLossPct: row.stopLossPct,
      maxHoldMinutes: row.maxHoldMinutes,
      useTrailingStop: row.useTrailingStop,
      trailingStopPct: row.trailingStopPct,
      minTakerBalance: row.minTakerBalance,
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

  // announcement.source 기반으로 source별 config 로드 + 매수.
  // source default 'UPBIT' — 기존 호출처 backward-compat.
  async executeBuy(
    announcementId: number,
    ticker: string,
    source: ListingSourceType = 'UPBIT',
  ): Promise<OrderResult[]> {
    const config = await this.getConfig(source);
    if (!config.enabled || config.killSwitch) return [];

    // 업비트 신규상장 false-positive 차단:
    // 이미 업비트 KRW 마켓에 등록된 코인은 신규상장이 아님 — 매수 skip.
    // 예: "인터넷컴퓨터(ICP) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)" — KRW-ICP가 이미 존재하면 BTC/USDT 마켓 추가 공지일 가능성.
    // 빗썸 source는 별도의 이중 채널(텔레그램 + 마켓 diff)에서 이미 중복 차단되므로 이 체크는 UPBIT에만 적용.
    if (source === 'UPBIT') {
      const existingKrwMarket = await prisma.upbitKnownMarket.findUnique({
        where: { market: `KRW-${ticker}` },
      });
      if (existingKrwMarket) {
        const msg = `[Listing Skip] ${ticker} 이미 업비트 KRW 마켓 존재 — 신규상장 아님으로 판단해 매수 차단`;
        console.log(`[AutoTrader] ${msg}`);
        kakaoNotifyService.sendToMe(msg).catch(() => {
          /* 알림 실패는 무시 */
        });
        return [];
      }
    }

    // 같은 source + ticker에 대해 다른 announcement에서 이미 주문이 진행됐으면 중복 매수 방지.
    // source 분리 후에도 두 source가 같은 ticker를 동시에 매수하지 않도록 source까지 좁힌다.
    const existingOrder = await prisma.listingAutoOrder.findFirst({
      where: {
        source,
        ticker,
        status: { in: ['pending', 'filled'] },
        announcementId: { not: announcementId },
      },
    });
    if (existingOrder) {
      console.log(
        `[AutoTrader] source=${source} ticker=${ticker} 중복 매수 skip (기존 announcementId=${existingOrder.announcementId})`,
      );
      return [];
    }

    const results = await Promise.allSettled([
      config.useBinance ? this.buyOnBinance(announcementId, ticker, config.amountKrw, source) : null,
      config.useBithumb ? this.buyOnBithumb(announcementId, ticker, config.amountKrw, source) : null,
      config.useMexc ? this.buyOnMexc(announcementId, ticker, config.amountKrw, source) : null,
      config.useGateio ? this.buyOnGateio(announcementId, ticker, config.amountKrw, source) : null,
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

  // 매수 체결 수량/평균가를 수동 보정 (거래소 API 필드 오해 등으로 잘못 기록된 주문 정정용)
  async correctOrderFill(
    id: number,
    data: { filledQty?: number; filledPrice?: number },
  ): Promise<any> {
    const patch: { filledQty?: number; filledPrice?: number } = {};
    if (data.filledQty !== undefined) patch.filledQty = data.filledQty;
    if (data.filledPrice !== undefined) patch.filledPrice = data.filledPrice;

    return (prisma as any).listingAutoOrder.update({
      where: { id },
      data: patch,
    });
  }

  // ── Private: Binance 시장가 매수 ──────────────────────────────────────────

  private async buyOnBinance(
    announcementId: number,
    ticker: string,
    amountKrw: number,
    source: ListingSourceType,
  ): Promise<OrderResult> {
    const exchange = 'binance';
    const existing = await prisma.listingAutoOrder.findUnique({
      where: { announcementId_exchange: { announcementId, exchange } },
    });
    if (existing) return { exchange, status: 'skipped', amountKrw, orderId: existing.orderId ?? undefined };

    const dbRow = await prisma.listingAutoOrder.create({
      data: { source, announcementId, exchange, ticker, amountKrw, status: 'pending' },
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

      // Binance MARKET 주문은 즉시 체결이 원칙. 미체결이면 거래 정지 또는 심볼 미존재 상태로 간주
      if (filledQty <= 0) {
        const errMsg = 'Binance 매수 미체결 (MARKET executedQty=0 — 신규상장 거래 미시작 또는 심볼 비활성 추정)';
        await (prisma as any).listingAutoOrder.update({
          where: { id: dbRow.id },
          data: { orderId, amountUsdt: usdtAmount, status: 'failed', errorMsg: errMsg },
        });
        return { exchange, status: 'failed', orderId, amountKrw, amountUsdt: usdtAmount, errorMsg: errMsg };
      }

      const filledPrice = usdtAmount / filledQty;
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

  private async buyOnBithumb(
    announcementId: number,
    ticker: string,
    amountKrw: number,
    source: ListingSourceType,
  ): Promise<OrderResult> {
    const exchange = 'bithumb';
    const existing = await prisma.listingAutoOrder.findUnique({
      where: { announcementId_exchange: { announcementId, exchange } },
    });
    if (existing) return { exchange, status: 'skipped', amountKrw, orderId: existing.orderId ?? undefined };

    const dbRow = await prisma.listingAutoOrder.create({
      data: { source, announcementId, exchange, ticker, amountKrw, status: 'pending' },
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

      // 폴링·현재가 폴백 모두 실패하면 failed 처리 (filledQty=null/0 으로 filled 마킹하지 않음)
      if (filledQty === null || filledQty <= 0) {
        const errMsg = 'Bithumb 매수 체결량 확인 실패 (폴링·현재가 폴백 모두 실패)';
        await (prisma as any).listingAutoOrder.update({
          where: { id: dbRow.id },
          data: { orderId: placed.orderId, status: 'failed', errorMsg: errMsg },
        });
        return { exchange, status: 'failed', orderId: placed.orderId, amountKrw, errorMsg: errMsg };
      }

      await (prisma as any).listingAutoOrder.update({
        where: { id: dbRow.id },
        data: {
          orderId: placed.orderId,
          status: 'filled',
          filledPrice: filledPrice ?? undefined,
          filledQty,
        },
      });
      return { exchange, status: 'filled', orderId: placed.orderId, amountKrw };
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      // 빗썸 신규 상장 시장가 제한 시간 — 업비트 선상장이므로 재시도 불필요
      if (msg.includes('invalid_market_order_time')) {
        await this.updateOrderSkipped(dbRow.id, '빗썸 시장가 주문 제한 시간 (업비트 선상장으로 재시도 불필요)');
        return { exchange, status: 'skipped', amountKrw };
      }
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

  private async buyOnMexc(
    announcementId: number,
    ticker: string,
    amountKrw: number,
    source: ListingSourceType,
  ): Promise<OrderResult> {
    const exchange = 'mexc';
    const existing = await prisma.listingAutoOrder.findUnique({
      where: { announcementId_exchange: { announcementId, exchange } },
    });
    if (existing) return { exchange, status: 'skipped', amountKrw, orderId: existing.orderId ?? undefined };

    const dbRow = await prisma.listingAutoOrder.create({
      data: { source, announcementId, exchange, ticker, amountKrw, status: 'pending' },
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

      // 폴링 후에도 미체결이면 failed 처리 (자동매도가 빈 포지션을 매도하려고 시도하는 것을 방지)
      if (filledQty <= 0) {
        if (orderId) {
          try {
            await this.cancelMexcOrder(cred.apiKey, cred.secretKey, `${ticker}USDT`, orderId);
          } catch { /* 이미 종료된 주문일 수 있음 — 무시 */ }
        }
        const errMsg = 'MEXC 매수 미체결 (폴링 후 executedQty=0, 신규상장 거래 미시작 또는 호가창 비어있음 추정)';
        await (prisma as any).listingAutoOrder.update({
          where: { id: dbRow.id },
          data: { orderId, amountUsdt: usdtAmount, status: 'failed', errorMsg: errMsg },
        });
        return { exchange, status: 'failed', orderId, amountKrw, amountUsdt: usdtAmount, errorMsg: errMsg };
      }

      const filledPrice = usdtAmount / filledQty;
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

  private async buyOnGateio(
    announcementId: number,
    ticker: string,
    amountKrw: number,
    source: ListingSourceType,
  ): Promise<OrderResult> {
    const exchange = 'gateio';
    const existing = await prisma.listingAutoOrder.findUnique({
      where: { announcementId_exchange: { announcementId, exchange } },
    });
    if (existing) return { exchange, status: 'skipped', amountKrw, orderId: existing.orderId ?? undefined };

    const dbRow = await prisma.listingAutoOrder.create({
      data: { source, announcementId, exchange, ticker, amountKrw, status: 'pending' },
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
      // Gate.io 주의: fill_price = 체결된 quote(USDT) 총액(= filled_total)이며 코인당 가격이 아님.
      // 실제 체결 수량은 filled_amount(base), 코인당 평균가는 avg_deal_price.
      const avgDealPrice = parseFloat(data.avg_deal_price ?? '0');
      let filledQty = parseFloat(data.filled_amount ?? '0');
      if (filledQty <= 0 && orderId) {
        filledQty = await this.pollGateioFilledQty(cred.apiKey, cred.secretKey, orderId, ticker);
      }

      // 폴링 후에도 미체결이면 failed 처리 (Gate.io IOC는 매칭 실패 시 자동 취소되므로 별도 cancel 불필요)
      if (filledQty <= 0) {
        const errMsg = 'Gate.io 매수 미체결 (IOC 매칭 실패 — 호가창 비어있거나 거래 미시작 추정)';
        await (prisma as any).listingAutoOrder.update({
          where: { id: dbRow.id },
          data: { orderId, amountUsdt: usdtAmount, status: 'failed', errorMsg: errMsg },
        });
        return { exchange, status: 'failed', orderId, amountKrw, amountUsdt: usdtAmount, errorMsg: errMsg };
      }

      const filledPrice = avgDealPrice > 0 ? avgDealPrice : usdtAmount / filledQty;
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
        const filledAmount = parseFloat(data.filled_amount ?? '0');
        if (filledAmount > 0) return filledAmount;
        // 폴백: filled_total(quote) / avg_deal_price(per-unit)
        const avgDealPrice = parseFloat(data.avg_deal_price ?? '0');
        const filledTotal = parseFloat(data.filled_total ?? '0');
        if (avgDealPrice > 0 && filledTotal > 0) return filledTotal / avgDealPrice;
      } catch {}
    }
    return 0;
  }

  // MEXC 주문 체결량 폴링 (quoteOrderQty 매수 후 executedQty=0 대응)
  // 주문 상태(NEW/FILLED/CANCELED/REJECTED/EXPIRED)가 종료 상태면 더 폴링하지 않고 즉시 반환
  private async pollMexcFilledQty(apiKey: string, secretKey: string, symbol: string, orderId: string, maxRetries = 4): Promise<number> {
    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) await new Promise<void>(r => setTimeout(r, 1500));
      try {
        const data = await signedGet(MEXC.baseUrl, MEXC.apiKeyHeader, apiKey, secretKey, '/api/v3/order', { symbol, orderId });
        const qty = parseFloat(data.executedQty ?? '0');
        if (qty > 0) return qty;
        // 종료 상태면 더 기다려도 의미 없음
        const status = String(data.status ?? '');
        if (['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED', 'PARTIALLY_CANCELED'].includes(status)) return qty;
      } catch {}
    }
    return 0;
  }

  // MEXC 미체결 주문 취소 (filledQty=0 으로 failed 처리하기 직전에 호출)
  // 이미 만료/취소된 경우 예외가 발생할 수 있으므로 호출 측에서 무시
  private async cancelMexcOrder(apiKey: string, secretKey: string, symbol: string, orderId: string): Promise<void> {
    const timestamp = Date.now().toString();
    const allParams = { symbol, orderId, timestamp };
    const signature = hmacSign(secretKey, allParams);
    const qs = new URLSearchParams({ ...allParams, signature }).toString();
    await new Promise<void>((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'api.mexc.com',
          path: `/api/v3/order?${qs}`,
          method: 'DELETE',
          headers: { 'X-MEXC-APIKEY': apiKey },
          timeout: 8000,
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve());
        },
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('MEXC cancel timeout')); });
      req.end();
    });
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

  private async updateOrderSkipped(id: number, errorMsg: string): Promise<void> {
    await (prisma as any).listingAutoOrder.update({
      where: { id },
      data: { status: 'skipped', errorMsg },
    });
  }
}

export const listingAutoTraderService = new ListingAutoTraderService();
