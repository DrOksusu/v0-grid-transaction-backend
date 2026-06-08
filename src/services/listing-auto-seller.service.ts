// 신규상장 자동매도 서비스 (Binance + Bithumb + MEXC)
// 매수 체결된 주문을 5초마다 점검하여 아래 조건 충족 시 시장가 매도:
//   - takeProfitPct: 목표 수익률 도달 (기본 +20%)
//   - stopLossPct:   손절 수익률 도달 (기본 -10%)
//   - maxHoldMinutes: 최대 보유 시간 초과 (기본 30분)

import axios from 'axios';
import https from 'https';
import crypto from 'crypto';
import prisma from '../config/database';
import { decrypt } from '../utils/encryption';
import { BithumbClient } from './exchange/bithumb-client';
import { listingAutoTraderService } from './listing-auto-trader.service';

const ADMIN_USER_ID = 2;

// HMAC-SHA256 서명 (Binance / MEXC 공통)
function hmacSign(secretKey: string, params: Record<string, string>): string {
  return crypto.createHmac('sha256', secretKey).update(new URLSearchParams(params).toString()).digest('hex');
}

// Gate.io HMAC-SHA512 서명
async function gateioRequest(apiKey: string, secretKey: string, method: string, path: string, queryString = '', body = ''): Promise<any> {
  const timestamp = Math.floor(Date.now() / 1000);
  const bodyHash = crypto.createHash('sha512').update(body).digest('hex');
  const message = `${method}\n${path}\n${queryString}\n${bodyHash}\n${timestamp}`;
  const sign = crypto.createHmac('sha512', secretKey).update(message).digest('hex');
  const url = `https://api.gateio.ws${path}${queryString ? '?' + queryString : ''}`;
  const res = await axios({
    method: method.toLowerCase() as 'get' | 'post',
    url,
    data: body || undefined,
    headers: { 'KEY': apiKey, 'Timestamp': String(timestamp), 'SIGN': sign, 'Content-Type': 'application/json' },
    timeout: 10000,
  });
  return res.data;
}

interface SellResult {
  orderId: string;
  filledQty: number;
  avgPrice: number | null;
}

class ListingAutoSellerService {
  private checking = false; // 중복 실행 방지
  private peakPrices: Map<number, number> = new Map(); // orderId → 최고가 (trailing stop용)

  /**
   * 매도 조건 점검 (5초마다 에이전트에서 호출)
   * 매수 체결(status=filled) 상태이고 매도 미완료(sellStatus=null)인 주문을 대상으로 함
   */
  async checkAndSell(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const config = await listingAutoTraderService.getConfig();
      if (!config.autoSellEnabled) return;

      // 매수 체결됐지만 매도 미시작인 주문 조회
      const openOrders = await (prisma as any).listingAutoOrder.findMany({
        where: { status: 'filled', sellStatus: null },
        include: { announcement: { select: { ticker: true } } },
      });

      // 순차 처리 (거래소 API rate limit 고려)
      for (const order of openOrders) {
        await this.evaluateOrder(order, config);
      }
    } finally {
      this.checking = false;
    }
  }

  /**
   * 개별 주문의 매도 조건 평가
   */
  private async evaluateOrder(order: any, config: any): Promise<void> {
    const ticker = order.announcement?.ticker;
    if (!ticker) return;

    // 매수 주문 생성 시점 기준 경과 시간 (분)
    const elapsedMinutes = (Date.now() - new Date(order.createdAt).getTime()) / 60000;
    const buyAvgPrice = order.filledPrice; // 매수 평균가 (Binance/MEXC: USDT, Bithumb: KRW)

    // 현재가 조회
    const currentPrice = await this.fetchCurrentPrice(order.exchange, ticker);

    let sellReason: string | null = null;

    if (elapsedMinutes >= config.maxHoldMinutes) {
      // 시간 컷: 최대 보유 시간 초과
      sellReason = 'time_cut';
    } else if (config.useTrailingStop) {
      // Trailing Stop 모드: 최고가 기준
      if (currentPrice !== null) {
        const prevPeak = this.peakPrices.get(order.id) ?? (buyAvgPrice ?? 0);
        const newPeak = Math.max(prevPeak, currentPrice);
        this.peakPrices.set(order.id, newPeak);

        if (newPeak > 0 && currentPrice <= newPeak * (1 - config.trailingStopPct / 100)) {
          sellReason = 'trailing_stop';
        }
      }
      // 바닥 보호: 매수가 대비 stopLossPct% 하락 시 손절
      if (!sellReason && currentPrice !== null && buyAvgPrice !== null && buyAvgPrice > 0) {
        const pctChange = ((currentPrice - buyAvgPrice) / buyAvgPrice) * 100;
        if (pctChange <= -config.stopLossPct) {
          sellReason = 'stop_loss';
        }
      }
    } else {
      // 고정 익절/손절 모드 (기존)
      if (currentPrice !== null && buyAvgPrice !== null && buyAvgPrice > 0) {
        const pctChange = ((currentPrice - buyAvgPrice) / buyAvgPrice) * 100;
        if (pctChange >= config.takeProfitPct) {
          // 익절: 목표 수익률 도달
          sellReason = 'take_profit';
        } else if (pctChange <= -config.stopLossPct) {
          // 손절: 손절 수익률 도달
          sellReason = 'stop_loss';
        }
      }
    }

    if (!sellReason) return;

    await this.executeSell(order, ticker, sellReason, currentPrice);
  }

  /**
   * 매도 주문 실행
   * sellStatus를 pending으로 먼저 마킹해서 중복 실행 방지
   */
  private async executeSell(
    order: any,
    ticker: string,
    reason: string,
    currentPrice: number | null,
  ): Promise<void> {
    // 중복 실행 방지: pending으로 먼저 마킹
    await (prisma as any).listingAutoOrder.update({
      where: { id: order.id },
      data: { sellStatus: 'pending', sellReason: reason },
    });

    try {
      let result: SellResult;

      if (order.exchange === 'binance') {
        result = await this.sellOnBinance(ticker, order.filledQty ?? 0);
      } else if (order.exchange === 'bithumb') {
        result = await this.sellOnBithumb(ticker, order.filledQty ?? 0);
      } else if (order.exchange === 'mexc') {
        result = await this.sellOnMexc(ticker, order.filledQty ?? 0);
      } else if (order.exchange === 'gateio') {
        result = await this.sellOnGateio(ticker, order.filledQty ?? 0);
      } else {
        throw new Error(`지원하지 않는 거래소: ${order.exchange}`);
      }

      // 실현 수익률 계산
      let profitPct: number | null = null;
      if (result.avgPrice !== null && order.filledPrice && order.filledPrice > 0) {
        profitPct = ((result.avgPrice - order.filledPrice) / order.filledPrice) * 100;
      }

      await (prisma as any).listingAutoOrder.update({
        where: { id: order.id },
        data: {
          sellStatus: 'filled',
          sellOrderId: result.orderId,
          sellFilledQty: result.filledQty,
          sellAvgPrice: result.avgPrice,
          profitPct,
          soldAt: new Date(),
        },
      });

      this.peakPrices.delete(order.id);
      console.log(
        `[AutoSeller] ${ticker} ${order.exchange} ${reason} 매도 완료 — 수익률 ${profitPct?.toFixed(2) ?? '?'}%`,
      );
    } catch (err: any) {
      const msg = err?.response?.data?.msg ?? err.message ?? String(err);
      console.error(`[AutoSeller] ${ticker} ${order.exchange} 매도 실패:`, msg);
      await (prisma as any).listingAutoOrder.update({
        where: { id: order.id },
        data: { sellStatus: 'failed', sellErrorMsg: msg },
      });
    }
  }

  // ── Binance 시장가 매도 ────────────────────────────────────────────────────

  private async sellOnBinance(ticker: string, qty: number): Promise<SellResult> {
    const cred = await this.getBinanceCreds();
    if (!cred) throw new Error('Binance 인증정보 없음');
    if (!qty || qty <= 0) throw new Error('매도 수량 없음');

    const timestamp = Date.now().toString();
    const params: Record<string, string> = {
      symbol: `${ticker}USDT`,
      side: 'SELL',
      type: 'MARKET',
      quantity: qty.toString(),
      timestamp,
    };
    const signature = hmacSign(cred.secretKey, params);
    const qs = new URLSearchParams({ ...params, signature }).toString();

    const res = await axios.post(
      'https://api.binance.com/api/v3/order',
      qs,
      {
        headers: {
          'X-MBX-APIKEY': cred.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 10000,
      },
    );
    const data = res.data;
    const filledQty = parseFloat(data.executedQty ?? '0');
    const filledUsdt = parseFloat(data.cummulativeQuoteQty ?? '0');
    const avgPrice = filledQty > 0 ? filledUsdt / filledQty : 0;
    return { orderId: String(data.orderId), filledQty, avgPrice };
  }

  // ── Bithumb 시장가 매도 ───────────────────────────────────────────────────

  private async sellOnBithumb(ticker: string, qty: number): Promise<SellResult> {
    const cred = await this.getBithumbCreds();
    if (!cred) throw new Error('Bithumb 인증정보 없음');
    if (!qty || qty <= 0) throw new Error('매도 수량 없음');

    const client = new BithumbClient({ accessKey: cred.apiKey, secretKey: cred.secretKey });
    // 빗썸 시장가 매도: ord_type=market, volume=qty
    const placed = await client.placeMarketOrder('sell', ticker, qty);

    // 빗썸은 매도 체결가를 즉시 반환하지 않으므로 현재가로 근사
    const currentKrwPrice = await this.fetchCurrentPrice('bithumb', ticker);
    return { orderId: placed.orderId, filledQty: qty, avgPrice: currentKrwPrice };
  }

  // ── MEXC 시장가 매도 ──────────────────────────────────────────────────────

  private async sellOnMexc(ticker: string, qty: number): Promise<SellResult> {
    const cred = await this.getMexcCreds();
    if (!cred) throw new Error('MEXC 인증정보 없음');
    if (!qty || qty <= 0) throw new Error('매도 수량 없음');

    // 실제 잔고 확인: Float 정밀도 손실 보정 + MEXC 수수료 base 차감 대응
    const actualBalance = await this.getMexcCoinBalance(cred.apiKey, cred.secretKey, ticker);
    let sellQty = qty;
    if (actualBalance !== null && actualBalance > 0) {
      sellQty = Math.min(qty, actualBalance);
    }
    // MEXC LOT_SIZE 필터 통과를 위해 8자리 반올림 (float→string 정밀도 오류 방지)
    const qtyStr = parseFloat(sellQty.toFixed(8)).toString();
    if (parseFloat(qtyStr) <= 0) throw new Error('매도 수량 없음 (실제 잔고 0)');

    const timestamp = Date.now().toString();
    const params: Record<string, string> = {
      symbol: `${ticker}USDT`,
      side: 'SELL',
      type: 'MARKET',
      quantity: qtyStr,
      timestamp,
    };
    const signature = hmacSign(cred.secretKey, params);
    const qs = new URLSearchParams({ ...params, signature }).toString();

    // MEXC는 Content-Type 없이 querystring으로 요청 (axios 사용 시 헤더가 자동 추가되어 오류 발생)
    const data = await new Promise<any>((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'api.mexc.com',
          path: `/api/v3/order?${qs}`,
          method: 'POST',
          headers: { 'X-MEXC-APIKEY': cred.apiKey },
          timeout: 10000,
        },
        (res) => {
          let body = '';
          res.on('data', (c: string) => (body += c));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(body);
              const isHttpError = res.statusCode && res.statusCode >= 400;
              const isBodyError = parsed.code && parsed.code !== 200 && !parsed.orderId;
              if (isHttpError || isBodyError) {
                const e: any = new Error(parsed.msg ?? `MEXC code=${parsed.code}`);
                e.response = { data: parsed };
                reject(e);
              } else {
                resolve(parsed);
              }
            } catch {
              reject(new Error(`MEXC 파싱 실패: ${body}`));
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('MEXC timeout'));
      });
      req.end();
    });

    const orderId = String(data.orderId);
    const filledQty = parseFloat(data.executedQty ?? qty.toString());

    // MEXC는 매도 즉시 응답에서 cummulativeQuoteQty=0을 반환하므로 폴링으로 실제 체결 금액 확인
    let filledUsdt = parseFloat(data.cummulativeQuoteQty ?? '0');
    if (filledUsdt <= 0 && orderId) {
      filledUsdt = await this.pollMexcFilledUsdt(cred.apiKey, cred.secretKey, `${ticker}USDT`, orderId);
    }

    // 폴링 후에도 0이면 현재가로 근사 (최후 fallback)
    let avgPrice: number | null = null;
    if (filledUsdt > 0 && filledQty > 0) {
      avgPrice = filledUsdt / filledQty;
    } else {
      avgPrice = await this.fetchCurrentPrice('mexc', ticker);
    }

    return { orderId, filledQty, avgPrice };
  }

  // ── Gate.io 시장가 매도 ──────────────────────────────────────────────────

  private async sellOnGateio(ticker: string, qty: number): Promise<SellResult> {
    const cred = await this.getGateioCreds();
    if (!cred) throw new Error('Gate.io 인증정보 없음');
    if (!qty || qty <= 0) throw new Error('매도 수량 없음');

    const qtyStr = parseFloat(qty.toFixed(8)).toString();

    // Gate.io market sell: amount = base currency (코인 수량)
    const body = JSON.stringify({
      currency_pair: `${ticker}_USDT`,
      type: 'market',
      side: 'sell',
      amount: qtyStr,
      time_in_force: 'ioc',
    });

    const data = await gateioRequest(cred.apiKey, cred.secretKey, 'POST', '/api/v4/spot/orders', '', body);
    const orderId = String(data.id ?? '');
    // Gate.io 주의: fill_price = 체결된 quote(USDT) 총액이며 코인당 가격이 아님. 평균가는 avg_deal_price.
    const avgDealPrice = parseFloat(data.avg_deal_price ?? '0');
    const filledTotal = parseFloat(data.filled_total ?? '0');

    // sell은 amount가 base 수량. filled_amount 우선, 없으면 전체 - 남은 수량
    const left = parseFloat(data.left ?? '0');
    const requestedQty = parseFloat(data.amount ?? qtyStr);
    const filledQty = parseFloat(data.filled_amount ?? '0') || (requestedQty - left) || qty;

    let avgPrice: number | null = null;
    if (avgDealPrice > 0) {
      avgPrice = avgDealPrice;
    } else if (filledQty > 0 && filledTotal > 0) {
      avgPrice = filledTotal / filledQty;
    }

    // 폴링으로 체결가 확인
    if (!avgPrice && orderId) {
      avgPrice = await this.pollGateioFillPrice(cred.apiKey, cred.secretKey, orderId, ticker);
    }
    if (!avgPrice) {
      avgPrice = await this.fetchCurrentPrice('gateio', ticker);
    }

    return { orderId, filledQty, avgPrice };
  }

  // Gate.io 매도 체결가 폴링
  private async pollGateioFillPrice(apiKey: string, secretKey: string, orderId: string, ticker: string, maxRetries = 4): Promise<number | null> {
    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) await new Promise<void>((r) => setTimeout(r, 1500));
      try {
        const data = await gateioRequest(apiKey, secretKey, 'GET', `/api/v4/spot/orders/${orderId}`, `currency_pair=${ticker}_USDT`);
        const avgDealPrice = parseFloat(data.avg_deal_price ?? '0');
        if (avgDealPrice > 0) return avgDealPrice;
      } catch {}
    }
    return null;
  }

  // MEXC 매도 체결 금액 폴링 (즉시 응답에서 cummulativeQuoteQty=0 대응)
  private async pollMexcFilledUsdt(
    apiKey: string,
    secretKey: string,
    symbol: string,
    orderId: string,
    maxRetries = 4,
  ): Promise<number> {
    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) await new Promise<void>((r) => setTimeout(r, 1500));
      try {
        const timestamp = Date.now().toString();
        const params = { symbol, orderId, timestamp };
        const signature = crypto.createHmac('sha256', secretKey)
          .update(new URLSearchParams(params).toString())
          .digest('hex');
        const qs = new URLSearchParams({ ...params, signature }).toString();

        const filled = await new Promise<number>((resolve, reject) => {
          const req = https.request(
            {
              hostname: 'api.mexc.com',
              path: `/api/v3/order?${qs}`,
              method: 'GET',
              headers: { 'X-MEXC-APIKEY': apiKey },
              timeout: 8000,
            },
            (res) => {
              let body = '';
              res.on('data', (c: string) => (body += c));
              res.on('end', () => {
                try {
                  const d = JSON.parse(body);
                  resolve(parseFloat(d.cummulativeQuoteQty ?? '0'));
                } catch {
                  reject(new Error('MEXC order 조회 파싱 실패'));
                }
              });
            },
          );
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('MEXC order 조회 timeout')); });
          req.end();
        });

        if (filled > 0) return filled;
      } catch {
        // 재시도
      }
    }
    return 0;
  }

  // ── 거래소별 현재가 조회 ───────────────────────────────────────────────────

  private async fetchCurrentPrice(exchange: string, ticker: string): Promise<number | null> {
    try {
      if (exchange === 'binance') {
        const res = await axios.get(
          `https://api.binance.com/api/v3/ticker/price?symbol=${ticker}USDT`,
          { timeout: 4000 },
        );
        return parseFloat(res.data.price);
      } else if (exchange === 'bithumb') {
        const res = await axios.get(
          `https://api.bithumb.com/public/ticker/${ticker.toUpperCase()}_KRW`,
          { timeout: 4000 },
        );
        if (res.data?.status !== '0000') return null;
        return parseFloat(res.data.data.closing_price);
      } else if (exchange === 'mexc') {
        const res = await axios.get(
          `https://api.mexc.com/api/v3/ticker/price?symbol=${ticker}USDT`,
          { timeout: 4000 },
        );
        return parseFloat(res.data.price);
      } else if (exchange === 'gateio') {
        const res = await axios.get(
          `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${ticker}_USDT`,
          { timeout: 4000 },
        );
        if (Array.isArray(res.data) && res.data.length > 0) {
          return parseFloat(res.data[0].last ?? '0');
        }
      }
    } catch {
      // 현재가 조회 실패는 무시하고 null 반환
    }
    return null;
  }

  // ── MEXC 코인 잔고 조회 ───────────────────────────────────────────────────

  private async getMexcCoinBalance(apiKey: string, secretKey: string, coin: string): Promise<number | null> {
    try {
      const timestamp = Date.now().toString();
      const params = { timestamp };
      const signature = crypto.createHmac('sha256', secretKey).update(new URLSearchParams(params).toString()).digest('hex');
      const qs = new URLSearchParams({ ...params, signature }).toString();

      const data = await new Promise<any>((resolve, reject) => {
        const req = https.request(
          {
            hostname: 'api.mexc.com',
            path: `/api/v3/account?${qs}`,
            method: 'GET',
            headers: { 'X-MEXC-APIKEY': apiKey },
            timeout: 8000,
          },
          (res) => {
            let body = '';
            res.on('data', (c: string) => (body += c));
            res.on('end', () => {
              try { resolve(JSON.parse(body)); } catch { reject(new Error('MEXC account 파싱 실패')); }
            });
          },
        );
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('MEXC account timeout')); });
        req.end();
      });

      const balances: Array<{ asset: string; free: string }> = data.balances ?? [];
      const found = balances.find((b) => b.asset.toUpperCase() === coin.toUpperCase());
      return found ? parseFloat(found.free) : 0;
    } catch {
      return null;
    }
  }

  // ── 인증정보 헬퍼 ─────────────────────────────────────────────────────────

  private async getBinanceCreds(): Promise<{ apiKey: string; secretKey: string } | null> {
    const row = await prisma.credential.findFirst({
      where: { userId: ADMIN_USER_ID, exchange: 'binance' },
      select: { apiKey: true, secretKey: true },
    });
    return row ? { apiKey: decrypt(row.apiKey), secretKey: decrypt(row.secretKey) } : null;
  }

  private async getBithumbCreds(): Promise<{ apiKey: string; secretKey: string } | null> {
    const row = await prisma.credential.findFirst({
      where: { userId: ADMIN_USER_ID, exchange: 'bithumb' },
      select: { apiKey: true, secretKey: true },
    });
    return row ? { apiKey: decrypt(row.apiKey), secretKey: decrypt(row.secretKey) } : null;
  }

  private async getMexcCreds(): Promise<{ apiKey: string; secretKey: string } | null> {
    const row = await prisma.credential.findFirst({
      where: { userId: ADMIN_USER_ID, exchange: 'mexc' as any },
      select: { apiKey: true, secretKey: true },
    });
    return row ? { apiKey: decrypt(row.apiKey), secretKey: decrypt(row.secretKey) } : null;
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
}

export const listingAutoSellerService = new ListingAutoSellerService();
