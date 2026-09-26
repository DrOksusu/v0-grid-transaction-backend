// MEXC 거래소용 ExchangeLeg 구현 — 재고형 아비 실행 leg 어댑터
// 이식 원본: listing-auto-trader.service.ts buyOnMexc (시장가 매수, quoteOrderQty 방식)
//           listing-auto-seller.service.ts sellOnMexc/getMexcCoinBalance (시장가 매도, 실잔고 보정)
//
// 값 단위 주의: ExchangeLeg 인터페이스의 grossKrw/feeKrw 필드는 레거시 라벨이며,
// 이 구현체는 KRW가 아닌 USDT 값을 채운다 (재고형 아비는 USDT권 거래).
import axios from 'axios';
import { MEXC, hmacSign, mexcPost, signedGet } from './exchange-signer';
import type { ExchangeLeg } from '../exchange-leg';

type IocResult = { filledQty: number; grossKrw: number; feeKrw: number } | null;

/** MEXC 주문 응답에서 fills[] 파싱 (commission 합계 + commissionAsset). 없으면 null. */
function parseFillsCommission(data: any): { total: number; asset: string } | null {
  const fills: Array<{ commission?: string; commissionAsset?: string }> = data?.fills ?? [];
  if (!Array.isArray(fills) || fills.length === 0) return null;
  const total = fills.reduce((s, f) => s + parseFloat(f.commission ?? '0'), 0);
  const asset = fills[0]?.commissionAsset ?? '';
  return { total, asset };
}

export class MexcLeg implements ExchangeLeg {
  // 가격 소수 자릿수 캐시 (exchangeInfo quotePrecision) — 지정가 IOC price 절사용
  private pricePrecisionCache: Map<string, number> = new Map();

  constructor(private readonly creds: { apiKey: string; secretKey: string }) {}

  /** 가격 소수 자릿수 조회 (/api/v3/exchangeInfo, 공개). 실패 시 6자리 default. */
  private async getPricePrecision(symbol: string): Promise<number> {
    const cached = this.pricePrecisionCache.get(symbol);
    if (cached !== undefined) return cached;
    try {
      const res = await axios.get(`${MEXC.baseUrl}/api/v3/exchangeInfo?symbol=${symbol}USDT`, { timeout: 8000 });
      const info = res.data?.symbols?.[0];
      const raw = Number(info?.quotePrecision ?? info?.quoteAssetPrecision);
      const safe = Number.isFinite(raw) && raw >= 0 && raw <= 18 ? raw : 6;
      this.pricePrecisionCache.set(symbol, safe);
      return safe;
    } catch {
      return 6;
    }
  }

  /**
   * MEXC 코인 잔고 조회 (/api/v3/account).
   * sellOnMexc의 getMexcCoinBalance 이식 — 실잔고 min 보정에 사용.
   */
  async getBalance(asset: string): Promise<number> {
    const data = await signedGet(
      MEXC.baseUrl,
      MEXC.apiKeyHeader,
      this.creds.apiKey,
      this.creds.secretKey,
      '/api/v3/account',
    );
    const balances: Array<{ asset: string; free: string }> = data.balances ?? [];
    const found = balances.find((b) => b.asset.toUpperCase() === asset.toUpperCase());
    return found ? parseFloat(found.free) : 0;
  }

  /** 전체 non-zero available 잔고 (심볼 대문자 → 수량). 후보 스캔용. */
  async getNonZeroBalances(): Promise<Record<string, number>> {
    const data = await signedGet(
      MEXC.baseUrl,
      MEXC.apiKeyHeader,
      this.creds.apiKey,
      this.creds.secretKey,
      '/api/v3/account',
    );
    const balances: Array<{ asset: string; free: string }> = data.balances ?? [];
    const out: Record<string, number> = {};
    for (const b of balances) {
      const free = parseFloat(b.free ?? '0');
      if (free > 0) out[b.asset.toUpperCase()] = free;
    }
    return out;
  }

  /**
   * MEXC 주문 폴링 (/api/v3/order). fills 정보는 제공하지 않음 — executedQty/cummulativeQuoteQty만.
   * pollMexcFilledQty/pollMexcFilledUsdt 이식.
   */
  private async pollOrderStatus(
    symbol: string,
    orderId: string,
    maxRetries = 4,
  ): Promise<{ executedQty: number; cummulativeQuoteQty: number }> {
    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) await new Promise<void>((r) => setTimeout(r, 1500));
      try {
        const data = await signedGet(
          MEXC.baseUrl,
          MEXC.apiKeyHeader,
          this.creds.apiKey,
          this.creds.secretKey,
          '/api/v3/order',
          { symbol, orderId },
        );
        const executedQty = parseFloat(data.executedQty ?? '0');
        const cummulativeQuoteQty = parseFloat(data.cummulativeQuoteQty ?? '0');
        if (executedQty > 0) return { executedQty, cummulativeQuoteQty };
        // 종료 상태면 더 기다려도 의미 없음
        const status = String(data.status ?? '');
        if (['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED', 'PARTIALLY_CANCELED'].includes(status)) {
          return { executedQty, cummulativeQuoteQty };
        }
      } catch {
        // 재시도
      }
    }
    return { executedQty: 0, cummulativeQuoteQty: 0 };
  }

  /**
   * 미체결 주문 취소. cancelMexcOrder 이식 — 이미 종료된 주문일 수 있어 실패는 무시.
   */
  private async cancelOrderQuiet(symbol: string, orderId: string): Promise<void> {
    try {
      const timestamp = Date.now().toString();
      const allParams = { symbol, orderId, timestamp };
      const signature = hmacSign(this.creds.secretKey, allParams);
      const qs = new URLSearchParams({ ...allParams, signature }).toString();
      await axios.delete(`${MEXC.baseUrl}/api/v3/order?${qs}`, {
        headers: { [MEXC.apiKeyHeader]: this.creds.apiKey },
        timeout: 8000,
      });
    } catch {
      // 이미 종료된 주문일 수 있음 — 무시
    }
  }

  /**
   * 시장가 IOC 매도. sellOnMexc 이식.
   * - 실잔고(getBalance) min 보정 (Float 정밀도 손실 + 수수료 base 차감 대응)
   * - MEXC LOT_SIZE 필터 통과를 위해 8자리 반올림
   * - 즉시 응답에 fills가 있으면 commission 사용, 없으면 폴링(commission 정보 없음 → feeKrw=0)
   */
  async sellIoc(symbol: string, quantity: number): Promise<IocResult> {
    if (!quantity || quantity <= 0) return null;

    // getMexcCoinBalance 이식 — 잔고조회 실패(네트워크 블립 등)는 null로 흡수하고 원래 수량 그대로 진행.
    // (여기서 throw하면 정상 매도 시도조차 안 하고 flatten_failed로 승격되어 원본보다 취약해짐)
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
      // 실잔고 0 — 매도 시도 무의미
      return null;
    }
    // MEXC LOT_SIZE 필터 통과를 위해 8자리 반올림 (float→string 정밀도 오류 방지)
    const qtyStr = parseFloat(sellQty.toFixed(8)).toString();
    if (parseFloat(qtyStr) <= 0) return null;

    const mexcSymbol = `${symbol}USDT`;
    const data = await mexcPost(this.creds.apiKey, this.creds.secretKey, '/api/v3/order', {
      symbol: mexcSymbol,
      side: 'SELL',
      type: 'MARKET',
      quantity: qtyStr,
    });

    const orderId = String(data.orderId ?? '');
    let executedQty = parseFloat(data.executedQty ?? '0');
    let cummulativeQuoteQty = parseFloat(data.cummulativeQuoteQty ?? '0');
    let commission = parseFillsCommission(data);

    // MEXC는 매도 즉시 응답에서 executedQty/cummulativeQuoteQty=0을 반환할 수 있어 폴링 필요
    // (폴링 경로는 fills를 주지 않으므로 commission 정보는 확보 불가 — feeKrw=0으로 처리)
    if (executedQty <= 0 && orderId) {
      const polled = await this.pollOrderStatus(mexcSymbol, orderId);
      executedQty = polled.executedQty;
      cummulativeQuoteQty = polled.cummulativeQuoteQty;
      commission = null;
    }

    if (executedQty <= 0) return null;

    const feeKrw = commission && commission.asset.toUpperCase() === 'USDT' ? commission.total : 0;
    return {
      filledQty: executedQty,
      grossKrw: cummulativeQuoteQty,
      feeKrw,
    };
  }

  /**
   * 시장가 IOC 매수. buyOnMexc 이식 (quoteOrderQty 방식 — MEXC MARKET BUY의 검증된 유일 경로).
   * ExchangeLeg 인터페이스는 quantity(코인수량) 기준이므로 qty*priceHint(및 maxQuoteBudget cap)로
   * USDT 지출액을 산출한다 (UpbitLeg/BithumbLeg의 estimatedKrw 패턴과 동일 shape).
   *
   * 매수 수수료가 코인에서 차감되면(commissionAsset=코인) filledQty에서 차감해 실수취량을 반영.
   * 폴링 경로는 fills(commission)를 주지 않으므로 그 경우 feeKrw=0 — 코인차감 미보정 리스크는
   * 하류 sellIoc의 getBalance min 보정이 최종 방어선.
   */
  async buyIoc(
    symbol: string,
    quantity: number,
    priceHint: number,
    maxQuoteBudget?: number,
  ): Promise<IocResult> {
    const estimatedUsdt = quantity * priceHint;
    const rawUsdtAmount = maxQuoteBudget != null ? Math.min(estimatedUsdt, maxQuoteBudget) : estimatedUsdt;
    // buyOnMexc와 동일하게 절사(truncate) — 반올림 시 maxQuoteBudget을 미세 초과할 수 있어 원본과 동일하게 내림 처리
    const usdtAmount = Math.floor(rawUsdtAmount * 100) / 100;
    if (usdtAmount <= 0) return null;

    const mexcSymbol = `${symbol}USDT`;
    const data = await mexcPost(this.creds.apiKey, this.creds.secretKey, '/api/v3/order', {
      symbol: mexcSymbol,
      side: 'BUY',
      type: 'MARKET',
      quoteOrderQty: usdtAmount.toFixed(2),
    });

    const orderId = String(data.orderId ?? '');
    let executedQty = parseFloat(data.executedQty ?? '0');
    let cummulativeQuoteQty = parseFloat(data.cummulativeQuoteQty ?? '0');
    let commission = parseFillsCommission(data);

    // MEXC quoteOrderQty 매수는 즉시 응답에서 executedQty=0을 반환하므로 폴링으로 실제 체결량 확인
    if (executedQty <= 0 && orderId) {
      const polled = await this.pollOrderStatus(mexcSymbol, orderId);
      executedQty = polled.executedQty;
      cummulativeQuoteQty = polled.cummulativeQuoteQty;
      commission = null;
    }

    // 폴링 후에도 미체결이면 주문 취소 시도 후 null (빈 포지션 재고화 방지)
    if (executedQty <= 0) {
      if (orderId) await this.cancelOrderQuiet(mexcSymbol, orderId);
      return null;
    }

    let filledQty = executedQty;
    let feeKrw = 0;
    if (commission) {
      if (commission.asset.toUpperCase() === symbol.toUpperCase()) {
        // 매수 수수료가 코인에서 차감 — 실수취량 = executedQty - commission
        filledQty = executedQty - commission.total;
        // feeKrw(USDT 환산) = commission(코인) × 체결단가(avgPrice = grossKrw/executedQty)
        const avgPrice = executedQty > 0 ? cummulativeQuoteQty / executedQty : 0;
        feeKrw = commission.total * avgPrice;
      } else if (commission.asset.toUpperCase() === 'USDT') {
        feeKrw = commission.total;
      } else {
        // commissionAsset이 코인도 USDT도 아니면(예: MX 포인트 등) USDT 환산 불가 — 보수적으로 0
        feeKrw = 0;
      }
    }

    return {
      filledQty,
      grossKrw: cummulativeQuoteQty,
      feeKrw,
    };
  }

  /**
   * 지정가 IOC 매수 (가격 보호). MEXC type=IMMEDIATE_OR_CANCEL (quantity+price 필수).
   * limitPrice보다 비싸게 체결되지 않음. 체결 파싱·fee-in-coin 처리는 buyIoc와 동일.
   */
  async buyLimitIoc(symbol: string, quantity: number, limitPrice: number): Promise<IocResult> {
    if (!quantity || quantity <= 0 || !(limitPrice > 0)) return null;
    const qtyStr = parseFloat(quantity.toFixed(8)).toString();
    if (parseFloat(qtyStr) <= 0) return null;
    const pricePrecision = await this.getPricePrecision(symbol);
    // 매수 limit은 내림 절사 = 보호 강화 방향
    const priceStr = (Math.floor(limitPrice * Math.pow(10, pricePrecision)) / Math.pow(10, pricePrecision)).toFixed(pricePrecision);
    if (parseFloat(priceStr) <= 0) return null;

    const mexcSymbol = `${symbol}USDT`;
    const data = await mexcPost(this.creds.apiKey, this.creds.secretKey, '/api/v3/order', {
      symbol: mexcSymbol,
      side: 'BUY',
      type: 'IMMEDIATE_OR_CANCEL',
      quantity: qtyStr,
      price: priceStr,
    });

    const orderId = String(data.orderId ?? '');
    let executedQty = parseFloat(data.executedQty ?? '0');
    let cummulativeQuoteQty = parseFloat(data.cummulativeQuoteQty ?? '0');
    let commission = parseFillsCommission(data);

    if (executedQty <= 0 && orderId) {
      const polled = await this.pollOrderStatus(mexcSymbol, orderId);
      executedQty = polled.executedQty;
      cummulativeQuoteQty = polled.cummulativeQuoteQty;
      commission = null;
    }
    if (executedQty <= 0) {
      // IOC는 잔량 자동취소되나 방어적으로 취소 시도 (이미 종료면 무시됨)
      if (orderId) await this.cancelOrderQuiet(mexcSymbol, orderId);
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
   * 실잔고 min 보정 + 8자리 반올림은 sellIoc와 동일.
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
    const qtyStr = parseFloat(sellQty.toFixed(8)).toString();
    if (parseFloat(qtyStr) <= 0) return null;
    const pricePrecision = await this.getPricePrecision(symbol);
    const priceStr = (Math.floor(limitPrice * Math.pow(10, pricePrecision)) / Math.pow(10, pricePrecision)).toFixed(pricePrecision);
    if (parseFloat(priceStr) <= 0) return null;

    const mexcSymbol = `${symbol}USDT`;
    const data = await mexcPost(this.creds.apiKey, this.creds.secretKey, '/api/v3/order', {
      symbol: mexcSymbol,
      side: 'SELL',
      type: 'IMMEDIATE_OR_CANCEL',
      quantity: qtyStr,
      price: priceStr,
    });

    const orderId = String(data.orderId ?? '');
    let executedQty = parseFloat(data.executedQty ?? '0');
    let cummulativeQuoteQty = parseFloat(data.cummulativeQuoteQty ?? '0');
    let commission = parseFillsCommission(data);

    if (executedQty <= 0 && orderId) {
      const polled = await this.pollOrderStatus(mexcSymbol, orderId);
      executedQty = polled.executedQty;
      cummulativeQuoteQty = polled.cummulativeQuoteQty;
      commission = null;
    }
    if (executedQty <= 0) {
      if (orderId) await this.cancelOrderQuiet(mexcSymbol, orderId);
      return null;
    }

    const feeKrw = commission && commission.asset.toUpperCase() === 'USDT' ? commission.total : 0;
    return { filledQty: executedQty, grossKrw: cummulativeQuoteQty, feeKrw };
  }

  async buyGtc(_symbol: string, _quantity: number, _price: number): Promise<string | null> {
    throw new Error('MexcLeg: buyGtc not supported for inventory arb');
  }

  async placeMakerBid(_symbol: string, _price: number, _quantity: number): Promise<string | null> {
    throw new Error('MexcLeg: placeMakerBid not supported for inventory arb');
  }

  async pollOrder(
    _orderId: string,
    _symbol?: string,
  ): Promise<{ filled: boolean; filledQty: number; grossKrw: number; feeKrw: number }> {
    throw new Error('MexcLeg: pollOrder not supported for inventory arb');
  }

  async placeMakerAsk(_symbol: string, _price: number, _quantity: number): Promise<string | null> {
    throw new Error('MexcLeg: placeMakerAsk not supported for inventory arb');
  }

  async cancelOrder(_orderId: string, _symbol?: string): Promise<void> {
    throw new Error('MexcLeg: cancelOrder not supported for inventory arb');
  }
}
