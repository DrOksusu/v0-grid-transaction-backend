// 실제 외부 API 호출 통합 테스트
// CI에서도 실행 가능 (무료 공개 API)
// CoinMetrics: API 키 없으면 403 → skip
// bitcoin-data.com: 시간당 10회 레이트 리밋 → 초과 시 skip

import { fetchFromCoinMetrics, fetchFromBitcoinData } from '../../src/services/market-regime.service'
import { BD_LONG_TERM_BUCKETS } from '../../src/services/market-regime.schemas'

// 403/429/레이트리밋 에러인지 판단하는 헬퍼
function isRateLimitOrAuth(err: any): boolean {
  const msg: string = err?.message ?? ''
  return msg.includes('403') || msg.includes('429') || msg.includes('rate') || msg.includes('limit')
}

describe('market-regime integration', () => {
  jest.setTimeout(30_000)

  it('CoinMetrics: BTC 어제 데이터 fetch', async () => {
    const end = new Date()
    end.setUTCDate(end.getUTCDate() - 1)
    let rows: Awaited<ReturnType<typeof fetchFromCoinMetrics>>
    try {
      rows = await fetchFromCoinMetrics(end, end)
    } catch (err: any) {
      // API 키 없을 때 403, 레이트리밋 시 429 → skip
      if (isRateLimitOrAuth(err)) {
        console.warn('CoinMetrics API 접근 제한 (403/429) — 테스트 skip')
        return
      }
      throw err
    }
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].SplyCur).toBeGreaterThan(19_000_000)
  })

  it('bitcoin-data: hodl waves 응답에 long-term buckets 키가 모두 존재', async () => {
    let rows: Awaited<ReturnType<typeof fetchFromBitcoinData>>
    try {
      rows = await fetchFromBitcoinData()
    } catch (err: any) {
      // 429 레이트 리밋 초과 시 skip — 시간당 10회 제한
      if (isRateLimitOrAuth(err)) {
        console.warn('bitcoin-data.com 레이트 리밋 초과 (429) — 테스트 skip')
        return
      }
      throw err
    }

    expect(rows.length).toBeGreaterThan(0)
    const latest = rows[rows.length - 1]
    // 모든 long-term bucket 키가 응답에 존재하는지 검증
    for (const key of BD_LONG_TERM_BUCKETS) {
      expect(latest).toHaveProperty(key)
    }
  })
})
