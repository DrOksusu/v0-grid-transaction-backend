// 거래소 BTC 보유량 스케줄러 — 부팅 백필 + 매일 수집 (UTC 기준 cron)
import * as cron from 'node-cron'
import type { ScheduledTask } from 'node-cron'
import { EXCHANGE_RESERVE_CONFIG as CFG } from '../config/exchange-reserve'
import { runBackfill, runDailyCollect } from './exchange-reserve.service'
import { runAlertCheck } from './exchange-reserve-alert.service'

let tasks: ScheduledTask[] = []

// 1회 수집 사이클: 빈 DB면 백필(이전 실패 재시도) → 최근 구간 수집 → 새 일자면 알림 판정
export async function runCycle(label: string): Promise<void> {
  try {
    const backfill = await runBackfill()
    if (!backfill.skipped) console.log(`[exchange-reserve] ${label} backfill`, backfill)
    const collect = await runDailyCollect()
    console.log(`[exchange-reserve] ${label} collect`, collect)
    if (collect.status === 'ok' && collect.newData && collect.latest) {
      const alert = await runAlertCheck(collect.latest)
      console.log(`[exchange-reserve] ${label} alert`, alert)
    }
  } catch (e) {
    console.error(`[exchange-reserve] ${label} 실패`, e)
  }
}

export function startExchangeReserveScheduler(): void {
  if (tasks.length > 0) return
  // 부팅 시 백필 (비동기, 서버 시작 차단하지 않음)
  runBackfill()
    .then((r) => console.log('[exchange-reserve] boot backfill', r))
    .catch((e) => console.error('[exchange-reserve] boot backfill 실패', e))

  tasks = [
    cron.schedule(CFG.cronMain, () => runCycle('main'), { timezone: 'UTC' }),
    cron.schedule(CFG.cronRetry, () => runCycle('retry'), { timezone: 'UTC' }),
  ]
}

export function stopExchangeReserveScheduler(): void {
  tasks.forEach((t) => t.stop())
  tasks = []
}
