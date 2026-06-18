import { z } from 'zod'

// CoinMetrics: 숫자가 문자열로 옴 → 숫자로 변환
const numericString = z.preprocess(
  (v) => (typeof v === 'string' ? Number(v) : v),
  z.number(),
)

export const coinmetricsRowSchema = z.object({
  asset: z.string(),
  time: z.string(),
  SplyAct1yr: numericString,
  SplyAct2yr: numericString,
  SplyAct3yr: numericString,
  SplyCur: numericString,
  PriceUSD: numericString,
})

export const coinmetricsResponseSchema = z.object({
  data: z.array(coinmetricsRowSchema),
})

export type CoinmetricsRow = z.infer<typeof coinmetricsRowSchema>

// bitcoin-data.com hodl-waves — 배열 of { d: date, '<bucket>': number, ... }
// 버킷 라벨은 실제 응답 기준으로 매핑. catchall로 임의 키 수용
export const bitcoinDataHodlWavesRowSchema = z
  .object({
    d: z.string(),
  })
  .catchall(z.number())

export const bitcoinDataHodlWavesSchema = z.array(bitcoinDataHodlWavesRowSchema)

export type BitcoinDataHodlWavesRow = z.infer<typeof bitcoinDataHodlWavesRowSchema>

// 2년+ 장기 보유자 비율 산정에 합산할 버킷 키
// 실제 응답 schema 확인 후 조정 가능
export const BD_LONG_TERM_BUCKETS = ['2y', '3y', '5y', '7y', '10y'] as const
