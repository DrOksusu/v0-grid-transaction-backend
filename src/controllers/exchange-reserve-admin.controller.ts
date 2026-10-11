// 거래소 보유량 알림 관리자 API (authenticate + requireAdmin 뒤에 마운트)
import type { Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { getAlertConfig, listAlerts, updateAlertConfig } from '../services/exchange-reserve-alert.service'

const configSchema = z.object({
  enabled: z.boolean().optional(),
  cooldownDays: z.number().int().min(1).max(30).optional(),
  lookbackDays: z.number().int().min(30).max(730).optional(),
})

export async function getConfig(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await getAlertConfig())
  } catch (e) {
    next(e)
  }
}

export async function putConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = configSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid config', issues: parsed.error.issues })
      return
    }
    res.json(await updateAlertConfig(parsed.data))
  } catch (e) {
    next(e)
  }
}

export async function getAlerts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const raw = Number(req.query.limit ?? 50)
    const limit = Number.isInteger(raw) && raw >= 1 && raw <= 200 ? raw : 50
    const rows = await listAlerts(limit)
    res.json({
      alerts: rows.map((r) => ({
        id: r.id,
        dataDate: r.dataDate.toISOString().slice(0, 10),
        supplyBtc: Number(r.supplyBtc),
        prevLowBtc: Number(r.prevLowBtc),
        newLowCount: r.newLowCount,
        message: r.message,
        sentAt: r.sentAt.toISOString(),
      })),
    })
  } catch (e) {
    next(e)
  }
}
