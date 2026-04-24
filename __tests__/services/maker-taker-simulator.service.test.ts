import {
  shouldFill,
  simulateTakerLeg,
  isAbort,
  PendingMakerOrder,
} from '../../src/services/maker-taker-simulator.service';
import type { OrderbookTop } from '../../src/services/upbit-price-manager';

function mkBook(market: string, bid: number, ask: number, size = 100): OrderbookTop {
  return {
    market,
    bid: { price: bid, size },
    ask: { price: ask, size },
    timestamp: Date.now(),
  };
}

describe('shouldFill', () => {
  const order: PendingMakerOrder = {
    makerOrderPrice: 1482,
    createdAt: new Date('2026-04-24T00:00:00Z'),
    maxPendingMs: 3_600_000,
  };

  it('best bid가 지정가 이하로 내려오면 fill (bid=1481)', () => {
    const book = mkBook('KRW-USDS', 1481, 1484);
    const now = new Date('2026-04-24T00:10:00Z');
    expect(shouldFill(order, book, now)).toBe('fill');
  });

  it('best bid와 지정가가 같으면 fill (경계 포함)', () => {
    const book = mkBook('KRW-USDS', 1482, 1484);
    const now = new Date('2026-04-24T00:10:00Z');
    expect(shouldFill(order, book, now)).toBe('fill');
  });

  it('best bid가 지정가보다 높으면 wait (bid=1486)', () => {
    const book = mkBook('KRW-USDS', 1486, 1487);
    const now = new Date('2026-04-24T00:10:00Z');
    expect(shouldFill(order, book, now)).toBe('wait');
  });

  it('maxPendingMs 초과 시 bid가 낮아도 expire 우선', () => {
    const book = mkBook('KRW-USDS', 1481, 1484);
    const now = new Date('2026-04-24T02:00:00Z'); // 2시간 경과 > 1시간
    expect(shouldFill(order, book, now)).toBe('expire');
  });
});

describe('simulateTakerLeg', () => {
  it('정상 이익: USDS 1482 매수 → USDT 1487 매도 (수수료 0.05%)', () => {
    const result = simulateTakerLeg({
      makerFilledPrice: 1482,
      takerOrderbook: mkBook('KRW-USDT', 1487, 1488),
      quantity: 10,
      feeBpsMaker: 5,
      feeBpsTaker: 5,
    });
    expect(isAbort(result)).toBe(false);
    if (isAbort(result)) return;
    // gross = (1487 - 1482) * 10 = 50
    // makerFee = 1482 * 10 * 5/10000 = 7.41
    // takerFee = 1487 * 10 * 5/10000 = 7.435
    // net = 50 - 14.845 = 35.155
    expect(result.grossProfitKrw).toBeCloseTo(50, 4);
    expect(result.feeKrw).toBeCloseTo(14.845, 4);
    expect(result.netProfitKrw).toBeCloseTo(35.155, 4);
    // realizedSpreadBps = floor((5 / 1482) * 10000) = floor(33.738) = 33
    expect(result.realizedSpreadBps).toBe(33);
  });

  it('손실: taker bid가 maker 체결가보다 낮으면 net 음수', () => {
    const result = simulateTakerLeg({
      makerFilledPrice: 1490,
      takerOrderbook: mkBook('KRW-USDT', 1485, 1486),
      quantity: 10,
      feeBpsMaker: 5,
      feeBpsTaker: 5,
    });
    expect(isAbort(result)).toBe(false);
    if (isAbort(result)) return;
    expect(result.grossProfitKrw).toBeCloseTo(-50, 4);
    expect(result.netProfitKrw).toBeLessThan(0);
    expect(result.realizedSpreadBps).toBeLessThan(0);
  });

  it('abort: taker bid < minTakerBidKrw', () => {
    const result = simulateTakerLeg({
      makerFilledPrice: 1482,
      takerOrderbook: mkBook('KRW-USDT', 1480, 1481),
      quantity: 10,
      feeBpsMaker: 5,
      feeBpsTaker: 5,
      minTakerBidKrw: 1485,
    });
    expect(isAbort(result)).toBe(true);
    if (!isAbort(result)) return;
    expect(result.reason).toContain('1480');
    expect(result.reason).toContain('1485');
  });

  it('minTakerBidKrw 경계 통과: taker bid == minTakerBidKrw는 체결', () => {
    const result = simulateTakerLeg({
      makerFilledPrice: 1482,
      takerOrderbook: mkBook('KRW-USDT', 1485, 1486),
      quantity: 10,
      feeBpsMaker: 5,
      feeBpsTaker: 5,
      minTakerBidKrw: 1485,
    });
    expect(isAbort(result)).toBe(false);
  });
});
