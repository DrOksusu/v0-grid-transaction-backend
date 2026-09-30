import { selectReclaimTargets } from '../../src/services/reclaim/target-selector';

describe('selectReclaimTargets', () => {
  const holdings = { BORA: 1000, HBAR: 500, FOO: 10 }; // 빗썸 보유
  const upbitMarkets = new Set(['BORA', 'HBAR']);       // 업비트 공통상장 (FOO 미상장)
  const withdrawFeePct = { BORA: 1.0, HBAR: 0.001 };    // 출금수수료율(%)

  it('업비트 공통상장 + 출금수수료율 > 임계인 코인만', () => {
    // 임계 0.3%: BORA(1.0%) 통과, HBAR(0.001%) 제외(전송이 쌈), FOO 제외(업비트 미상장)
    const r = selectReclaimTargets({ holdings, upbitMarkets, withdrawFeePct, thresholdPct: 0.3 });
    expect(r).toEqual(['BORA']);
  });

  it('출금수수료율 미확인(undefined) 코인은 보수적으로 포함(전송 대안 불명 → 되돌림 후보)', () => {
    const r = selectReclaimTargets({ holdings: { BORA: 1 }, upbitMarkets: new Set(['BORA']), withdrawFeePct: {}, thresholdPct: 0.3 });
    expect(r).toEqual(['BORA']);
  });

  it('보유량 0은 제외', () => {
    const r = selectReclaimTargets({ holdings: { BORA: 0 }, upbitMarkets: new Set(['BORA']), withdrawFeePct: { BORA: 1 }, thresholdPct: 0.3 });
    expect(r).toEqual([]);
  });
});
