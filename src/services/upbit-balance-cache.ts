/**
 * Upbit 잔고 캐시 — rate limit 방지 + 거래 직후 invalidate.
 *
 * Upbit getAccounts() 응답 형식:
 *   [{ currency: 'USDT', balance: '10.5', locked: '0' }, ...]
 *
 * 캐시는 { [currency]: number } 형태로 변환 (locked 제외, available만).
 */

interface AccountRow {
  currency: string;
  balance: string;
  locked: string;
}

export class BalanceCache {
  private ttlMs: number;
  private fetcher: () => Promise<AccountRow[]>;
  private cached: Record<string, number> | null = null;
  private cachedAt = 0;

  constructor(opts: { ttlMs: number; fetcher: () => Promise<AccountRow[]> }) {
    this.ttlMs = opts.ttlMs;
    this.fetcher = opts.fetcher;
  }

  async get(): Promise<Record<string, number>> {
    if (this.cached && Date.now() - this.cachedAt < this.ttlMs) {
      return this.cached;
    }
    const rows = await this.fetcher();
    const map: Record<string, number> = {};
    for (const row of rows) {
      map[row.currency] = parseFloat(row.balance);
    }
    this.cached = map;
    this.cachedAt = Date.now();
    return map;
  }

  invalidate(): void {
    this.cached = null;
    this.cachedAt = 0;
  }
}
