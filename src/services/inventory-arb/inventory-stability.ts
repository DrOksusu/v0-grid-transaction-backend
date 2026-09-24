// 재고 안정화 게이트(그리드봇 경합 방지) — KRW/USDT 재고형 아비 봇 공용.
// 매도측 코인 available 잔고가 inventoryStableSec 동안 무변동일 때만 실행.
// 변동 감지(그리드봇 매수/매도, 아비 자기거래 등) 시 타이머 리셋. 연속 관측 공백도 리셋.
const stabilityMap = new Map<string, { lastBalance: number; stableSince: number; lastCheckedAt: number }>();
const OBS_GAP_MS = 20_000; // 연속 관측 공백이 이보다 크면 안정성 주장 불가 → 리셋
const BAL_EPS = 1e-8;

/**
 * 매도측 재고(sellBalance) 안정성 판정 + 추적 갱신(모듈 Map 변경).
 * key는 봇 종류+id로 충돌 방지(예: `krw:3`, `usdt:1`).
 */
export function checkInventoryStable(key: string, sellBalance: number, stableSec: number): { stable: boolean; waitMs: number } {
  if (!stableSec || stableSec <= 0) return { stable: true, waitMs: 0 };
  const now = Date.now();
  const stableMs = stableSec * 1000;
  const prev = stabilityMap.get(key);
  const changed = !prev || Math.abs(prev.lastBalance - sellBalance) > BAL_EPS;
  const obsGap = prev ? now - prev.lastCheckedAt > OBS_GAP_MS : true;
  if (changed || obsGap) {
    stabilityMap.set(key, { lastBalance: sellBalance, stableSince: now, lastCheckedAt: now });
    return { stable: false, waitMs: stableMs };
  }
  stabilityMap.set(key, { ...prev, lastCheckedAt: now });
  const elapsed = now - prev.stableSince;
  return elapsed >= stableMs ? { stable: true, waitMs: 0 } : { stable: false, waitMs: stableMs - elapsed };
}

/** read-only 조회(맵 갱신 없음) — 상태 패널 표시용. 실행 추적을 방해하지 않는다. */
export function peekInventoryStable(key: string, stableSec: number): { stable: boolean; waitMs: number } {
  if (!stableSec || stableSec <= 0) return { stable: true, waitMs: 0 };
  const prev = stabilityMap.get(key);
  if (!prev) return { stable: false, waitMs: stableSec * 1000 };
  const stableMs = stableSec * 1000;
  const elapsed = Date.now() - prev.stableSince;
  return elapsed >= stableMs ? { stable: true, waitMs: 0 } : { stable: false, waitMs: stableMs - elapsed };
}
