// market-regime.service.ts 전체 TDD 테스트 모음
// Cycle A (Task 4) ~ Cycle F (Task 9)

import { classifyRegime, REGIME_THRESHOLDS } from '../../src/config/market-regime'
import { fetchFromCoinMetrics } from '../../src/services/market-regime.service'

// ============================================================
// 글로벌 fetch mock 복원용
// ============================================================
const originalFetch = global.fetch
afterEach(() => { global.fetch = originalFetch })

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

// ============================================================
// Cycle B — fetchFromCoinMetrics
// ============================================================

describe('fetchFromCoinMetrics', () => {
  it('단일 일자 fetch 정상 응답', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{
          asset: 'btc', time: '2026-06-17T00:00:00Z',
          SplyAct1yr: '5000000', SplyAct2yr: '4500000', SplyAct3yr: '4200000',
          SplyCur: '19700000', PriceUSD: '91234.56',
        }],
      }),
    }) as any
    const rows = await fetchFromCoinMetrics(new Date('2026-06-17'), new Date('2026-06-17'))
    expect(rows).toHaveLength(1)
    expect(rows[0].SplyAct2yr).toBe(4500000)
  })

  it('HTTP 5xx → throw', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 }) as any
    await expect(
      fetchFromCoinMetrics(new Date('2026-06-17'), new Date('2026-06-17')),
    ).rejects.toThrow(/503/)
  })
})
