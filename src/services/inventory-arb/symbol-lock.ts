/**
 * 코인 재고 잠금 (userId:symbol 단위, 비차단).
 * 같은 코인 재고를 쓰는 주문 작업 — 로밍·수동 실행(executeManual)과 재고 되돌림(reclaim) — 이
 * 동시에 주문하지 않도록 한다. 잠금을 못 잡으면 대기하지 않고 이번 사이클을 건너뛴다.
 *
 * 2026-10-25 #1184: 로밍과 재고 되돌림이 1초 차로 같은 빗썸 T 627.93개를 매도 →
 * 로밍 쪽 빗썸 매도 거부(insufficient_funds) + 업비트 매수만 체결 → flatten_failed (이슈 #123).
 *
 * 두 작업 모두 같은 Node 프로세스(AgentManager)에서 돌기 때문에 모듈 메모리 Set으로 충분하다.
 */
const lockedSymbols = new Set<string>();

const lockKey = (userId: number, symbol: string) => `${userId}:${symbol.toUpperCase()}`;

/** 잠금 획득. 이미 잠겨 있으면 false (호출자는 이번 실행을 건너뛴다) */
export function tryLockSymbol(userId: number, symbol: string): boolean {
  const key = lockKey(userId, symbol);
  if (lockedSymbols.has(key)) return false;
  lockedSymbols.add(key);
  return true;
}

/** 잠금 해제 — 반드시 finally에서 호출 */
export function unlockSymbol(userId: number, symbol: string): void {
  lockedSymbols.delete(lockKey(userId, symbol));
}

export function isSymbolLocked(userId: number, symbol: string): boolean {
  return lockedSymbols.has(lockKey(userId, symbol));
}
