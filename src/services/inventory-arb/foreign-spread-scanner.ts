// 해외 거래소(바이낸스/MEXC/Gate) 재고-무관 스프레드 스캐너.
// 공개 전체 티커(인증 불필요) 3콜 → 3쌍(바이낸스↔MEXC, Gate↔MEXC, Gate↔바이낸스)의
// USDT 페어 교집합 크로스 스프레드 계산. 정보 표시 전용(실행/잔고 무관). 관리자가 minSpreadBps로 필터·정렬.
import { summarizeCoinWallet, type WalletInfo } from './wallet-info';
import { multiArbWalletStatusService } from '../multi-arb-wallet-status.service';

/** 거래소 최우선 호가 (USDT 페어) — 수량은 해당 호가에 걸린 물량(top-of-book). Gate 티커는 수량 미제공(0). */
export interface ForeignTop {
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
}

export type ForeignExchange = 'binance' | 'mexc' | 'gateio';

// 거래소별 taker 수수료 추정(bps) — 왕복 수수료는 매수+매도측 합
const EX_FEE_BPS: Record<ForeignExchange, number> = { binance: 10, mexc: 10, gateio: 20 };

// 스캔 대상 쌍 (모든 2-조합)
const FOREIGN_PAIRS: Array<[ForeignExchange, ForeignExchange]> = [
  ['binance', 'mexc'],
  ['gateio', 'mexc'],
  ['gateio', 'binance'],
];

export interface ForeignSpread {
  symbol: string; // base (예: "BTC")
  buyExchange: ForeignExchange;
  sellExchange: ForeignExchange;
  buyPrice: number; // 매수 거래소 ask
  sellPrice: number; // 매도 거래소 bid
  maxExecutableQty: number | null; // 최우선호가 기준 최대 체결량 = min(매수측 ask물량, 매도측 bid물량). 수량 미제공(Gate 포함 쌍)이면 null
  maxExecutableUsdt: number | null; // 위 수량 × 매수가 (≈ 최우선호가 1레벨에서 소화 가능한 규모)
  spreadBps: number;
  netSpreadBps: number; // spreadBps − 왕복 수수료 추정(거래소별 합)
  realizable: boolean; // 이 시스템에서 실제 실행 가능한가 (해외는 항상 false = 관찰 전용)
  realizabilityReason: string; // 관찰 전용 사유 (입출금 동결 등)
  buyWallet?: WalletInfo; // 매수 거래소 입출금 상태
  sellWallet?: WalletInfo; // 매도 거래소 입출금 상태
  // (레거시 호환) 바이낸스↔MEXC 쌍에서만 채움 — 구 프론트 대비
  binancePrice?: number;
  mexcPrice?: number;
}

// 티커 충돌/이상치 컷 — 한쪽이 다른쪽의 5배 초과면 다른 자산 오매칭으로 간주(TROLL 27억% 류 차단)
const SANITY_RATIO = 5;

/**
 * 순수: 한 심볼의 두 거래소 최우선호가 → 수익 방향 스프레드. 없거나 이상치면 null.
 * 수량이 없는 티커(Gate)는 maxExecutable* = null.
 */
export function computeForeignSpread(
  symbol: string,
  exA: ForeignExchange, a: ForeignTop,
  exB: ForeignExchange, b: ForeignTop,
): ForeignSpread | null {
  if (a.bid <= 0 || a.ask <= 0 || b.bid <= 0 || b.ask <= 0) return null;

  // 이상치 가드: 두 거래소 mid가 5배 이상 벌어지면 티커 오매칭/불량데이터
  const aMid = (a.bid + a.ask) / 2;
  const bMid = (b.bid + b.ask) / 2;
  const hi = Math.max(aMid, bMid);
  const lo = Math.min(aMid, bMid);
  if (lo <= 0 || hi / lo > SANITY_RATIO) return null;

  // 방향 1: A 매수(ask) → B 매도(bid) / 방향 2: B 매수(ask) → A 매도(bid)
  const spread1 = b.bid / a.ask - 1;
  const spread2 = a.bid / b.ask - 1;

  let buyExchange: ForeignExchange, sellExchange: ForeignExchange, buyPrice: number, sellPrice: number, spread: number;
  let buyQty: number, sellQty: number;
  if (spread1 >= spread2) {
    buyExchange = exA; sellExchange = exB; buyPrice = a.ask; sellPrice = b.bid; spread = spread1;
    buyQty = a.askQty; sellQty = b.bidQty;
  } else {
    buyExchange = exB; sellExchange = exA; buyPrice = b.ask; sellPrice = a.bid; spread = spread2;
    buyQty = b.askQty; sellQty = a.bidQty;
  }
  if (spread <= 0) return null;

  // 최우선호가 기준 최대 체결량 — 양측 수량이 모두 있을 때만(min). Gate 티커는 수량 미제공 → null
  const hasQty = buyQty > 0 && sellQty > 0;
  const maxExecutableQty = hasQty ? Math.min(buyQty, sellQty) : null;
  const maxExecutableUsdt = maxExecutableQty != null ? maxExecutableQty * buyPrice : null;

  const spreadBps = Math.floor(spread * 10000);
  const result: ForeignSpread = {
    symbol, buyExchange, sellExchange, buyPrice, sellPrice,
    maxExecutableQty, maxExecutableUsdt,
    spreadBps,
    netSpreadBps: spreadBps - EX_FEE_BPS[buyExchange] - EX_FEE_BPS[sellExchange],
    realizable: false, // 해외는 이 시스템에서 실행 미지원 — 관찰 전용
    realizabilityReason: '관찰 전용 (해외 거래소 실행·재고 미지원)',
  };
  // 레거시 호환 필드 (바이낸스↔MEXC 쌍만)
  const mids: Partial<Record<ForeignExchange, number>> = { [exA]: aMid, [exB]: bMid };
  if (mids.binance != null && mids.mexc != null) {
    result.binancePrice = mids.binance;
    result.mexcPrice = mids.mexc;
  }
  return result;
}

async function fetchJson(url: string): Promise<any | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return null;
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** 거래소별 전체 USDT 페어 최우선호가 (base 심볼 → ForeignTop). 공개 전체 티커 1콜. */
export async function fetchBookTickers(exchange: ForeignExchange): Promise<Map<string, ForeignTop>> {
  const out = new Map<string, ForeignTop>();
  if (exchange === 'gateio') {
    // Gate 전체 티커 — highest_bid/lowest_ask만 제공(수량 없음)
    const j = await fetchJson('https://api.gateio.ws/api/v4/spot/tickers');
    if (!Array.isArray(j)) return out;
    for (const t of j) {
      const pair: string = t?.currency_pair ?? '';
      if (!pair.endsWith('_USDT')) continue;
      const base = pair.slice(0, -5);
      const bid = Number(t.highest_bid), ask = Number(t.lowest_ask);
      if (!base || !(bid > 0) || !(ask > 0)) continue;
      out.set(base, { bid, ask, bidQty: 0, askQty: 0 });
    }
    return out;
  }
  const url = exchange === 'binance'
    ? 'https://api.binance.com/api/v3/ticker/bookTicker'
    : 'https://api.mexc.com/api/v3/ticker/bookTicker';
  const j = await fetchJson(url);
  if (!Array.isArray(j)) return out;
  for (const t of j) {
    const sym: string = t?.symbol ?? '';
    if (!sym.endsWith('USDT')) continue;
    const base = sym.slice(0, -4);
    const bid = Number(t.bidPrice), ask = Number(t.askPrice);
    if (!base || !(bid > 0) || !(ask > 0)) continue;
    const bidQty = Number(t.bidQty), askQty = Number(t.askQty);
    out.set(base, { bid, ask, bidQty: bidQty > 0 ? bidQty : 0, askQty: askQty > 0 ? askQty : 0 });
  }
  return out;
}

/**
 * 3쌍(바이낸스↔MEXC, Gate↔MEXC, Gate↔바이낸스) 공통 USDT 페어 스프레드 스캔.
 * minSpreadBps 이상만, 큰 순 정렬. 같은 심볼이 여러 쌍에서 뜰 수 있음(쌍별 1행).
 * @param limit 최대 반환 수 (기본 150)
 */
export async function scanForeignSpreads(minSpreadBps: number, limit = 150): Promise<ForeignSpread[]> {
  const tickers = new Map<ForeignExchange, Map<string, ForeignTop>>();
  await Promise.all((['binance', 'mexc', 'gateio'] as ForeignExchange[]).map(async (ex) => {
    tickers.set(ex, await fetchBookTickers(ex));
  }));

  const out: ForeignSpread[] = [];
  for (const [exA, exB] of FOREIGN_PAIRS) {
    const ta = tickers.get(exA)!; const tb = tickers.get(exB)!;
    if (ta.size === 0 || tb.size === 0) continue; // 조회 실패한 거래소 쌍은 skip
    for (const [sym, a] of ta) {
      const b = tb.get(sym);
      if (!b) continue;
      const sp = computeForeignSpread(sym, exA, a, exB, b);
      if (sp && sp.spreadBps >= minSpreadBps) out.push(sp);
    }
  }
  out.sort((a, b) => b.spreadBps - a.spreadBps);
  const top = out.slice(0, limit);

  // 상위 후보에 입출금 상태 첨부 (큰 스프레드가 입출금 제한발인지 + 출금 수수료). 실패해도 스프레드는 반환.
  try {
    const wallets = await multiArbWalletStatusService.getAll();
    for (const s of top) {
      s.buyWallet = summarizeCoinWallet(wallets[s.buyExchange]?.get(s.symbol));
      s.sellWallet = summarizeCoinWallet(wallets[s.sellExchange]?.get(s.symbol));
      // 전송 차익(싼 곳 매수→출금→비싼 곳 입금→매도)에 필요: 매수측 출금 + 매도측 입금.
      // 하나라도 막혔으면 갭이 지속되는 원인 + 실현 불가.
      if (s.buyWallet.known && s.sellWallet.known && (!s.buyWallet.withdraw || !s.sellWallet.deposit)) {
        s.realizabilityReason = '입출금 동결 — 전송 차익 불가 (갭 지속 원인)';
      }
    }
  } catch {
    // 무시 — 스프레드 데이터만 반환
  }
  return top;
}
