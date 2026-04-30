import { isSpreadProfitable } from '../../src/services/maker-taker-spread-gate';
import type { OrderbookTop } from '../../src/services/upbit-price-manager';

const mkBook = (bid: number, ask: number): OrderbookTop => ({
  market: 'KRW-USDS',
  bid: { price: bid, size: 1000 },
  ask: { price: ask, size: 1000 },
  timestamp: 0,
});

describe('isSpreadProfitable', () => {
  it('spread < minSpreadKrw → ok=false, reason 포함', () => {
    const r = isSpreadProfitable(mkBook(1490, 1495), 12);
    expect(r.ok).toBe(false);
    expect(r.spreadKrw).toBe(5);
    expect(r.reason).toContain('spread');
  });

  it('spread === minSpreadKrw → ok=true (경계값 포함)', () => {
    const r = isSpreadProfitable(mkBook(1490, 1502), 12);
    expect(r.ok).toBe(true);
    expect(r.spreadKrw).toBe(12);
  });

  it('spread > minSpreadKrw → ok=true', () => {
    const r = isSpreadProfitable(mkBook(1490, 1510), 12);
    expect(r.ok).toBe(true);
    expect(r.spreadKrw).toBe(20);
  });

  it('minSpreadKrw === 0 → 항상 ok=true (게이팅 비활성)', () => {
    const r = isSpreadProfitable(mkBook(1490, 1490), 0);
    expect(r.ok).toBe(true);
    expect(r.spreadKrw).toBe(0);
  });

  it('비정상: ask < bid 입력 → spread 음수, ok=false', () => {
    const r = isSpreadProfitable(mkBook(1500, 1490), 12);
    expect(r.ok).toBe(false);
    expect(r.spreadKrw).toBe(-10);
  });
});
