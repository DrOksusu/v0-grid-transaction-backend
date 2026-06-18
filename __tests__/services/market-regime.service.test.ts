// market-regime.service.ts 전체 TDD 테스트 모음
// Cycle A (Task 4) ~ Cycle F (Task 9)

import { classifyRegime, REGIME_THRESHOLDS } from '../../src/config/market-regime'

// ============================================================
// Cycle A — classifyRegime boundary
// ============================================================

describe('classifyRegime', () => {
  it('2y series boundary — 0.65 → BOTTOM', () => {
    expect(classifyRegime(0.65, '2y')).toBe('BOTTOM')
  })
  it('2y series boundary — 0.649 → NEUTRAL', () => {
    expect(classifyRegime(0.649, '2y')).toBe('NEUTRAL')
  })
  it('2y series boundary — 0.55 → TOP', () => {
    expect(classifyRegime(0.55, '2y')).toBe('TOP')
  })
  it('2y series boundary — 0.551 → NEUTRAL', () => {
    expect(classifyRegime(0.551, '2y')).toBe('NEUTRAL')
  })
  it('1y series uses +5pt offset', () => {
    expect(classifyRegime(0.7, '1y')).toBe('BOTTOM')
    expect(classifyRegime(0.69, '1y')).toBe('NEUTRAL')
  })
  it('3y series uses -5pt offset', () => {
    expect(classifyRegime(0.6, '3y')).toBe('BOTTOM')
    expect(classifyRegime(0.5, '3y')).toBe('TOP')
  })
})
