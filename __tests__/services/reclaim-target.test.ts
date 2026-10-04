import { selectReclaimTargets, MAJOR_SYMBOLS } from '../../src/services/reclaim/target-selector';

describe('selectReclaimTargets', () => {
  const holdings = { BORA: 1000, HBAR: 500, FOO: 10 }; // 빗썸 보유
  const upbitMarkets = new Set(['BORA', 'HBAR']);       // 업비트 공통상장 (FOO 미상장)
  const withdrawFeePct = { BORA: 1.0, HBAR: 0.001 };    // 출금수수료율(%)
  const eligibleSymbols = new Set(['BORA', 'HBAR', 'FOO', 'BTC', 'ETH']); // 재고형 아비로 빗썸 매수된 코인(테스트 전부 허용)

  it('업비트 공통상장 + 출금수수료율 > 임계인 코인만', () => {
    // 임계 0.3%: BORA(1.0%) 통과, HBAR(0.001%) 제외(전송이 쌈), FOO 제외(업비트 미상장)
    const r = selectReclaimTargets({ holdings, upbitMarkets, withdrawFeePct, thresholdPct: 0.3, excludeMajors: true, eligibleSymbols });
    expect(r).toEqual(['BORA']);
  });

  it('출금수수료율 미확인(undefined) 코인은 보수적으로 포함(전송 대안 불명 → 되돌림 후보)', () => {
    const r = selectReclaimTargets({ holdings: { BORA: 1 }, upbitMarkets: new Set(['BORA']), withdrawFeePct: {}, thresholdPct: 0.3, excludeMajors: true, eligibleSymbols });
    expect(r).toEqual(['BORA']);
  });

  it('보유량 0은 제외', () => {
    const r = selectReclaimTargets({ holdings: { BORA: 0 }, upbitMarkets: new Set(['BORA']), withdrawFeePct: { BORA: 1 }, thresholdPct: 0.3, excludeMajors: true, eligibleSymbols });
    expect(r).toEqual([]);
  });

  it('excludeMajors=true면 대형코인(BTC/ETH 등) 제외', () => {
    const h = { BTC: 1, ETH: 5, BORA: 1000 };
    const m = new Set(['BTC', 'ETH', 'BORA']);
    const fee = { BTC: 1, ETH: 1, BORA: 1 };
    const r = selectReclaimTargets({ holdings: h, upbitMarkets: m, withdrawFeePct: fee, thresholdPct: 0.3, excludeMajors: true, eligibleSymbols });
    expect(r).toEqual(['BORA']); // BTC/ETH 제외
  });

  it('excludeMajors=false면 대형코인도 대상에 포함', () => {
    const h = { BTC: 1, BORA: 1000 };
    const m = new Set(['BTC', 'BORA']);
    const fee = { BTC: 1, BORA: 1 };
    const r = selectReclaimTargets({ holdings: h, upbitMarkets: m, withdrawFeePct: fee, thresholdPct: 0.3, excludeMajors: false, eligibleSymbols });
    expect(r.sort()).toEqual(['BORA', 'BTC']);
  });

  it('재고형 아비 매수 이력 없는 코인은 제외 (eligibleSymbols에 없으면 대상 아님)', () => {
    const h = { BORA: 1000, PEPE: 5000 }; // 둘 다 보유·상장·비대형·수수료 미확인(통과)
    const m = new Set(['BORA', 'PEPE']);
    // BORA만 재고형 아비로 빗썸 매수된 이력 있음 → PEPE는 제외
    const r = selectReclaimTargets({ holdings: h, upbitMarkets: m, withdrawFeePct: {}, thresholdPct: 0.3, excludeMajors: true, eligibleSymbols: new Set(['BORA']) });
    expect(r).toEqual(['BORA']);
  });

  it('eligibleSymbols가 비어 있으면 대상 없음', () => {
    const r = selectReclaimTargets({ holdings: { BORA: 1000 }, upbitMarkets: new Set(['BORA']), withdrawFeePct: {}, thresholdPct: 0.3, excludeMajors: true, eligibleSymbols: new Set() });
    expect(r).toEqual([]);
  });

  it('MAJOR_SYMBOLS에 대표 대형코인이 들어있다', () => {
    expect(MAJOR_SYMBOLS.has('BTC')).toBe(true);
    expect(MAJOR_SYMBOLS.has('ETH')).toBe(true);
    expect(MAJOR_SYMBOLS.has('BORA')).toBe(false);
  });
});
