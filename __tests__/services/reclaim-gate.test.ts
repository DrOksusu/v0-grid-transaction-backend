import { checkReclaimGate } from '../../src/services/reclaim/gate';

const ok = {
  enabled: true, killSwitch: false,
  todayCount: 0, dailyMaxCount: 50,
  todayNotionalKrw: 0, dailyMaxKrw: 1_000_000,
  imbalanceKrw: 0, imbalanceCapKrw: 100_000,
};

describe('checkReclaimGate', () => {
  it('정상 조건 → ok', () => { expect(checkReclaimGate(ok).ok).toBe(true); });
  it('enabled=false → disabled', () => { expect(checkReclaimGate({ ...ok, enabled: false })).toEqual({ ok: false, reason: 'disabled' }); });
  it('killSwitch → killSwitch', () => { expect(checkReclaimGate({ ...ok, killSwitch: true }).reason).toBe('killSwitch'); });
  it('일 건수 초과 → dailyMaxCount', () => { expect(checkReclaimGate({ ...ok, todayCount: 50 }).reason).toBe('dailyMaxCount'); });
  it('일 금액 초과 → dailyMaxKrw', () => { expect(checkReclaimGate({ ...ok, todayNotionalKrw: 1_000_000 }).reason).toBe('dailyMaxKrw'); });
  it('불균형 한도 초과 → imbalanceCap', () => { expect(checkReclaimGate({ ...ok, imbalanceKrw: 100_000 }).reason).toBe('imbalanceCap'); });
  it('null 한도는 무제한', () => { expect(checkReclaimGate({ ...ok, dailyMaxCount: null, dailyMaxKrw: null, todayCount: 9999 }).ok).toBe(true); });
});
