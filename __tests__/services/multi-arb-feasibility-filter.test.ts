// 실현가능성 3단 필터 테스트 (spec §6)
// ★ LSK 회귀 테스트: 2026-09-13 실사례 — 업비트 LISK 자체망 ↔ 빗썸 ETH망, 괴리 142%인데 전송 불가
import { evaluateFeasibility } from '../../src/services/multi-arb-feasibility-filter';
import { parseUpbitWalletStatus, parseBithumbWalletStatus } from '../../src/services/multi-arb-wallet-status.service';
import { MultiArbExchange, SpreadCandidate, WalletStatusMap } from '../../src/services/multi-arb-types';

function candidate(partial: Partial<SpreadCandidate> = {}): SpreadCandidate {
  const buyPrice = partial.buyPrice ?? 533;
  const sellPrice = partial.sellPrice ?? 1322;
  return {
    symbol: 'LSK',
    currencyZone: 'KRW',
    buyExchange: 'upbit',
    buyPrice,
    askPrice: buyPrice,
    sellExchange: 'bithumb',
    sellPrice,
    bidPrice: sellPrice,
    spreadPct: 148.03,
    ...partial,
  };
}

function wallets(partial: Partial<Record<MultiArbExchange, Record<string, Array<{ network: string; depositEnabled: boolean; withdrawEnabled: boolean }>>>>): Partial<Record<MultiArbExchange, WalletStatusMap>> {
  const out: Partial<Record<MultiArbExchange, WalletStatusMap>> = {};
  for (const [ex, coins] of Object.entries(partial)) {
    out[ex as MultiArbExchange] = new Map(Object.entries(coins!));
  }
  return out;
}

describe('evaluateFeasibility', () => {
  it('★ LSK 회귀: 업비트 LISK(LSK)망 ↔ 빗썸 ETH망 → network_mismatch (spec §1 실사례)', () => {
    const result = evaluateFeasibility(candidate(), wallets({
      upbit: { LSK: [{ network: 'LSK', depositEnabled: true, withdrawEnabled: true }] },
      bithumb: { LSK: [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }] },
    }));
    expect(result.feasibility).toBe('network_mismatch');
    expect(result.networkMatch).toBe(false);
    expect(result.matchedNetwork).toBeNull();
    expect(result.note).toContain('네트워크 불일치');
    expect(result.note).toContain('LSK');
    expect(result.note).toContain('ETH');
  });

  it('1단 통과 + 2단 통과: 양쪽 ETH망 + 매수측 출금가능 + 매도측 입금가능 → feasible', () => {
    const result = evaluateFeasibility(candidate({ symbol: 'WLD' }), wallets({
      upbit: { WLD: [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }] },
      bithumb: { WLD: [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }] },
    }));
    expect(result.feasibility).toBe('feasible');
    expect(result.networkMatch).toBe(true);
    expect(result.matchedNetwork).toBe('ETH');
  });

  it('멀티체인: 교집합 중 하나라도 (매수 출금 ∧ 매도 입금) 가능하면 feasible', () => {
    const result = evaluateFeasibility(candidate({ symbol: 'USDT' }), wallets({
      upbit: {
        USDT: [
          { network: 'TRX', depositEnabled: true, withdrawEnabled: false }, // TRX 출금 불가
          { network: 'ETH', depositEnabled: true, withdrawEnabled: true },
        ],
      },
      bithumb: {
        USDT: [
          { network: 'TRX', depositEnabled: true, withdrawEnabled: true },
          { network: 'ETH', depositEnabled: true, withdrawEnabled: true },
        ],
      },
    }));
    expect(result.feasibility).toBe('feasible');
    expect(result.matchedNetwork).toBe('ETH');
  });

  it('2단 실패: 네트워크는 일치하지만 매수측 출금 중단 → deposit_halt', () => {
    const result = evaluateFeasibility(candidate({ symbol: 'DOGE' }), wallets({
      upbit: { DOGE: [{ network: 'DOGE', depositEnabled: true, withdrawEnabled: false }] },
      bithumb: { DOGE: [{ network: 'DOGE', depositEnabled: true, withdrawEnabled: true }] },
    }));
    expect(result.feasibility).toBe('deposit_halt');
    expect(result.networkMatch).toBe(true);
    expect(result.note).toContain('입출금');
  });

  it('2단 실패: 매도측 입금 중단 → deposit_halt', () => {
    const result = evaluateFeasibility(candidate({ symbol: 'DOGE' }), wallets({
      upbit: { DOGE: [{ network: 'DOGE', depositEnabled: true, withdrawEnabled: true }] },
      bithumb: { DOGE: [{ network: 'DOGE', depositEnabled: false, withdrawEnabled: true }] },
    }));
    expect(result.feasibility).toBe('deposit_halt');
  });

  it('지갑 정보 없는 거래소가 있으면 unverified (조회 실패 사이클 — spec §9)', () => {
    const result = evaluateFeasibility(candidate(), wallets({
      upbit: { LSK: [{ network: 'LSK', depositEnabled: true, withdrawEnabled: true }] },
      // bithumb 지갑 조회 실패 → 키 없음
    }));
    expect(result.feasibility).toBe('unverified');
    expect(result.networkMatch).toBeNull();
  });

  it('거래소 맵은 있지만 해당 코인 항목이 없으면 unverified', () => {
    const result = evaluateFeasibility(candidate(), wallets({
      upbit: { LSK: [{ network: 'LSK', depositEnabled: true, withdrawEnabled: true }] },
      bithumb: {}, // LSK 항목 없음
    }));
    expect(result.feasibility).toBe('unverified');
  });

  it('deposit_halt / network_mismatch / unverified는 matchedNetwork가 null (types 계약)', () => {
    // network_mismatch
    expect(evaluateFeasibility(candidate(), wallets({
      upbit: { LSK: [{ network: 'LSK', depositEnabled: true, withdrawEnabled: true }] },
      bithumb: { LSK: [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }] },
    })).matchedNetwork).toBeNull();
    // deposit_halt (교집합 있으나 전송 불가) — 전송 불가한 네트워크명이 실리면 안 됨
    expect(evaluateFeasibility(candidate({ symbol: 'DOGE' }), wallets({
      upbit: { DOGE: [{ network: 'DOGE', depositEnabled: true, withdrawEnabled: false }] },
      bithumb: { DOGE: [{ network: 'DOGE', depositEnabled: true, withdrawEnabled: true }] },
    })).matchedNetwork).toBeNull();
    // unverified
    expect(evaluateFeasibility(candidate(), wallets({
      upbit: { LSK: [{ network: 'LSK', depositEnabled: true, withdrawEnabled: true }] },
    })).matchedNetwork).toBeNull();
  });

  it('매도측이 같은 정규화 네트워크명 행을 2개 반환하면 입출금 플래그를 OR 병합 (별칭 통합 후)', () => {
    // 빗썸이 USDT ETH망을 두 행으로: 하나는 입금불가, 하나는 입금가능 → OR로 입금가능 → feasible
    const result = evaluateFeasibility(candidate({ symbol: 'USDT' }), wallets({
      upbit: { USDT: [{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }] },
      bithumb: {
        USDT: [
          { network: 'ETH', depositEnabled: false, withdrawEnabled: true },  // last-wins였다면 deposit_halt로 오판
          { network: 'ETH', depositEnabled: true, withdrawEnabled: true },
        ],
      },
    }));
    expect(result.feasibility).toBe('feasible');
    expect(result.matchedNetwork).toBe('ETH');
  });

  // ── parse→filter 통합 (레이어 간 계약 드리프트 방지) ─────────────────────────
  it('★ 통합: parseUpbit(LISK망) + parseBithumb(ETH망) raw → evaluateFeasibility → network_mismatch (LSK 실사례)', () => {
    // 업비트/빗썸 GET /v1/status/wallet 원시 응답 형태 (net_type + wallet_state)
    const upbitRaw = [{ currency: 'LSK', net_type: 'LISK', wallet_state: 'working' }];   // LISK → LSK 정규화
    const bithumbRaw = [{ currency: 'LSK', net_type: 'ETH', wallet_state: 'working' }];

    const upbitMap = parseUpbitWalletStatus(upbitRaw);
    const bithumbMap = parseBithumbWalletStatus(bithumbRaw);

    const result = evaluateFeasibility(candidate(), { upbit: upbitMap, bithumb: bithumbMap });
    expect(result.feasibility).toBe('network_mismatch');
    expect(result.networkMatch).toBe(false);
    expect(result.matchedNetwork).toBeNull();
    expect(result.note).toContain('LSK');   // 업비트 LISK → 정규화 LSK
    expect(result.note).toContain('ETH');   // 빗썸 ETH
  });
});
