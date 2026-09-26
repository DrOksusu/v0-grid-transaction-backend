// Binance 거래소용 ExchangeLeg 구현 — 재고형 아비 실행 leg 어댑터
// 이식 원본: listing-auto-trader.service.ts buyOnBinance (시장가 매수, quoteOrderQty 방식)
//           listing-auto-seller.service.ts sellOnBinance (시장가 매도)
// MexcLeg와 동일 API 스타일(/api/v3)이나 차이점:
// - 주문은 signedPost(paramsInBody=true), MARKET 응답이 FULL(fills 포함)로 즉시 체결값 반환
// - 매도 수량은 LOT_SIZE stepSize 절사 필수 (필터 위반 시 주문 거부) — exchangeInfo 캐시
// - 수수료가 BNB로 차감될 수 있음(BNB 할인) — USDT 환산 불가 시 보수적으로 feeKrw=0
//
// 값 단위 주의: ExchangeLeg 인터페이스의 grossKrw/feeKrw 필드는 레거시 라벨이며,
// 이 구현체는 KRW가 아닌 USDT 값을 채운다 (재고형 아비는 USDT권 거래).
import axios from 'axios';
import { BINANCE, hmacSign, signedGet, signedPost } from './exchange-signer';
import type { ExchangeLeg } from '../exchange-leg';

type IocResult = { filledQty: number; grossKrw: number; feeKrw: number } | null;

/** Binance 주문 응답에서 fills[] 파싱 (commission 합계 + commissionAsset). 없으면 null. */
function parseFillsCommission(data: any): { total: number; asset: string } | null {
  const fills: Array<{ commission?: string; commissionAsset?: string }> = data?.fills ?? [];
  if (!Array.isArray(fills) || fills.length === 0) return null;
  const total = fills.reduce((s, f) => s + parseFloat(f.commission ?? '0'), 0);
  const asset = fills[0]?.commissionAsset ?? '';
  return { total, asset };
}

export class BinanceLeg implements ExchangeLeg {
  // LOT_SIZE stepSize 캐시 (프로세스 생명주기 동안 유효) — GateLeg amountPrecision 패턴
  private stepSizeCache: Map<string, number> = new Map();
  // PRICE_FILTER tickSize 캐시 — 지정가 IOC price 절사용 (미준수 가격은 주문 거부)
  private tickSizeCache: Map<string, number> = new Map();

  constructor(private readonly creds: { apiKey: string; secretKey: string }) {}

  /** Binance 코인 잔고 조회 (/api/v3/account free). */
  async getBalance(asset: string): Promise<number> {
    const data = await signedGet(
      BINANCE.baseUrl,
      BINANCE.apiKeyHeader,
      this.creds.apiKey,
      this.creds.secretKey,
      '/api/v3/account',
    );
    const balances: Array<{ asset: string; free: string }> = data.balances ?? [];
    const found = balances.find((b) => b.asset.toUpperCase() === asset.toUpperCase());
    return found ? parseFloat(found.free) : 0;
  }

  /** 전체 non-zero available 잔고 (심볼 대문자 → 수량). 후보 스캔용. LD* (Simple Earn 표기)는 제외. */
  async getNonZeroBalances(): Promise<Record<string, number>> {
    const data = await signedGet(
      BINANCE.baseUrl,
      BINANCE.apiKeyHeader,
      this.creds.apiKey,
      this.creds.secretKey,
      '/api/v3/account',
    );
    const balances: Array<{ asset: string; free: string }> = data.balances ?? [];
    const out: Record<string, number> = {};
    for (const b of balances) {
      const free = parseFloat(b.free ?? '0');
      const asset = b.asset.toUpperCase();
      // 주의: Binance Simple Earn 자산은 LD 접두사(LDMMT 등)로 오지만 LDO(리도) 같은 실코인도 LD로 시작.
      // 여기선 필터하지 않는다 — Earn 심볼은 USDT 페어가 없어 depth 조회에서 자연히 걸러짐.
      if (free > 0) out[asset] = free;
    }
    return out;
  }

  /**
   * LOT_SIZE stepSize 조회 (/api/v3/exchangeInfo, 공개 엔드포인트). 실패 시 1e-8 default.
   * Binance는 stepSize 미준수 수량을 거부하므로 매도 전 절사 필수.
   */
  private async getStepSize(symbol: string): Promise<number> {
    return (await this.getSymbolFilters(symbol)).stepSize;
  }

  /** LOT_SIZE stepSize + PRICE_FILTER tickSize 동시 조회·캐시 (/api/v3/exchangeInfo, 공개). */
  private async getSymbolFilters(symbol: string): Promise<{ stepSize: number; tickSize: number }> {
    const cachedStep = this.stepSizeCache.get(symbol);
    const cachedTick = this.tickSizeCache.get(symbol);
    if (cachedStep !== undefined && cachedTick !== undefined) {
      return { stepSize: cachedStep, tickSize: cachedTick };
    }
    try {
      const res = await axios.get(`${BINANCE.baseUrl}/api/v3/exchangeInfo?symbol=${symbol}USDT`, { timeout: 8000 });
      const filters = res.data?.symbols?.[0]?.filters ?? [];
      const lot = filters.find((f: any) => f.filterType === 'LOT_SIZE');
      const priceFilter = filters.find((f: any) => f.filterType === 'PRICE_FILTER');
      const step = parseFloat(lot?.stepSize ?? '0');
      const tick = parseFloat(priceFilter?.tickSize ?? '0');
      const stepSize = step > 0 ? step : 1e-8;
      const tickSize = tick > 0 ? tick : 1e-8;
      this.stepSizeCache.set(symbol, stepSize);
      this.tickSizeCache.set(symbol, tickSize);
      return { stepSize, tickSize };
    } catch {
      // 조회 실패 — 절사 없이 시도(8자리 반올림만)
      return { stepSize: this.stepSizeCache.get(symbol) ?? 1e-8, tickSize: this.tickSizeCache.get(symbol) ?? 1e-8 };
    }
  }

  /** stepSize 절사 (float 오차 방지 위해 반올림 후 내림) */
  private truncateToStep(qty: number, step: number): number {
    if (step <= 0) return qty;
    return Math.floor(Math.round(qty / step * 1e8) / 1e8) * step;
  }

  /** step/tick 단위 문자열 포맷 — 1e-4 같은 지수 표기 방지를 위해 소수 자릿수로 고정 */
  private formatByUnit(value: number, unit: number): string {
    const decimals = unit >= 1 ? 0 : Math.min(8, Math.max(0, Math.round(-Math.log10(unit))));
    return value.toFixed(decimals);
  }

  /** 주문 상태 폴링 (/api/v3/order). Binance MARKET은 대개 즉시 FULL 응답이라 보조 경로. */
  private async pollOrderStatus(
    symbol: string,
    orderId: string,
    maxRetries = 4,
  ): Promise<{ executedQty: number; cummulativeQuoteQty: number }> {
    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) await new Promise<void>((r) => setTimeout(r, 1500));
      try {
        const data = await signedGet(
          BINANCE.baseUrl,
          BINANCE.apiKeyHeader,
          this.creds.apiKey,
          this.creds.secretKey,
          '/api/v3/order',
          { symbol, orderId },
        );
        const executedQty = parseFloat(data.executedQty ?? '0');
        const cummulativeQuoteQty = parseFloat(data.cummulativeQuoteQty ?? '0');
        if (executedQty > 0) return { executedQty, cummulativeQuoteQty };
        const status = String(data.status ?? '');
        if (['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(status)) {
          return { executedQty, cummulativeQuoteQty };
        }
      } catch {
        // 재시도
      }
    }
    return { executedQty: 0, cummulativeQuoteQty: 0 };
  }

  /** 미체결 주문 취소 — 이미 종료된 주문일 수 있어 실패는 무시. */
  private async cancelOrderQuiet(symbol: string, orderId: string): Promise<void> {
    try {
      const timestamp = Date.now().toString();
      const allParams = { symbol, orderId, timestamp };
      const signature = hmacSign(this.creds.secretKey, allParams);
      const qs = new URLSearchParams({ ...allParams, signature }).toString();
      await axios.delete(`${BINANCE.baseUrl}/api/v3/order?${qs}`, {
        headers: { [BINANCE.apiKeyHeader]: this.creds.apiKey },
        timeout: 8000,
      });
    } catch {
      // 무시
    }
  }

  /**
   * 시장가 매도. sellOnBinance 이식 + MexcLeg 패턴(실잔고 min 보정) + stepSize 절사.
   */
  async sellIoc(symbol: string, quantity: number): Promise<IocResult> {
    if (!quantity || quantity <= 0) return null;

    // 실잔고 min 보정 (Float 정밀도 손실 + 수수료 base 차감 대응). 조회 실패는 원수량 진행.
    let actualBalance: number | null;
    try {
      actualBalance = await this.getBalance(symbol);
    } catch {
      actualBalance = null;
    }
    let sellQty = quantity;
    if (actualBalance !== null && actualBalance > 0) {
      sellQty = Math.min(quantity, actualBalance);
    } else if (actualBalance === 0) {
      return null;
    }

    // LOT_SIZE stepSize 절사 — Binance는 미준수 수량을 거부
    const step = await this.getStepSize(symbol);
    sellQty = this.truncateToStep(sellQty, step);
    const qtyStr = parseFloat(sellQty.toFixed(8)).toString();
    if (parseFloat(qtyStr) <= 0) return null;

    const bnbSymbol = `${symbol}USDT`;
    const data = await signedPost(
      BINANCE.baseUrl, BINANCE.apiKeyHeader, this.creds.apiKey, this.creds.secretKey,
      '/api/v3/order',
      { symbol: bnbSymbol, side: 'SELL', type: 'MARKET', quantity: qtyStr },
      BINANCE.paramsInBody,
    );

    const orderId = String(data.orderId ?? '');
    let executedQty = parseFloat(data.executedQty ?? '0');
    let cummulativeQuoteQty = parseFloat(data.cummulativeQuoteQty ?? '0');
    let commission = parseFillsCommission(data);

    if (executedQty <= 0 && orderId) {
      const polled = await this.pollOrderStatus(bnbSymbol, orderId);
      executedQty = polled.executedQty;
      cummulativeQuoteQty = polled.cummulativeQuoteQty;
      commission = null;
    }
    if (executedQty <= 0) return null;

    // 매도 수수료: USDT 차감이면 그 값, BNB 등 다른 자산이면 USDT 환산 불가 — 보수적으로 0
    const feeKrw = commission && commission.asset.toUpperCase() === 'USDT' ? commission.total : 0;
    return { filledQty: executedQty, grossKrw: cummulativeQuoteQty, feeKrw };
  }

  /**
   * 시장가 매수. buyOnBinance 이식 (quoteOrderQty 방식). MexcLeg.buyIoc와 동일 shape.
   * 매수 수수료가 코인 차감이면 filledQty에서 차감해 실수취량 반영, BNB 차감이면 feeKrw=0(보수적).
   */
  async buyIoc(
    symbol: string,
    quantity: number,
    priceHint: number,
    maxQuoteBudget?: number,
  ): Promise<IocResult> {
    const estimatedUsdt = quantity * priceHint;
    const rawUsdtAmount = maxQuoteBudget != null ? Math.min(estimatedUsdt, maxQuoteBudget) : estimatedUsdt;
    const usdtAmount = Math.floor(rawUsdtAmount * 100) / 100;
    if (usdtAmount <= 0) return null;

    const bnbSymbol = `${symbol}USDT`;
    const data = await signedPost(
      BINANCE.baseUrl, BINANCE.apiKeyHeader, this.creds.apiKey, this.creds.secretKey,
      '/api/v3/order',
      { symbol: bnbSymbol, side: 'BUY', type: 'MARKET', quoteOrderQty: usdtAmount.toFixed(2) },
      BINANCE.paramsInBody,
    );

    const orderId = String(data.orderId ?? '');
    let executedQty = parseFloat(data.executedQty ?? '0');
    let cummulativeQuoteQty = parseFloat(data.cummulativeQuoteQty ?? '0');
    let commission = parseFillsCommission(data);

    if (executedQty <= 0 && orderId) {
      const polled = await this.pollOrderStatus(bnbSymbol, orderId);
      executedQty = polled.executedQty;
      cummulativeQuoteQty = polled.cummulativeQuoteQty;
      commission = null;
    }
    if (executedQty <= 0) {
      if (orderId) await this.cancelOrderQuiet(bnbSymbol, orderId);
      return null;
    }

    let filledQty = executedQty;
    let feeKrw = 0;
    if (commission) {
      if (commission.asset.toUpperCase() === symbol.toUpperCase()) {
        filledQty = executedQty - commission.total;
        const avgPrice = executedQty > 0 ? cummulativeQuoteQty / executedQty : 0;
        feeKrw = commission.total * avgPrice;
      } else if (commission.asset.toUpperCase() === 'USDT') {
        feeKrw = commission.total;
      } else {
        // BNB 등 — USDT 환산 불가, 보수적으로 0 (실수취 코인량은 온전)
        feeKrw = 0;
      }
    }

    return { filledQty, grossKrw: cummulativeQuoteQty, feeKrw };
  }

  /**
   * 지정가 IOC 매수 (가격 보호). type=LIMIT + timeInForce=IOC.
   * limitPrice보다 비싸게 체결되지 않음. quantity는 stepSize, price는 tickSize 절사(내림 = 보호 강화 방향).
   */
  async buyLimitIoc(symbol: string, quantity: number, limitPrice: number): Promise<IocResult> {
    if (!quantity || quantity <= 0 || !(limitPrice > 0)) return null;
    const { stepSize, tickSize } = await this.getSymbolFilters(symbol);
    const qty = this.truncateToStep(quantity, stepSize);
    const price = this.truncateToStep(limitPrice, tickSize);
    if (qty <= 0 || price <= 0) return null;
    const qtyStr = this.formatByUnit(qty, stepSize);
    const priceStr = this.formatByUnit(price, tickSize);

    const bnbSymbol = `${symbol}USDT`;
    const data = await signedPost(
      BINANCE.baseUrl, BINANCE.apiKeyHeader, this.creds.apiKey, this.creds.secretKey,
      '/api/v3/order',
      { symbol: bnbSymbol, side: 'BUY', type: 'LIMIT', timeInForce: 'IOC', quantity: qtyStr, price: priceStr },
      BINANCE.paramsInBody,
    );

    const orderId = String(data.orderId ?? '');
    let executedQty = parseFloat(data.executedQty ?? '0');
    let cummulativeQuoteQty = parseFloat(data.cummulativeQuoteQty ?? '0');
    let commission = parseFillsCommission(data);

    if (executedQty <= 0 && orderId) {
      const polled = await this.pollOrderStatus(bnbSymbol, orderId);
      executedQty = polled.executedQty;
      cummulativeQuoteQty = polled.cummulativeQuoteQty;
      commission = null;
    }
    if (executedQty <= 0) {
      if (orderId) await this.cancelOrderQuiet(bnbSymbol, orderId);
      return null;
    }

    let filledQty = executedQty;
    let feeKrw = 0;
    if (commission) {
      if (commission.asset.toUpperCase() === symbol.toUpperCase()) {
        filledQty = executedQty - commission.total;
        const avgPrice = executedQty > 0 ? cummulativeQuoteQty / executedQty : 0;
        feeKrw = commission.total * avgPrice;
      } else if (commission.asset.toUpperCase() === 'USDT') {
        feeKrw = commission.total;
      }
    }

    return { filledQty, grossKrw: cummulativeQuoteQty, feeKrw };
  }

  /**
   * 지정가 IOC 매도 (가격 보호). limitPrice보다 싸게 체결되지 않음.
   * 실잔고 min 보정 + stepSize 절사는 sellIoc와 동일, price는 tickSize 절사.
   */
  async sellLimitIoc(symbol: string, quantity: number, limitPrice: number): Promise<IocResult> {
    if (!quantity || quantity <= 0 || !(limitPrice > 0)) return null;

    let actualBalance: number | null;
    try {
      actualBalance = await this.getBalance(symbol);
    } catch {
      actualBalance = null;
    }
    let sellQty = quantity;
    if (actualBalance !== null && actualBalance > 0) {
      sellQty = Math.min(quantity, actualBalance);
    } else if (actualBalance === 0) {
      return null;
    }

    const { stepSize, tickSize } = await this.getSymbolFilters(symbol);
    sellQty = this.truncateToStep(sellQty, stepSize);
    const price = this.truncateToStep(limitPrice, tickSize);
    if (sellQty <= 0 || price <= 0) return null;
    const qtyStr = this.formatByUnit(sellQty, stepSize);
    const priceStr = this.formatByUnit(price, tickSize);

    const bnbSymbol = `${symbol}USDT`;
    const data = await signedPost(
      BINANCE.baseUrl, BINANCE.apiKeyHeader, this.creds.apiKey, this.creds.secretKey,
      '/api/v3/order',
      { symbol: bnbSymbol, side: 'SELL', type: 'LIMIT', timeInForce: 'IOC', quantity: qtyStr, price: priceStr },
      BINANCE.paramsInBody,
    );

    const orderId = String(data.orderId ?? '');
    let executedQty = parseFloat(data.executedQty ?? '0');
    let cummulativeQuoteQty = parseFloat(data.cummulativeQuoteQty ?? '0');
    let commission = parseFillsCommission(data);

    if (executedQty <= 0 && orderId) {
      const polled = await this.pollOrderStatus(bnbSymbol, orderId);
      executedQty = polled.executedQty;
      cummulativeQuoteQty = polled.cummulativeQuoteQty;
      commission = null;
    }
    if (executedQty <= 0) {
      if (orderId) await this.cancelOrderQuiet(bnbSymbol, orderId);
      return null;
    }

    const feeKrw = commission && commission.asset.toUpperCase() === 'USDT' ? commission.total : 0;
    return { filledQty: executedQty, grossKrw: cummulativeQuoteQty, feeKrw };
  }

  // ── inventory arb 미사용 인터페이스 스텁 (MexcLeg 동일) ──
  async buyGtc(_symbol: string, _quantity: number, _price: number): Promise<string | null> {
    throw new Error('BinanceLeg: buyGtc not supported for inventory arb');
  }
  async placeMakerBid(_symbol: string, _price: number, _quantity: number): Promise<string | null> {
    throw new Error('BinanceLeg: placeMakerBid not supported for inventory arb');
  }
  async pollOrder(
    _orderId: string,
    _symbol?: string,
  ): Promise<{ filled: boolean; filledQty: number; grossKrw: number; feeKrw: number }> {
    throw new Error('BinanceLeg: pollOrder not supported for inventory arb');
  }
  async placeMakerAsk(_symbol: string, _price: number, _quantity: number): Promise<string | null> {
    throw new Error('BinanceLeg: placeMakerAsk not supported for inventory arb');
  }
  async cancelOrder(_orderId: string, _symbol?: string): Promise<void> {
    throw new Error('BinanceLeg: cancelOrder not supported for inventory arb');
  }
}
