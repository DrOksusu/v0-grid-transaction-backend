import { BalanceCache } from '../../src/services/upbit-balance-cache';

describe('BalanceCache', () => {
  it('첫 호출은 fetcher 호출, 두번째 호출은 캐시 반환', async () => {
    const fetcher = jest.fn().mockResolvedValue([
      { currency: 'USDT', balance: '10', locked: '0' },
    ]);
    const cache = new BalanceCache({ ttlMs: 5000, fetcher });

    const r1 = await cache.get();
    const r2 = await cache.get();

    expect(r1).toEqual({ USDT: 10 });
    expect(r2).toEqual({ USDT: 10 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('TTL 경과 후 fetcher 재호출', async () => {
    const fetcher = jest.fn().mockResolvedValue([
      { currency: 'USDT', balance: '5', locked: '0' },
    ]);
    const cache = new BalanceCache({ ttlMs: 5000, fetcher });

    jest.useFakeTimers();
    await cache.get();
    jest.advanceTimersByTime(5001);
    await cache.get();
    jest.useRealTimers();

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('invalidate 호출 시 즉시 만료', async () => {
    const fetcher = jest.fn().mockResolvedValue([
      { currency: 'USDT', balance: '5', locked: '0' },
    ]);
    const cache = new BalanceCache({ ttlMs: 5000, fetcher });

    await cache.get();
    cache.invalidate();
    await cache.get();

    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
