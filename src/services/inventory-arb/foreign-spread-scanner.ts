// 해외 거래소(바이낸스↔MEXC) 재고-무관 스프레드 스캐너.
// 공개 bookTicker(인증 불필요) 배치 조회 → USDT 페어 교집합 크로스 스프레드 계산.
// 정보 표시 전용(실행/잔고 무관). 관리자가 minSpreadBps로 필터·정렬.
import { summarizeCoinWallet, type WalletInfo } from './wallet-info';
import { multiArbWalletStatusService } from '../multi-arb-wallet-status.service';

/** 거래소 최우선 호가 (USDT 페어) */
export interface ForeignTop {
  bid: number;
  ask: number;
}

export type ForeignExchange = 'binance' | 'mexc';

export interface ForeignSpread {
  symbol: string; // base (예: "BTC")
  buyExchange: ForeignExchange;
  sellExchange: ForeignExchange;
  buyPrice: number; // 매수 거래소 ask
  sellPrice: number; // 매도 거래소 bid
  spreadBps: number;
  binancePrice: number; // 참고: 바이낸스 mid(=(bid+ask)/2)
  mexcPrice: number; // 참고: MEXC mid
  buyWallet?: WalletInfo; // 매수 거래소 입출금 상태
  sellWallet?: WalletInfo; // 매도 거래소 입출금 상태
}

// 티커 충돌/이상치 컷 — 한쪽이 다른쪽의 5배 초과면 다른 자산 오매칭으로 간주(TROLL 27억% 류 차단)
const SANITY_RATIO = 5;

/**
 * 순수: 한 심볼의 바이낸스·MEXC 최우선호가 → 수익 방향 스프레드. 없거나 이상치면 null.
 */
export function computeForeignSpread(symbol: string, binance: ForeignTop, mexc: ForeignTop): ForeignSpread | null {
  if (binance.bid <= 0 || binance.ask <= 0 || mexc.bid <= 0 || mexc.ask <= 0) return null;

  // 이상치 가드: 두 거래소 mid가 5배 이상 벌어지면 티커 오매칭/불량데이터
  const bMid = (binance.bid + binance.ask) / 2;
  const mMid = (mexc.bid + mexc.ask) / 2;
  const hi = Math.max(bMid, mMid);
  const lo = Math.min(bMid, mMid);
  if (lo <= 0 || hi / lo > SANITY_RATIO) return null;

  // 방향 A: 바이낸스 매수(ask) → MEXC 매도(bid)
  const spreadA = mexc.bid / binance.ask - 1;
  // 방향 B: MEXC 매수(ask) → 바이낸스 매도(bid)
  const spreadB = binance.bid / mexc.ask - 1;

  let buyExchange: ForeignExchange, sellExchange: ForeignExchange, buyPrice: number, sellPrice: number, spread: number;
  if (spreadA >= spreadB) {
    buyExchange = 'binance'; sellExchange = 'mexc'; buyPrice = binance.ask; sellPrice = mexc.bid; spread = spreadA;
  } else {
    buyExchange = 'mexc'; sellExchange = 'binance'; buyPrice = mexc.ask; sellPrice = binance.bid; spread = spreadB;
  }
  if (spread <= 0) return null;

  return {
    symbol, buyExchange, sellExchange, buyPrice, sellPrice,
    spreadBps: Math.floor(spread * 10000),
    binancePrice: bMid, mexcPrice: mMid,
  };
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

/** 거래소별 전체 USDT 페어 최우선호가 (base 심볼 → ForeignTop). 공개 bookTicker 1콜. */
export async function fetchBookTickers(exchange: ForeignExchange): Promise<Map<string, ForeignTop>> {
  const out = new Map<string, ForeignTop>();
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
    out.set(base, { bid, ask });
  }
  return out;
}

/**
 * 바이낸스↔MEXC 공통 USDT 페어 스프레드 스캔. minSpreadBps 이상만, 큰 순 정렬.
 * @param limit 최대 반환 수 (기본 150)
 */
export async function scanForeignSpreads(minSpreadBps: number, limit = 150): Promise<ForeignSpread[]> {
  const [binance, mexc] = await Promise.all([fetchBookTickers('binance'), fetchBookTickers('mexc')]);
  const out: ForeignSpread[] = [];
  for (const [sym, b] of binance) {
    const m = mexc.get(sym);
    if (!m) continue;
    const sp = computeForeignSpread(sym, b, m);
    if (sp && sp.spreadBps >= minSpreadBps) out.push(sp);
  }
  out.sort((a, b) => b.spreadBps - a.spreadBps);
  const top = out.slice(0, limit);

  // 상위 후보에 입출금 상태 첨부 (큰 스프레드가 입출금 제한발인지 + 출금 수수료). 실패해도 스프레드는 반환.
  try {
    const wallets = await multiArbWalletStatusService.getAll();
    for (const s of top) {
      s.buyWallet = summarizeCoinWallet(wallets[s.buyExchange]?.get(s.symbol));
      s.sellWallet = summarizeCoinWallet(wallets[s.sellExchange]?.get(s.symbol));
    }
  } catch {
    // 무시 — 스프레드 데이터만 반환
  }
  return top;
}
