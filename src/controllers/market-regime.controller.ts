import type { Request, Response, NextFunction } from 'express'
import prisma from '../config/database'
import {
  classifyRegime,
  REGIME_THRESHOLDS,
  type Series,
} from '../config/market-regime'

const SERIES_KEYS: Series[] = ['1y', '2y', '3y']

export async function getCurrent(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const latest = await prisma.btcDormantSnapshot.findFirst({
      orderBy: { date: 'desc' },
    })

    if (!latest) {
      // 백필 진행 중 — 현재까지 저장된 행 수 반환
      const total = await prisma.btcDormantSnapshot.count()
      res.json({
        status: 'backfilling',
        progress: total,
        message: '데이터 백필 진행 중입니다',
      })
      return
    }

    const ratios = {
      '1y': Number(latest.dormant1yRatio),
      '2y': Number(latest.dormant2yRatio),
      '3y': Number(latest.dormant3yRatio),
    }
    const regimes = Object.fromEntries(
      SERIES_KEYS.map((s) => [s, classifyRegime(ratios[s], s)]),
    ) as Record<Series, ReturnType<typeof classifyRegime>>

    const ageDays = (Date.now() - latest.date.getTime()) / 86_400_000

    res.json({
      date: latest.date.toISOString().slice(0, 10),
      ratios,
      regimes,
      btcPriceUsd: Number(latest.btcPriceUsd),
      thresholds: REGIME_THRESHOLDS,
      lastFetched: latest.updatedAt.toISOString(),
      warnings: {
        reconcileWarning: latest.reconcileWarning,
        dataSource: latest.dataSource,
        stale: ageDays > 7,
      },
    })
  } catch (e) {
    next(e)
  }
}
