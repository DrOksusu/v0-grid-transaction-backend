// 거래소 보유량 1년 최저 알림 판정 (순수 함수)
// 쿨다운 기준은 발송 시각이 아닌 "데이터 일자" — 재시도·재시작 시각 차이에 영향받지 않음
import { addDays, daysBetween, isNewLowAt, type ReservePoint } from './exchange-reserve-math'

export interface AlertInput {
  series: ReservePoint[]          // 일자 오름차순
  latestDate: string              // 이번에 새로 들어온 최신 일자
  lastAlertDataDate: string | null
  cooldownDays: number
  lookbackDays: number
  enabled: boolean
}

export type AlertReason = 'disabled' | 'cooldown' | 'no_new_low' | 'new_low'

export interface AlertDecision {
  send: boolean
  reason: AlertReason
  newLowCount: number
  prevLow: number | null
  lowDates: string[]
}

function skip(reason: AlertReason): AlertDecision {
  return { send: false, reason, newLowCount: 0, prevLow: null, lowDates: [] }
}

export function decideAlert(input: AlertInput): AlertDecision {
  const { series, latestDate, lastAlertDataDate, cooldownDays, lookbackDays, enabled } = input
  if (!enabled) return skip('disabled')
  if (lastAlertDataDate !== null && daysBetween(lastAlertDataDate, latestDate) < cooldownDays) {
    return skip('cooldown')
  }

  // 최초 가동이면 최근 cooldownDays일 안의 갱신만 (과거 갱신 몰아서 보내지 않기)
  const fromExclusive = lastAlertDataDate ?? addDays(latestDate, -cooldownDays)
  const lowIdx: number[] = []
  series.forEach((p, i) => {
    if (p.date > fromExclusive && p.date <= latestDate && isNewLowAt(series, i, lookbackDays).isLow) {
      lowIdx.push(i)
    }
  })
  if (lowIdx.length === 0) return skip('no_new_low')

  return {
    send: true,
    reason: 'new_low',
    newLowCount: lowIdx.length,
    prevLow: isNewLowAt(series, lowIdx[0], lookbackDays).prevLow,
    lowDates: lowIdx.map((i) => series[i].date),
  }
}
