// 가격 sanity check 단위테스트 (Task 12: 티커 충돌/이상치 방어)
// 배경: 스모크에서 TROLL 27억% / ARC 6,545% / XEM 2,950% 같은 가짜 괴리 발견
// 원인 = 같은 티커가 거래소마다 다른 코인(티커 충돌) 또는 시세 단위 파싱 차이
import { checkPriceSanity } from '../../src/services/multi-arb-price-sanity';
import { PriceMap, SpreadCandidate } from '../../src/services/multi-arb-types';

function priceMap(entries: Record<string, number>): PriceMap {
  return new Map(Object.entries(entries));
}

function candidate(overrides: Partial<SpreadCandidate>): SpreadCandidate {
  return {
    symbol: 'WLD',
    currencyZone: 'USDT',
    buyExchange: 'mexc',
    buyPrice: 1,
    sellExchange: 'gateio',
    sellPrice: 1.03,
    spreadPct: 3,
    ...overrides,
  };
}

describe('checkPriceSanity — 기준가(바이낸스 USDT) 대비 상식 범위 검사', () => {
  it('(a) TROLL류 티커 충돌: 매수가가 기준가 대비 수천분의 1이면 이상치로 제외한다', () => {
    // 실측: TROLL MEXC 1.6e-9 vs Gate 0.046 (서로 다른 코인) — 기준가 0.046 가정
    const c = candidate({
      symbol: 'TROLL',
      buyExchange: 'mexc',
      buyPrice: 1.6e-9,
      sellExchange: 'gateio',
      sellPrice: 0.046,
      spreadPct: ((0.046 - 1.6e-9) / 1.6e-9) * 100, // ≈ 28억%
    });
    const result = checkPriceSanity(c, priceMap({ TROLL: 0.046 }), null);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('mexc'); // 어느 쪽이 이상인지 로깅 가능해야 함
  });

  it('기준가 대비 수천배(상한 초과)도 이상치로 제외한다', () => {
    const c = candidate({
      symbol: 'XEM',
      buyPrice: 0.02,
      sellPrice: 61, // 기준 0.02 대비 3,050배
      spreadPct: 304900,
    });
    const result = checkPriceSanity(c, priceMap({ XEM: 0.02 }), null);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('gateio');
  });

  it('(b) 정상 후보: 기준가 대비 1.03x, 스프레드 3%는 통과한다', () => {
    const c = candidate({ buyPrice: 100, sellPrice: 103, spreadPct: 3 });
    const result = checkPriceSanity(c, priceMap({ WLD: 100 }), null);
    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
  });

  it('진짜 기회 보존: 기준가 대비 1.4x(스프레드 40%)도 통과한다 — 범위를 과도하게 좁히지 않는다', () => {
    const c = candidate({ buyPrice: 100, sellPrice: 140, spreadPct: 40 });
    const result = checkPriceSanity(c, priceMap({ WLD: 100 }), null);
    expect(result.ok).toBe(true);
  });

  it('KRW권: 기준가 × 환율로 원화 환산해 비교한다 (김프 수준 괴리는 통과)', () => {
    // 기준 3.1 USDT × 1385 = 4,293.5 KRW — 국내 4,200/4,340은 0.98x/1.01x
    const c = candidate({
      currencyZone: 'KRW',
      buyExchange: 'bithumb',
      buyPrice: 4200,
      sellExchange: 'upbit',
      sellPrice: 4340,
      spreadPct: 3.33,
    });
    expect(checkPriceSanity(c, priceMap({ WLD: 3.1 }), 1385).ok).toBe(true);
  });

  it('KRW권 이상치: 환산 기준가 대비 수십배면 제외한다', () => {
    // 기준 0.02 USDT × 1385 = 27.7 KRW인데 국내가 850 KRW (30.7x) → 티커 충돌 의심
    const c = candidate({
      currencyZone: 'KRW',
      buyExchange: 'bithumb',
      buyPrice: 28,
      sellExchange: 'upbit',
      sellPrice: 850,
      spreadPct: 2935,
    });
    const result = checkPriceSanity(c, priceMap({ WLD: 0.02 }), 1385);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('upbit');
  });

  it('KRW권인데 환율이 없으면 기준가 환산 불가 → 폴백(스프레드 상한) 검사로 전환한다', () => {
    const huge = candidate({
      currencyZone: 'KRW',
      buyPrice: 28,
      sellPrice: 850,
      spreadPct: 2935,
    });
    expect(checkPriceSanity(huge, priceMap({ WLD: 0.02 }), null).ok).toBe(false);

    const normal = candidate({
      currencyZone: 'KRW',
      buyPrice: 4200,
      sellPrice: 4340,
      spreadPct: 3.33,
    });
    expect(checkPriceSanity(normal, priceMap({ WLD: 0.02 }), null).ok).toBe(true);
  });
});

describe('checkPriceSanity — 기준가 없음 폴백 (스프레드 상한)', () => {
  it('(c) 바이낸스에 없는 코인 + 스프레드 6,545%는 폴백으로 제외한다', () => {
    const c = candidate({ symbol: 'ARC', buyPrice: 0.001, sellPrice: 0.06645, spreadPct: 6545 });
    const result = checkPriceSanity(c, priceMap({}), null);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('기준가 없음');
  });

  it('(d) 바이낸스에 없는 코인 + 정상 스프레드(3%)는 통과한다', () => {
    const c = candidate({ symbol: 'ARC', buyPrice: 100, sellPrice: 103, spreadPct: 3 });
    const result = checkPriceSanity(c, priceMap({}), null);
    expect(result.ok).toBe(true);
  });

  it('바이낸스 시세 자체가 조회 실패(undefined)여도 폴백으로 동작한다', () => {
    const c = candidate({ spreadPct: 6545, buyPrice: 0.001, sellPrice: 0.06645 });
    expect(checkPriceSanity(c, undefined, null).ok).toBe(false);
    expect(checkPriceSanity(candidate({ spreadPct: 3 }), undefined, null).ok).toBe(true);
  });
});
