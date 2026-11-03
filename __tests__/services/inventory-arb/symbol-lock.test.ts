import { tryLockSymbol, unlockSymbol, isSymbolLocked } from '../../../src/services/inventory-arb/symbol-lock';

describe('symbol-lock (같은 코인 재고 동시 주문 방지)', () => {
  afterEach(() => {
    unlockSymbol(2, 'T');
    unlockSymbol(2, 'WAXP');
    unlockSymbol(3, 'T');
  });

  it('잠긴 코인은 두 번째 잠금이 실패한다 (로밍 실행 중 재고 되돌림 차단)', () => {
    expect(tryLockSymbol(2, 'T')).toBe(true);
    expect(tryLockSymbol(2, 'T')).toBe(false);
    expect(isSymbolLocked(2, 'T')).toBe(true);
  });

  it('해제하면 다시 잠글 수 있다', () => {
    expect(tryLockSymbol(2, 'T')).toBe(true);
    unlockSymbol(2, 'T');
    expect(isSymbolLocked(2, 'T')).toBe(false);
    expect(tryLockSymbol(2, 'T')).toBe(true);
  });

  it('다른 코인·다른 사용자는 서로 독립', () => {
    expect(tryLockSymbol(2, 'T')).toBe(true);
    expect(tryLockSymbol(2, 'WAXP')).toBe(true);
    expect(tryLockSymbol(3, 'T')).toBe(true);
  });

  it('심볼 대소문자는 같은 코인으로 본다', () => {
    expect(tryLockSymbol(2, 't')).toBe(true);
    expect(tryLockSymbol(2, 'T')).toBe(false);
  });
});
