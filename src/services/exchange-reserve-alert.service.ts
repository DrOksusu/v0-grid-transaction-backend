// 거래소 보유량 알림 — 설정·이력 조회, 1년 최저 판정 후 카톡 발송
import prisma from '../config/database'
import { kakaoNotifyService } from './kakao-notify.service'
import { decideAlert, type AlertReason } from './exchange-reserve-alert'
import { buildReserveAlertMessage } from './exchange-reserve-message'
import { addDays, dayToDate, toDay } from './exchange-reserve-math'
import { loadSeries } from './exchange-reserve.service'

export const ALERT_LINK = 'https://grid.koco.me/admin/exchange-reserve'
const DEFAULT_CONFIG = { enabled: true, cooldownDays: 7, lookbackDays: 365 }
// lookback 비교 구간 외 여유분 (결측일 대비)
const SERIES_MARGIN_DAYS = 40

export interface AlertConfigPatch {
  enabled?: boolean
  cooldownDays?: number
  lookbackDays?: number
}

// 설정 행이 없으면 기본값으로 생성 (시드 누락 방지)
export async function getAlertConfig() {
  return prisma.exchangeReserveAlertConfig.upsert({
    where: { id: 1 },
    create: { id: 1, ...DEFAULT_CONFIG },
    update: {},
  })
}

export async function updateAlertConfig(patch: AlertConfigPatch) {
  return prisma.exchangeReserveAlertConfig.upsert({
    where: { id: 1 },
    create: { id: 1, ...DEFAULT_CONFIG, ...patch },
    update: patch,
  })
}

export async function listAlerts(limit: number) {
  return prisma.exchangeReserveAlert.findMany({ orderBy: { sentAt: 'desc' }, take: limit })
}

export interface AlertCheckResult {
  sent: boolean
  reason: AlertReason | 'send_failed' | 'no_data'
  newLowCount: number
}

// 새 최신 일자가 들어왔을 때 호출. 발송 성공 후에만 이력 기록
export async function runAlertCheck(latestDate: string): Promise<AlertCheckResult> {
  const config = await getAlertConfig()
  const last = await prisma.exchangeReserveAlert.findFirst({ orderBy: { dataDate: 'desc' } })
  const series = await loadSeries(addDays(latestDate, -(config.lookbackDays + SERIES_MARGIN_DAYS)))
  const latest = series.find((p) => p.date === latestDate)
  if (!latest) return { sent: false, reason: 'no_data', newLowCount: 0 }

  const decision = decideAlert({
    series,
    latestDate,
    lastAlertDataDate: last ? toDay(last.dataDate) : null,
    cooldownDays: config.cooldownDays,
    lookbackDays: config.lookbackDays,
    enabled: config.enabled,
  })
  if (!decision.send || decision.prevLow === null) {
    return { sent: false, reason: decision.reason, newLowCount: decision.newLowCount }
  }

  const message = buildReserveAlertMessage({
    latest,
    prevLow: decision.prevLow,
    newLowCount: decision.newLowCount,
  })
  try {
    await kakaoNotifyService.sendToMe(message, ALERT_LINK)
  } catch (e) {
    console.error('[exchange-reserve] 카톡 발송 실패', e)
    return { sent: false, reason: 'send_failed', newLowCount: decision.newLowCount }
  }

  try {
    await prisma.exchangeReserveAlert.create({
      data: {
        dataDate: dayToDate(latestDate),
        supplyBtc: latest.supply,
        prevLowBtc: decision.prevLow,
        newLowCount: decision.newLowCount,
        message,
      },
    })
  } catch (e) {
    // 카톡은 이미 나갔으므로 sent=true 유지. 기록이 없어 다음 판정에서 같은 갱신이 중복 발송될 수 있음
    console.error(`[exchange-reserve] 카톡 발송됨·이력 기록 실패 (dataDate=${latestDate}) — 다음 판정에서 중복 발송 가능`, e)
  }
  return { sent: true, reason: 'new_low', newLowCount: decision.newLowCount }
}
