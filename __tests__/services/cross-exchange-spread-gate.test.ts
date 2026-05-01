import { isSpreadProfitable } from '../../src/services/cross-exchange-spread-gate';

describe('isSpreadProfitable', () => {
  test('UB direction profitable: upbitBid > bithumbAsk by >= minSpread', () => {
    const result = isSpreadProfitable(
      { upbitBid: 1410, upbitAsk: 1411, bithumbBid: 1399, bithumbAsk: 1400 },
      'UB',
      50,
    );
    // (1410/1400 - 1) * 10000 = 71.42... → floor = 71
    expect(result.ok).toBe(true);
    expect(result.spreadBps).toBe(71);
  });

  test('UB direction unprofitable: spread below minSpread', () => {
    const result = isSpreadProfitable(
      { upbitBid: 1402, upbitAsk: 1403, bithumbBid: 1399, bithumbAsk: 1400 },
      'UB',
      50,
    );
    // (1402/1400 - 1) * 10000 = 14.28... → floor = 14
    expect(result.ok).toBe(false);
    expect(result.spreadBps).toBe(14);
    expect(result.reason).toContain('spread 14 bps < min 50');
    expect(result.reason).toContain('UB');
  });

  test('UB direction edge: spread exactly meets minSpread (40 bps with 1004/1000)', () => {
    const result = isSpreadProfitable(
      { upbitBid: 1004, upbitAsk: 1005, bithumbBid: 999, bithumbAsk: 1000 },
      'UB',
      40,
    );
    // (1004/1000 - 1) * 10000 = 40 exactly → floor = 40
    expect(result.ok).toBe(true);
    expect(result.spreadBps).toBe(40);
  });

  test('BU direction profitable: bithumbBid > upbitAsk by >= minSpread', () => {
    const result = isSpreadProfitable(
      { upbitBid: 1399, upbitAsk: 1400, bithumbBid: 1410, bithumbAsk: 1411 },
      'BU',
      50,
    );
    // (1410/1400 - 1) * 10000 = 71.42... → floor = 71
    expect(result.ok).toBe(true);
    expect(result.spreadBps).toBe(71);
  });

  test('BU direction unprofitable: negative spread (bithumbBid < upbitAsk)', () => {
    const result = isSpreadProfitable(
      { upbitBid: 1399, upbitAsk: 1400, bithumbBid: 1390, bithumbAsk: 1391 },
      'BU',
      50,
    );
    // (1390/1400 - 1) * 10000 = -71.42... → floor = -72
    expect(result.ok).toBe(false);
    expect(result.spreadBps).toBe(-72);
    expect(result.reason).toContain('BU');
  });

  test('UB direction zero spread: ratio = 1 returns spreadBps 0', () => {
    const result = isSpreadProfitable(
      { upbitBid: 1400, upbitAsk: 1401, bithumbBid: 1399, bithumbAsk: 1400 },
      'UB',
      0,
    );
    // (1400/1400 - 1) * 10000 = 0 → floor = 0
    expect(result.ok).toBe(true);
    expect(result.spreadBps).toBe(0);
  });
});
