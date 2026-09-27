import { decideAction, buildEmergencyMessage } from '../../src/services/inventory-arb.service';

describe('decideAction', () => {
  const bot = { enabled: true, killSwitch: false, autoExecute: true };

  it('killSwitch면 skip', () => {
    expect(decideAction({ ...bot, killSwitch: true }).action).toBe('skip');
  });
  it('enabled=false면 skip', () => {
    expect(decideAction({ ...bot, enabled: false }).action).toBe('skip');
  });
  it('autoExecute=true면 execute', () => {
    expect(decideAction(bot).action).toBe('execute');
  });
  it('autoExecute=false면 notify (반자동 = 알림만)', () => {
    expect(decideAction({ ...bot, autoExecute: false }).action).toBe('notify');
  });
});

describe('buildEmergencyMessage', () => {
  it('flatten_failed 정보를 포함', () => {
    const msg = buildEmergencyMessage('XRP', 4, 'net long but ...');
    expect(msg).toContain('XRP');
    expect(msg).toContain('killSwitch');
  });
});

describe('pickRoamCandidates (로밍 실행 대상 선택)', () => {
  const { pickRoamCandidates } = require('../../src/services/inventory-arb.service');
  const cand = (symbol: string, over: any = {}) => ({
    symbol, executableKrw: 100000, estimatedNetKrw: 1500, realizable: true, netProfitable: true, ...over,
  });

  it('순차익% ≥ 임계인 후보만, 큰 순 정렬', () => {
    const picks = pickRoamCandidates(
      [cand('A', { estimatedNetKrw: 1200 }), cand('B', { estimatedNetKrw: 3000 }), cand('C', { estimatedNetKrw: 500 })],
      { minNetPct: 1 }, new Map(), Date.now(),
    );
    expect(picks.map((p: any) => p.symbol)).toEqual(['B', 'A']); // C=0.5% 미달
    expect(picks[0].netPct).toBeCloseTo(3, 5);
  });

  it('쿨다운 중인 심볼 제외', () => {
    const now = Date.now();
    const cd = new Map([['A', now + 60000]]);
    const picks = pickRoamCandidates([cand('A'), cand('B')], { minNetPct: 1 }, cd, now);
    expect(picks.map((p: any) => p.symbol)).toEqual(['B']);
  });

  it('실행불가/순이익 아님/규모 0 제외', () => {
    const picks = pickRoamCandidates(
      [cand('A', { realizable: false }), cand('B', { netProfitable: false }), cand('C', { executableKrw: 0 })],
      { minNetPct: 0 }, new Map(), Date.now(),
    );
    expect(picks).toEqual([]);
  });
});
