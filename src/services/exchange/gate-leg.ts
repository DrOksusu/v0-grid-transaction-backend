// Gate.io 거래소용 ExchangeLeg 구현 — 재고형 아비 실행 leg 어댑터
// 이식 원본: listing-auto-trader.service.ts buyOnGateio (시장가 매수, amount=USDT quote 방식)
//           listing-auto-seller.service.ts sellOnGateio/getGateioCoinBalance/getGateioAmountPrecision
//           (시장가 매도, fee-in-coin 잔고 보정 + amount_precision 절사)
//
// 값 단위 주의: ExchangeLeg 인터페이스의 grossKrw/feeKrw 필드는 레거시 라벨이며,
// 이 구현체는 KRW가 아닌 USDT 값을 채운다 (재고형 아비는 USDT권 거래).
import axios from 'axios';
import { gateioRequest } from './exchange-signer';
import type { ExchangeLeg } from '../exchange-leg';

type IocResult = { filledQty: number; grossKrw: number; feeKrw: number } | null;

const GATE_MIN_QUOTE_USDT = 3; // Gate.io 최소 주문금액(3 USDT) — buyOnGateio/spec §0 참조

export class GateLeg implements ExchangeLeg {
  // 마켓 정밀도 캐시 (프로세스 생명주기 동안 유효) — getGateioAmountPrecision 원본 그대로 이식
  private amountPrecisionCache: Map<string, number> = new Map();

  constructor(private readonly creds: { apiKey: string; secretKey: string }) {}

  /**
   * Gate.io 코인 잔고 조회 (/api/v4/spot/accounts?currency=xxx).
   * sellOnGateio의 getGateioCoinBalance 이식 — 실잔고 min 보정에 사용.
   * getBalance 자체는 실패 시 throw (재고가드용 public 메서드 — MexcLeg와 동일 비대칭:
   * sellIoc 내부 호출은 try-catch로 흡수, 이 메서드 자체는 흡수하지 않음).
   */
  async getBalance(asset: string): Promise<number> {
    const data = await gateioRequest(
      this.creds.apiKey,
      this.creds.secretKey,
      'GET',
      '/api/v4/spot/accounts',
      `currency=${asset}`,
    );
    if (Array.isArray(data) && data.length > 0) {
      return parseFloat(data[0].available ?? '0');
    }
    return 0;
  }

  /**
   * Gate.io 마켓 amount_precision 조회 (/api/v4/spot/currency_pairs/{ticker}_USDT).
   * getGateioAmountPrecision 원본 그대로 이식 — 공개 엔드포인트라 비서명 axios.get 사용(원본과 동일,
   * gateioRequest로 바꾸지 않음). 조회 실패 시 8자리 default. 캐시로 반복 조회 방지.
   */
  private async getAmountPrecision(symbol: string): Promise<number> {
    const cached = this.amountPrecisionCache.get(symbol);
    if (cached !== undefined) return cached;
    try {
      const res = await axios.get(
        `https://api.gateio.ws/api/v4/spot/currency_pairs/${symbol}_USDT`,
        { timeout: 4000 },
      );
      const precision = Number(res.data?.amount_precision);
      const safe = Number.isFinite(precision) && precision >= 0 ? precision : 8;
      this.amountPrecisionCache.set(symbol, safe);
      return safe;
    } catch {
      return 8;
    }
  }

  /**
   * Gate.io 주문 체결 폴링 (/api/v4/spot/orders/{orderId}).
   * pollGateioFilledQty/pollGateioFillPrice 이식 — filled_amount/avg_deal_price/filled_total 확인.
   */
  private async pollOrderStatus(
    symbol: string,
    orderId: string,
    maxRetries = 4,
  ): Promise<{ filledAmount: number; avgDealPrice: number; filledTotal: number }> {
    for (let i = 0; i < maxRetries; i++) {
      if (i > 0) await new Promise<void>((r) => setTimeout(r, 1500));
      try {
        const data = await gateioRequest(
          this.creds.apiKey,
          this.creds.secretKey,
          'GET',
          `/api/v4/spot/orders/${orderId}`,
          `currency_pair=${symbol}_USDT`,
        );
        const filledAmount = parseFloat(data.filled_amount ?? '0');
        const avgDealPrice = parseFloat(data.avg_deal_price ?? '0');
        const filledTotal = parseFloat(data.filled_total ?? '0');
        if (filledAmount > 0) return { filledAmount, avgDealPrice, filledTotal };
      } catch {
        // 재시도
      }
    }
    return { filledAmount: 0, avgDealPrice: 0, filledTotal: 0 };
  }

  /**
   * 시장가 IOC 매수. buyOnGateio 이식.
   * - Gate market buy의 amount = quote(USDT) 금액 (base 코인 수량 아님 — 혼동 절대 금지)
   * - Gate 최소주문 3 USDT 미만이면 null (호출 자체 skip)
   * - 매수 수수료가 base 코인에서 차감될 수 있음(fee/fee_currency) → 실수취 코인 = filled_amount − fee(코인 환산)
   *   (SPX 2026-06-16 사고 교훈 — 하류 매도 시 잔고부족 방지)
   */
  async buyIoc(
    symbol: string,
    quantity: number,
    priceHint: number,
    maxQuoteBudget?: number,
  ): Promise<IocResult> {
    const estimatedUsdt = quantity * priceHint;
    const rawUsdtAmount = maxQuoteBudget != null ? Math.min(estimatedUsdt, maxQuoteBudget) : estimatedUsdt;
    // buyOnGateio와 동일하게 절사(truncate) — 반올림 시 예산/최소주문을 미세 초과할 수 있어 내림 처리
    const usdtAmount = Math.floor(rawUsdtAmount * 100) / 100;
    if (usdtAmount < GATE_MIN_QUOTE_USDT) return null;

    const body = JSON.stringify({
      currency_pair: `${symbol}_USDT`,
      type: 'market',
      side: 'buy',
      amount: usdtAmount.toFixed(2),
      time_in_force: 'ioc',
    });

    const data = await gateioRequest(this.creds.apiKey, this.creds.secretKey, 'POST', '/api/v4/spot/orders', '', body);
    const orderId = String(data.id ?? '');

    let filledAmount = parseFloat(data.filled_amount ?? '0');
    let avgDealPrice = parseFloat(data.avg_deal_price ?? '0');
    let filledTotal = parseFloat(data.filled_total ?? '0');
    let fee = parseFloat(data.fee ?? '0');
    let feeCurrency = String(data.fee_currency ?? '');

    // 즉시 응답에 체결 정보 없으면 폴링 (Gate IOC 매수 fill_price=0 대응)
    if (filledAmount <= 0 && orderId) {
      const polled = await this.pollOrderStatus(symbol, orderId);
      filledAmount = polled.filledAmount;
      avgDealPrice = polled.avgDealPrice;
      filledTotal = polled.filledTotal;
      // 폴링 경로는 fee/fee_currency를 제공하지 않음(원본 폴링 응답도 fee 필드 미확인) — 보수적으로 0 처리
      fee = 0;
      feeCurrency = '';
    }

    if (filledAmount <= 0) return null;

    const grossUsdt = filledTotal > 0 ? filledTotal : usdtAmount;

    let filledQty = filledAmount;
    let feeUsdt = 0;
    if (fee > 0 && feeCurrency) {
      if (feeCurrency.toUpperCase() === symbol.toUpperCase()) {
        // 매수 수수료가 코인에서 차감 — 실수취량 = filled_amount - fee
        filledQty = filledAmount - fee;
        const avgPrice = avgDealPrice > 0 ? avgDealPrice : (filledAmount > 0 ? grossUsdt / filledAmount : 0);
        feeUsdt = fee * avgPrice;
      } else if (feeCurrency.toUpperCase() === 'USDT') {
        feeUsdt = fee;
      }
      // 그 외 통화(GT 포인트 등)는 USDT 환산 불가 — 보수적으로 0
    }

    return {
      filledQty,
      grossKrw: grossUsdt,
      feeKrw: feeUsdt,
    };
  }

  /**
   * 시장가 IOC 매도. sellOnGateio 이식.
   * - 실잔고(getBalance) min 보정 (매수 시 fee-in-coin 차감 대응 — SPX 2026-06-16 사고 교훈)
   * - amount_precision 절사(내림)
   * - Gate market sell의 amount = base(코인) 수량
   */
  async sellIoc(symbol: string, quantity: number): Promise<IocResult> {
    if (!quantity || quantity <= 0) return null;

    // getGateioCoinBalance 이식 — 잔고조회 실패(네트워크 블립 등)는 흡수하고 원래 수량 그대로 진행.
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

    // amount_precision 적용 (소수점 절사)
    const amountPrecision = await this.getAmountPrecision(symbol);
    const factor = Math.pow(10, amountPrecision);
    sellQty = Math.floor(sellQty * factor) / factor;
    if (sellQty <= 0) return null;
    const qtyStr = sellQty.toString();

    const body = JSON.stringify({
      currency_pair: `${symbol}_USDT`,
      type: 'market',
      side: 'sell',
      amount: qtyStr,
      time_in_force: 'ioc',
    });

    const data = await gateioRequest(this.creds.apiKey, this.creds.secretKey, 'POST', '/api/v4/spot/orders', '', body);

    const avgDealPrice = parseFloat(data.avg_deal_price ?? '0');
    const filledTotal = parseFloat(data.filled_total ?? '0');
    const left = parseFloat(data.left ?? '0');
    const requestedQty = parseFloat(data.amount ?? qtyStr);
    const filledQty = parseFloat(data.filled_amount ?? '0') || (requestedQty - left) || 0;

    if (filledQty <= 0) return null;

    const grossUsdt = filledTotal > 0 ? filledTotal : (avgDealPrice > 0 ? avgDealPrice * filledQty : 0);

    const fee = parseFloat(data.fee ?? '0');
    const feeCurrency = String(data.fee_currency ?? '');
    const feeUsdt = fee > 0 && feeCurrency.toUpperCase() === 'USDT' ? fee : 0;

    return {
      filledQty,
      grossKrw: grossUsdt,
      feeKrw: feeUsdt,
    };
  }

  async buyGtc(_symbol: string, _quantity: number, _price: number): Promise<string | null> {
    throw new Error('GateLeg: buyGtc not supported for inventory arb');
  }

  async placeMakerBid(_symbol: string, _price: number, _quantity: number): Promise<string | null> {
    throw new Error('GateLeg: placeMakerBid not supported for inventory arb');
  }

  async pollOrder(
    _orderId: string,
    _symbol?: string,
  ): Promise<{ filled: boolean; filledQty: number; grossKrw: number; feeKrw: number }> {
    throw new Error('GateLeg: pollOrder not supported for inventory arb');
  }

  async placeMakerAsk(_symbol: string, _price: number, _quantity: number): Promise<string | null> {
    throw new Error('GateLeg: placeMakerAsk not supported for inventory arb');
  }

  async cancelOrder(_orderId: string, _symbol?: string): Promise<void> {
    throw new Error('GateLeg: cancelOrder not supported for inventory arb');
  }
}
