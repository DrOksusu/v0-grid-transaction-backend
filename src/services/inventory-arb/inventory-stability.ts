// 재고 안정화(그리드봇 경합 방지) — KRW/USDT 재고형 아비 봇 공용.
// "안정 거래가능량" = 매도측 코인 available 잔고가 최근 stableSec 창 동안 유지된 **최소값**.
// 예: 50개였다가 60초 뒤 51.5개면 min=50 → 50개까지만 거래(방금 채워진 1.5는 그리드 신선분이라 제외).
// 아비 자기 매도로 잔고가 줄면 min도 줄어 다음 캡이 낮아짐(자기 재고만 소진). 연속 관측 공백(>20s)이면 커버리지 리셋.
interface Reading { ts: number; balance: number }
const store = new Map<string, { readings: Reading[]; coverageSince: number }>();
const OBS_GAP_MS = 20_000; // 연속 관측 공백이 이보다 크면 커버리지 리셋(관측 못 한 구간의 min을 알 수 없음)

/**
 * 매도측 잔고 관측을 갱신하고 "안정 거래가능량"(창 내 최소 잔고)을 반환.
 * stableSec<=0(비활성)이면 현재 잔고 전부. 아직 stableSec 연속 관측 전이면 0.
 */
export function stableTradeableAmount(key: string, balance: number, stableSec: number): number {
  if (!stableSec || stableSec <= 0) return balance;
  const now = Date.now();
  const stableMs = stableSec * 1000;
  let st = store.get(key);
  // 연속 관측 공백 → 커버리지 리셋(그 구간 min 불명)
  if (st && st.readings.length > 0 && now - st.readings[st.readings.length - 1].ts > OBS_GAP_MS) {
    st = undefined;
  }
  if (!st) st = { readings: [], coverageSince: now };
  st.readings.push({ ts: now, balance });
  // 창 밖 관측 제거
  const cutoff = now - stableMs;
  st.readings = st.readings.filter((r) => r.ts >= cutoff);
  store.set(key, st);
  if (now - st.coverageSince < stableMs) return 0; // 아직 60초 연속 관측 부족
  return Math.min(...st.readings.map((r) => r.balance));
}

/** read-only(상태 표시용, 갱신 없음). 관측 부족이면 0, 비활성이면 현재 잔고. */
export function peekStableAmount(key: string, stableSec: number, currentBalance: number): number {
  if (!stableSec || stableSec <= 0) return currentBalance;
  const st = store.get(key);
  if (!st || st.readings.length === 0 || Date.now() - st.coverageSince < stableSec * 1000) return 0;
  return Math.min(...st.readings.map((r) => r.balance), currentBalance);
}
