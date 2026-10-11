// CoinMetrics Community API — 거래소 BTC 보유량 조회 (외부 경계: zod 검증)
import { z } from 'zod'
import { EXCHANGE_RESERVE_CONFIG as CFG } from '../config/exchange-reserve'
import type { ReservePoint } from './exchange-reserve-math'

// CoinMetrics는 숫자를 문자열로 준다 → 숫자로 변환 (NaN이면 검증 실패)
const numericString = z.preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number())

const rowSchema = z.object({
  asset: z.string(),
  time: z.string(),
  SplyExNtv: numericString.nullish(),
  FlowInExNtv: numericString.nullish(),
  FlowOutExNtv: numericString.nullish(),
})

const responseSchema = z.object({
  data: z.array(rowSchema),
  next_page_url: z.string().nullish(),
})

async function getJson(url: string): Promise<unknown> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), CFG.fetchTimeoutMs)
  try {
    const res = await fetch(url, { signal: ctl.signal })
    if (!res.ok) throw new Error(`CoinMetrics ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

// start(YYYY-MM-DD)부터 최신까지 일별 데이터를 일자 오름차순으로 반환
export async function fetchExchangeReserve(start: string): Promise<ReservePoint[]> {
  const params = new URLSearchParams({
    assets: 'btc',
    metrics: CFG.metrics.join(','),
    frequency: '1d',
    start_time: start,
    page_size: '10000',
    paging_from: 'start', // 기본값(end)은 최신→과거 순
  })
  let url: string | undefined = `${CFG.coinmetricsBase}/timeseries/asset-metrics?${params}`
  const out: ReservePoint[] = []
  let pages = 0

  while (url) {
    pages += 1
    if (pages > CFG.maxPages) throw new Error('CoinMetrics 페이지 수 초과')
    const parsed = responseSchema.parse(await getJson(url))
    for (const r of parsed.data) {
      if (r.SplyExNtv == null) continue
      out.push({
        date: r.time.slice(0, 10),
        supply: r.SplyExNtv,
        inflow: r.FlowInExNtv ?? null,
        outflow: r.FlowOutExNtv ?? null,
      })
    }
    url = parsed.next_page_url ?? undefined
  }

  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}
