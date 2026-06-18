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

const RANGE_YEARS = { '1y': 1, '3y': 3, '5y': 5, '10y': 10 } as const

export async function getTimeseries(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const rangeParam = (req.query.range as string) ?? '5y'
    const years = (RANGE_YEARS as Record<string, number>)[rangeParam]
    if (!years) {
      res.status(400).json({ error: 'invalid range (use 1y|3y|5y|10y)' })
      return
    }

    const start = new Date()
    start.setUTCFullYear(start.getUTCFullYear() - years)

    const rows = await prisma.btcDormantSnapshot.findMany({
      where: { date: { gte: start } },
      orderBy: { date: 'asc' },
      select: {
        date: true,
        dormant1yRatio: true,
        dormant2yRatio: true,
        dormant3yRatio: true,
        btcPriceUsd: true,
      },
    })

    res.json(
      rows.map((r) => ({
        date: r.date.toISOString().slice(0, 10),
        dormant1y: Number(r.dormant1yRatio),
        dormant2y: Number(r.dormant2yRatio),
        dormant3y: Number(r.dormant3yRatio),
        btcPriceUsd: Number(r.btcPriceUsd),
      })),
    )
  } catch (e) {
    next(e)
  }
}
