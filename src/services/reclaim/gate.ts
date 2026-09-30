export interface ReclaimGateInput {
  enabled: boolean;
  killSwitch: boolean;
  todayCount: number;
  dailyMaxCount: number | null;
  todayNotionalKrw: number;
  dailyMaxKrw: number | null;
  imbalanceKrw: number;       // 누적 부분체결 불균형 금액
  imbalanceCapKrw: number;
}

/** 스캔/실행 전 안전 게이트. 하나라도 걸리면 미실행. */
export function checkReclaimGate(i: ReclaimGateInput): { ok: boolean; reason?: string } {
  if (!i.enabled) return { ok: false, reason: 'disabled' };
  if (i.killSwitch) return { ok: false, reason: 'killSwitch' };
  if (i.dailyMaxCount != null && i.todayCount >= i.dailyMaxCount) return { ok: false, reason: 'dailyMaxCount' };
  if (i.dailyMaxKrw != null && i.todayNotionalKrw >= i.dailyMaxKrw) return { ok: false, reason: 'dailyMaxKrw' };
  if (i.imbalanceKrw >= i.imbalanceCapKrw) return { ok: false, reason: 'imbalanceCap' };
  return { ok: true };
}
