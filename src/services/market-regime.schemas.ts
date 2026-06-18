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

// 2년+ 장기 보유자 비율 산정에 합산할 버킷 키.
// ⚠️ 2026-06-19 검증 결과: bitcoin-data.com 무료 API는 hodl waves 멀티버킷 endpoint를
// 제공하지 않음 (`longTermHodlerSupplyBtcs` 단일값만 존재). 따라서 아래 키 배열은
// 현재 폴백 호출이 실패해도 graceful degrade되도록 그대로 남겨두는 dead-but-safe 정의.
// 후속 PR에서 fallback 전략 재설계 시 함께 수정. 자세한 내역은 spec § 15 참조.
export const BD_LONG_TERM_BUCKETS = ['2y', '3y', '5y', '7y', '10y'] as const
