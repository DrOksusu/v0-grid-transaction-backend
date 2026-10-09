// MEXC 현물 그리드 어댑터 — GridTradeClient 규격 구현.
// 재고형 아비용 MexcLeg(IOC)와 별개: 그리드는 GTC 지정가 + 체결 폴링이 필요하다.
import axios from 'axios';
import { MEXC, mexcPost, signedGet, hmacSign } from './exchange-signer';

/** unit의 소수 자릿수. (0.000001→6, 0.1→1, 0.25→2, 1→0) */
function decimalsOf(unit: number): number {
  if (!(unit > 0) || !isFinite(unit)) return 0;
  const [mant, exp] = unit.toExponential().split('e'); // "2.5e-1" → ["2.5","-1"]
  const frac = mant.split('.')[1] ?? '';
  return Math.max(0, frac.length - Number(exp));
}

/** 수량을 stepSize 배수로 내림(floor). 부동소수 노이즈 거리일 때만 정수 스냅(올림 절대 금지). */
export function roundToStep(qty: number, step: number): number {
  if (!(step > 0)) return qty;
  const ratio = qty / step;
  const r = Math.round(ratio);
  // 부동소수 노이즈 거리(상대 16*EPSILON)일 때만 정수 스냅, 아니면 내림(올림 절대 금지)
  const n = Math.abs(ratio - r) <= Math.abs(ratio) * 16 * Number.EPSILON ? r : Math.floor(ratio);
  const d = decimalsOf(step);
  let out = Number((n * step).toFixed(d));
  if (out > qty) out = Number(((n - 1) * step).toFixed(d)); // floor 보장: 한 단계 하향
  return out;
}

/** 가격을 tickSize 배수로 내림(floor). 보정 방식은 roundToStep과 동일. */
export function roundToTick(price: number, tick: number): number {
  if (!(tick > 0)) return price;
  const ratio = price / tick;
  const r = Math.round(ratio);
  const n = Math.abs(ratio - r) <= Math.abs(ratio) * 16 * Number.EPSILON ? r : Math.floor(ratio);
  const d = decimalsOf(tick);
  let out = Number((n * tick).toFixed(d));
  if (out > price) out = Number(((n - 1) * tick).toFixed(d)); // floor 보장: 한 단계 하향
  return out;
}

/** qty*price 가 minNotional 이상인지. */
export function meetsMinNotional(qty: number, price: number, minNotional: number): boolean {
  return qty * price >= minNotional;
}

/** number → 거래소 전송용 문자열. 지수표기(1e-7)는 거래소가 거부하므로 고정소수로 변환. */
function toPlain(n: number, unit: number): string {
  const s = String(n);
  return s.includes('e') ? n.toFixed(decimalsOf(unit)) : s;
}

export interface SymbolFilters { tickSize: number; stepSize: number; minNotional: number; }

const DEFAULT_FILTERS: SymbolFilters = { tickSize: 0.01, stepSize: 0.000001, minNotional: 1 };

export class MexcGridClient {
  private filtersCache = new Map<string, { at: number; f: SymbolFilters }>();

  constructor(private readonly creds: { apiKey: string; secretKey: string }) {}

  /**
   * exchangeInfo 정밀도 조회(공개 API, 1시간 캐시).
   * 규약: symbol은 완전 페어(예 'BTCUSDT')를 받는다 — 그리드는 bot.ticker를 그대로 넘김.
   *       (MexcLeg는 base심볼+USDT를 조합하므로 다름.)
   * MEXC symbols[0].filters에는 PRICE_FILTER/LOT_SIZE가 없어 심볼 객체 필드를 사용:
   *   quotePrecision→tickSize, baseSizePrecision(없으면 baseAssetPrecision)→stepSize, quoteAmountPrecision→minNotional.
   * 실패/파싱불가 시 보수적 기본값(캐시하지 않음).
   */
  async getFilters(symbol: string): Promise<SymbolFilters> {
    const hit = this.filtersCache.get(symbol);
    if (hit && Date.now() - hit.at < 3600_000) return hit.f;
    try {
      const res = await axios.get(`${MEXC.baseUrl}/api/v3/exchangeInfo?symbol=${symbol}`, { timeout: 8000 });
      const info = res.data?.symbols?.[0];
      if (!info) {
        console.warn(`[MexcGridClient] ${symbol} exchangeInfo 심볼 정보 없음 — 기본 필터 사용`);
        return { ...DEFAULT_FILTERS };
      }
      const qp = Number(info.quotePrecision);
      const okTick = info.quotePrecision != null && Number.isInteger(qp) && qp >= 0 && qp <= 18;
      const tickSize = okTick ? 10 ** -qp : DEFAULT_FILTERS.tickSize;
      const bsp = Number(info.baseSizePrecision);
      const bap = Number(info.baseAssetPrecision);
      let stepSize: number;
      let okStep = true;
      if (bsp > 0) stepSize = bsp;
      else if (Number.isInteger(bap) && bap > 0 && bap <= 18) stepSize = 10 ** -bap;
      else { stepSize = 1; okStep = false; }
      const qap = Number(info.quoteAmountPrecision);
      const okNotional = qap > 0;
      const minNotional = okNotional ? qap : DEFAULT_FILTERS.minNotional;
      const f: SymbolFilters = { tickSize, stepSize, minNotional };
      if (!(okTick || okStep || okNotional)) {
        console.warn(`[MexcGridClient] ${symbol} 정밀도 필드 파싱 불가 — 기본 필터 사용(캐시 안 함)`);
        return f;
      }
      this.filtersCache.set(symbol, { at: Date.now(), f });
      return f;
    } catch (e) {
      console.warn(`[MexcGridClient] ${symbol} exchangeInfo 조회 실패 — 기본 필터 사용:`, (e as Error)?.message);
      return { ...DEFAULT_FILTERS };
    }
  }

  private async placeLimit(symbol: string, side: 'BUY' | 'SELL', price: number, volume: number): Promise<{ uuid: string }> {
    const f = await this.getFilters(symbol);
    const p = roundToTick(price, f.tickSize);
    const q = roundToStep(volume, f.stepSize);
    if (!meetsMinNotional(q, p, f.minNotional)) {
      throw new Error(`MEXC minNotional 미만: ${(q * p).toFixed(4)} < ${f.minNotional}`);
    }
    const params: Record<string, string> = {
      symbol,
      side,
      type: 'LIMIT',
      timeInForce: 'GTC',
      quantity: toPlain(q, f.stepSize),
      price: toPlain(p, f.tickSize),
    };
    let resp: any;
    try {
      resp = await mexcPost(this.creds.apiKey, this.creds.secretKey, '/api/v3/order', params);
    } catch (err) {
      // BUY 잔고부족을 엔진의 isBalanceError(쿨다운/원거리 주문 정리)가 감지하도록 정규화.
      // 실제 code/msg 실측이 없어 관대하게 감지하고 원시값을 로깅한다(추후 타이트닝용).
      // SELL(코인 부족=oversold)은 매수주문 정리를 유발하면 안 되므로 원문 그대로 던진다.
      const code = (err as any)?.response?.data?.code;
      const rawMsg = String((err as any)?.response?.data?.msg ?? (err as any)?.message ?? '');
      // code가 문자열로 올 수도 있어 Number()로 보정(NaN은 미매칭)
      const looksInsufficient = /insufficient|oversold|not enough|balance|position/i.test(rawMsg) || [-2010, 30004, 30005].includes(Number(code));
      if (side === 'BUY' && looksInsufficient) {
        console.warn(`[MexcGridClient] ${symbol} BUY 잔고부족 추정 (code=${code}, msg=${rawMsg})`);
        const e: any = new Error(`MEXC 잔고 부족(insufficient balance): ${rawMsg}`);
        e.response = (err as any)?.response;
        throw e;
      }
      throw err;
    }
    if (resp?.orderId == null || resp.orderId === '') {
      throw new Error('MEXC 주문 응답에 orderId 없음: ' + JSON.stringify(resp));
    }
    return { uuid: String(resp.orderId) };
  }

  async buyLimit(market: string, price: number, volume: number): Promise<{ uuid: string }> {
    return this.placeLimit(market, 'BUY', price, volume);
  }

  async sellLimit(market: string, price: number, volume: number): Promise<{ uuid: string }> {
    return this.placeLimit(market, 'SELL', price, volume);
  }

  /** MEXC 체결건을 업비트형({uuid,state:'done',avgFillPrice,filledQty,trades})으로 정규화. */
  async getFilledOrders(market?: string, limit: number = 100): Promise<any[]> {
    if (!market) return []; // MEXC allOrders는 symbol 필수
    const data = await signedGet(
      MEXC.baseUrl, MEXC.apiKeyHeader, this.creds.apiKey, this.creds.secretKey,
      '/api/v3/allOrders', { symbol: market, limit: String(Math.min(limit, 100)) },
    );
    const rows: any[] = Array.isArray(data) ? data : [];
    return rows
      // PARTIALLY_FILLED는 제외(업비트 state:'done'=완전체결과 동일 의미론). 장기 미체결/부분체결 그리드 감지는
      // Task 6의 getOrder 단건 백스톱(Stage-2)에서 보강.
      .filter((o) => String(o.status) === 'FILLED')
      .map((o) => {
        const qty = parseFloat(o.executedQty ?? '0');
        const quote = parseFloat(o.cummulativeQuoteQty ?? '0');
        const avgRaw = qty > 0 ? quote / qty : parseFloat(o.price ?? '0');
        const avg = Number.isFinite(avgRaw) ? avgRaw : 0;
        const ts = Number(o.updateTime ?? o.time ?? Date.now());
        return { uuid: String(o.orderId), state: 'done', avgFillPrice: avg, filledQty: qty, trades: [{ created_at: new Date(ts).toISOString() }] };
      });
  }

  /** 단건 주문 조회 → bithumb식 {status:'filled'|'cancelled'|'pending', avgFillPrice, filledQty}. */
  async getOrder(orderId: string, symbol: string): Promise<{ status: string; avgFillPrice: number; filledQty: number }> {
    const data = await signedGet(
      MEXC.baseUrl, MEXC.apiKeyHeader, this.creds.apiKey, this.creds.secretKey,
      '/api/v3/order', { symbol, orderId },
    );
    const qty = parseFloat(data.executedQty ?? '0');
    const quote = parseFloat(data.cummulativeQuoteQty ?? '0');
    const raw = String(data.status ?? '');
    const status = raw === 'FILLED' ? 'filled'
      : ['CANCELED', 'PARTIALLY_CANCELED', 'EXPIRED', 'REJECTED'].includes(raw) ? 'cancelled'
      : 'pending';
    const avgRaw = qty > 0 ? quote / qty : parseFloat(data.price ?? '0');
    return { status, avgFillPrice: Number.isFinite(avgRaw) ? avgRaw : 0, filledQty: qty };
  }

  /** USDT 가용 잔고(free). pre-flight용. */
  async getUsdtBalance(): Promise<number> {
    const data = await signedGet(
      MEXC.baseUrl, MEXC.apiKeyHeader, this.creds.apiKey, this.creds.secretKey, '/api/v3/account',
    );
    const b = (data.balances ?? []).find((x: any) => String(x.asset).toUpperCase() === 'USDT');
    return b ? parseFloat(b.free ?? '0') : 0;
  }

  /** 미체결 취소(DELETE /api/v3/order). 이미 종료/미존재(-2011)만 무시, 그 외 실패는 throw. */
  async cancelOrder(orderId: string, symbol?: string): Promise<void> {
    if (!symbol) return; // MEXC는 symbol 필수
    try {
      const timestamp = Date.now().toString();
      const allParams = { symbol, orderId, timestamp };
      const signature = hmacSign(this.creds.secretKey, allParams);
      const qs = new URLSearchParams({ ...allParams, signature }).toString();
      await axios.delete(`${MEXC.baseUrl}/api/v3/order?${qs}`, {
        headers: { [MEXC.apiKeyHeader]: this.creds.apiKey },
        timeout: 8000,
      });
    } catch (err: any) {
      // 이미 종료/미존재 주문(-2011 Unknown order)만 무시. 나머지(네트워크·인증·서명)는 rethrow
      // → 호출부가 "취소 성공"으로 오인해 거래소에 GTC 주문이 고아로 남는 것 방지.
      const code = err?.response?.data?.code;
      const msg = String(err?.response?.data?.msg ?? err?.message ?? '');
      if (code === -2011 || /unknown order|order does not exist|not exist/i.test(msg)) {
        return; // 이미 없음 — 성공 취급
      }
      throw err;
    }
  }
}
