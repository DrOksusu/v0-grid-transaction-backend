// 해외 거래소(바이낸스↔MEXC) 재고-무관 스프레드 스캐너.
// 공개 bookTicker(인증 불필요) 배치 조회 → USDT 페어 교집합 크로스 스프레드 계산.
// 정보 표시 전용(실행/잔고 무관). 관리자가 minSpreadBps로 필터·정렬.
import { summarizeCoinWallet, type WalletInfo } from './wallet-info';
import { multiArbWalletStatusService } from '../multi-arb-wallet-status.service';

/** 거래소 최우선 호가 (USDT 페어) — 수량은 해당 호가에 걸린 물량(top-of-book) */
export interface ForeignTop {
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
}

export type ForeignExchange = 'binance' | 'mexc';

export interface ForeignSpread {
  symbol: string; // base (예: "BTC")
  buyExchange: ForeignExchange;
  sellExchange: ForeignExchange;
  buyPrice: number; // 매수 거래소 ask
  sellPrice: number; // 매도 거래소 bid
  maxExecutableQty: number; // 최우선호가 기준 최대 체결량 = min(매수측 ask물량, 매도측 bid물량)
  maxExecutableUsdt: number; // 위 수량 × 매수가 (≈ 최우선호가 1레벨에서 소화 가능한 규모)
  spreadBps: number;
  binancePrice: number; // 참고: 바이낸스 mid(=(bid+ask)/2)
  mexcPrice: number; // 참고: MEXC mid
  netSpreadBps: number; // spreadBps − 왕복 수수료 추정(20bps)
  realizable: boolean; // 이 시스템에서 실제 실행 가능한가 (해외는 항상 false = 관찰 전용)
  realizabilityReason: string; // 관찰 전용 사유 (입출금 동결 등)
  buyWallet?: WalletInfo; // 매수 거래소 입출금 상태
  sellWallet?: WalletInfo; // 매도 거래소 입출금 상태
}

// 바이낸스+MEXC 왕복 taker 수수료 추정 (10+10 bps)
const FOREIGN_ROUNDTRIP_FEE_BPS = 20;

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
  let buyQty: number, sellQty: number;
  if (spreadA >= spreadB) {
    // 바이낸스 매수(ask) → MEXC 매도(bid): 매수측 물량=바이낸스 ask, 매도측 물량=MEXC bid
    buyExchange = 'binance'; sellExchange = 'mexc'; buyPrice = binance.ask; sellPrice = mexc.bid; spread = spreadA;
    buyQty = binance.askQty; sellQty = mexc.bidQty;
  } else {
    // MEXC 매수(ask) → 바이낸스 매도(bid)
    buyExchange = 'mexc'; sellExchange = 'binance'; buyPrice = mexc.ask; sellPrice = binance.bid; spread = spreadB;
    buyQty = mexc.askQty; sellQty = binance.bidQty;
  }
  if (spread <= 0) return null;

  // 최우선호가 기준 최대 체결량 = 양측 물량 중 작은 쪽(더 깊이 들어가면 스프레드가 줄어듦)
  const maxExecutableQty = Math.min(buyQty, sellQty);
  const maxExecutableUsdt = maxExecutableQty * buyPrice;

  const spreadBps = Math.floor(spread * 10000);
  return {
    symbol, buyExchange, sellExchange, buyPrice, sellPrice,
    maxExecutableQty, maxExecutableUsdt,
    spreadBps,
    netSpreadBps: spreadBps - FOREIGN_ROUNDTRIP_FEE_BPS,
    realizable: false, // 해외는 이 시스템에서 실행 미지원 — 관찰 전용
    realizabilityReason: '관찰 전용 (해외 거래소 실행·재고 미지원)',
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
    const bidQty = Number(t.bidQty), askQty = Number(t.askQty);
    out.set(base, { bid, ask, bidQty: bidQty > 0 ? bidQty : 0, askQty: askQty > 0 ? askQty : 0 });
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
