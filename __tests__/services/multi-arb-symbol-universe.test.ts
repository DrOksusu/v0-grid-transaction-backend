// 통화권별 공통 상장 교집합 계산 테스트 (순수함수)
import { computeUniverse, UniverseSets } from '../../src/services/multi-arb-symbol-universe.service';

function sets(partial: Partial<Record<keyof UniverseSets, string[]>>): UniverseSets {
  return {
    upbit: new Set(partial.upbit ?? []),
    bithumb: new Set(partial.bithumb ?? []),
    binance: new Set(partial.binance ?? []),
    mexc: new Set(partial.mexc ?? []),
    gateio: new Set(partial.gateio ?? []),
  };
}

describe('computeUniverse', () => {
  it('KRW권 = 업비트 ∩ 빗썸', () => {
    const u = computeUniverse(sets({
      upbit: ['BTC', 'LSK', 'WLD'],
      bithumb: ['BTC', 'LSK', 'DOGE'],
    }));
    expect(u.krw).toEqual(['BTC', 'LSK']);
  });

  it('USDT권 = 바이낸스/MEXC/Gate.io 중 2곳 이상 상장 (쌍이 성립해야 비교 가능)', () => {
    const u = computeUniverse(sets({
      binance: ['BTC', 'ETH'],
      mexc: ['BTC', 'PEPE'],
      gateio: ['ETH', 'PEPE', 'RARE'],
    }));
    // BTC: binance+mexc / ETH: binance+gateio / PEPE: mexc+gateio → 포함. RARE: gateio 단독 → 제외
    expect(u.usdt).toEqual(['BTC', 'ETH', 'PEPE']);
  });

  it('한쪽 통화권이 비어도 다른 통화권은 계산된다', () => {
    const u = computeUniverse(sets({ upbit: ['BTC'], bithumb: ['BTC'] }));
    expect(u.krw).toEqual(['BTC']);
    expect(u.usdt).toEqual([]);
  });
});
