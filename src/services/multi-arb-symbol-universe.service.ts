// 거래소별 상장 목록 → 통화권별 공통 심볼 교집합 (spec §4 SymbolUniverse, §5 step 1)
// 상장 목록은 자주 변하지 않으므로 1시간 캐시 (spec §9)
import axios from 'axios';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1시간
const HTTP_TIMEOUT_MS = 10000;

export interface UniverseSets {
  upbit: Set<string>;
  bithumb: Set<string>;
  binance: Set<string>;
  mexc: Set<string>;
  gateio: Set<string>;
}

export interface SymbolUniverseResult {
  krw: string[];   // 업비트 ∩ 빗썸 (KRW 마켓)
  usdt: string[];  // 바이낸스/MEXC/Gate.io 중 2곳 이상 상장 (USDT 마켓)
}

// 순수함수 — 단위테스트 대상
export function computeUniverse(sets: UniverseSets): SymbolUniverseResult {
  const krw = [...sets.upbit].filter(s => sets.bithumb.has(s)).sort();

  // USDT권: 최저매수↔최고매도 "쌍"이 성립하려면 통화권 내 2곳 이상 상장 필요
  const counts = new Map<string, number>();
  for (const ex of ['binance', 'mexc', 'gateio'] as const) {
    for (const s of sets[ex]) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const usdt = [...counts.entries()].filter(([, c]) => c >= 2).map(([s]) => s).sort();

  return { krw, usdt };
}

class MultiArbSymbolUniverseService {
  private cache: { at: number; universe: SymbolUniverseResult } | null = null;

  async getUniverse(): Promise<SymbolUniverseResult> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.universe;

    const [upbit, bithumb, binance, mexc, gateio] = await Promise.all([
      this.fetchUpbitKrwSymbols(),
      this.fetchBithumbKrwSymbols(),
      this.fetchBinanceUsdtSymbols(),
      this.fetchMexcUsdtSymbols(),
      this.fetchGateioUsdtSymbols(),
    ]);

    const universe = computeUniverse({ upbit, bithumb, binance, mexc, gateio });
    this.cache = { at: Date.now(), universe };
    console.log(`[MultiArbSymbolUniverse] 갱신: KRW권 ${universe.krw.length}개, USDT권 ${universe.usdt.length}개`);
    return universe;
  }

  private async fetchUpbitKrwSymbols(): Promise<Set<string>> {
    const res = await axios.get('https://api.upbit.com/v1/market/all?is_details=false', { timeout: HTTP_TIMEOUT_MS });
    return new Set(
      (res.data ?? [])
        .map((m: any) => String(m.market ?? ''))
        .filter((m: string) => m.startsWith('KRW-'))
        .map((m: string) => m.slice(4).toUpperCase()),
    );
  }

  private async fetchBithumbKrwSymbols(): Promise<Set<string>> {
    const res = await axios.get('https://api.bithumb.com/public/ticker/ALL_KRW', { timeout: HTTP_TIMEOUT_MS });
    if (res.data?.status !== '0000') throw new Error(`Bithumb ALL_KRW 응답 오류: status=${res.data?.status}`);
    return new Set(Object.keys(res.data.data ?? {}).filter(k => k !== 'date').map(k => k.toUpperCase()));
  }

  private async fetchBinanceUsdtSymbols(): Promise<Set<string>> {
    const res = await axios.get('https://api.binance.com/api/v3/ticker/price', { timeout: HTTP_TIMEOUT_MS });
    return this.usdtBases(res.data, 'symbol', 'USDT');
  }

  private async fetchMexcUsdtSymbols(): Promise<Set<string>> {
    const res = await axios.get('https://api.mexc.com/api/v3/ticker/price', { timeout: HTTP_TIMEOUT_MS });
    return this.usdtBases(res.data, 'symbol', 'USDT');
  }

  private async fetchGateioUsdtSymbols(): Promise<Set<string>> {
    const res = await axios.get('https://api.gateio.ws/api/v4/spot/tickers', { timeout: HTTP_TIMEOUT_MS });
    return this.usdtBases(res.data, 'currency_pair', '_USDT');
  }

  private usdtBases(rows: any[], field: string, suffix: string): Set<string> {
    return new Set(
      (rows ?? [])
        .map((r: any) => String(r[field] ?? ''))
        .filter((s: string) => s.endsWith(suffix))
        .map((s: string) => s.slice(0, -suffix.length).toUpperCase()),
    );
  }
}

export const multiArbSymbolUniverseService = new MultiArbSymbolUniverseService();
