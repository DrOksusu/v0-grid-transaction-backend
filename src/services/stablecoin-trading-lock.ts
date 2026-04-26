/**
 * 스테이블코인 트레이딩용 process-local 메모리 mutex.
 *
 * 직접 아비트리지 executor 진입 시 acquire,
 * maker-taker live executor의 신규 PENDING 생성 시 isLocked() 확인.
 *
 * 30초 timeout으로 deadlock 방어 (이전 holder가 throw해서 안 풀린 경우).
 */

let locked = false;
let holder: string | null = null;
let acquiredAt = 0;
const MAX_HOLD_MS = 30_000;

export const tradingLock = {
  tryAcquire(by: string): boolean {
    // timeout 지난 lock은 강제 해제
    if (locked && Date.now() - acquiredAt > MAX_HOLD_MS) {
      console.warn(
        `[TradingLock] forced release from ${holder} (timeout > ${MAX_HOLD_MS}ms)`,
      );
      locked = false;
      holder = null;
    }
    if (locked) return false;
    locked = true;
    holder = by;
    acquiredAt = Date.now();
    return true;
  },

  release(by: string): void {
    if (holder === by) {
      locked = false;
      holder = null;
    }
  },

  isLocked(): boolean {
    return locked;
  },

  // 테스트 전용 — runtime에서는 호출 안 함
  _reset(): void {
    locked = false;
    holder = null;
    acquiredAt = 0;
  },
};
