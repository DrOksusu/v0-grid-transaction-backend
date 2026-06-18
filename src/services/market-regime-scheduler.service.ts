import * as cron from 'node-cron'
import type { ScheduledTask } from 'node-cron'
import { MARKET_REGIME_CONFIG } from '../config/market-regime'
import { runBackfill, runDailyPoll } from './market-regime.service'

// 싱글톤 스케줄 태스크
let task: ScheduledTask | null = null

export async function startMarketRegimeScheduler(): Promise<void> {
  // 부팅 시 백필 (비동기, 서버 시작 차단하지 않음)
  runBackfill()
    .then((r) => console.log('[market-regime] backfill', r))
    .catch((e) => console.error('[market-regime] backfill failed', e))

  if (task) return
  task = cron.schedule(
    MARKET_REGIME_CONFIG.cron,
    async () => {
      try {
        const r = await runDailyPoll()
        console.log('[market-regime] daily poll', r)
      } catch (e) {
        console.error('[market-regime] daily poll error', e)
      }
    },
    { timezone: 'UTC' },
  )
}

export function stopMarketRegimeScheduler(): void {
  if (task) {
    task.stop()
    task = null
  }
}
