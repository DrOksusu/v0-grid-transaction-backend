import {
  coinmetricsResponseSchema,
  bitcoinDataHodlWavesSchema,
} from '../../src/services/market-regime.schemas'

describe('coinmetricsResponseSchema', () => {
  it('일별 BTC supply 응답을 파싱한다', () => {
    const raw = {
      data: [
        {
          asset: 'btc',
          time: '2026-06-17T00:00:00Z',
          SplyAct1yr: '5000000',
          SplyAct2yr: '4500000',
          SplyAct3yr: '4200000',
          SplyCur: '19700000',
          PriceUSD: '91234.56',
        },
      ],
    }
    const parsed = coinmetricsResponseSchema.parse(raw)
    expect(parsed.data[0].SplyAct2yr).toBe(4500000)
  })

  it('필드 누락 시 throw', () => {
    expect(() =>
      coinmetricsResponseSchema.parse({ data: [{ asset: 'btc' }] }),
    ).toThrow()
  })
})

describe('bitcoinDataHodlWavesSchema', () => {
  it('hodl waves 응답을 파싱한다', () => {
    const raw = [
      { d: '2026-06-17', '1y': 0.12, '2y': 0.08, '3y': 0.07, '5y': 0.05, '7y': 0.04, '10y': 0.03 },
    ]
    const parsed = bitcoinDataHodlWavesSchema.parse(raw)
    expect(parsed[0]['2y']).toBe(0.08)
  })
})
