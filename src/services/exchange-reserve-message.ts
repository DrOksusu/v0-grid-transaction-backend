// 거래소 보유량 알림 카톡 메시지 (순수 함수)
import type { ReservePoint } from './exchange-reserve-math'

const fmt = (n: number) => Math.round(n).toLocaleString('en-US')
const signed = (n: number) => `${n < 0 ? '-' : '+'}${fmt(Math.abs(n))}`

export function buildReserveAlertMessage(p: {
  latest: ReservePoint
  prevLow: number
  newLowCount: number
}): string {
  const { latest, prevLow, newLowCount } = p
  const lines = [
    '📉 거래소 BTC 1년 최저 갱신',
    `현재 ${fmt(latest.supply)} BTC (이전 최저 ${fmt(prevLow)})`,
    `지난 알림 이후 ${newLowCount}회 갱신, 누적 ${signed(latest.supply - prevLow)} BTC`,
  ]
  if (latest.inflow !== null && latest.outflow !== null) {
    const net = latest.inflow - latest.outflow
    const label = net < 0 ? '순유출' : '순유입'
    lines.push(`전일 ${label} ${fmt(Math.abs(net))} BTC (입금 ${fmt(latest.inflow)} / 출금 ${fmt(latest.outflow)})`)
  }
  lines.push(`기준일 ${latest.date} (UTC)`)
  return lines.join('\n')
}
