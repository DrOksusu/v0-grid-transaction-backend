import type { Request, Response, NextFunction } from 'express'
import { ALLOWED_VIEW_DAYS } from '../config/exchange-reserve'
import { getReserveView } from '../services/exchange-reserve.service'

// GET /api/exchange-reserve?days=90|365 — 거래소 BTC 보유량 시계열 + 요약
export async function getExchangeReserve(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const days = Number(req.query.days ?? 365)
    if (!(ALLOWED_VIEW_DAYS as readonly number[]).includes(days)) {
      res.status(400).json({ error: 'invalid days (use 90|365)' })
      return
    }
    res.json(await getReserveView(days))
  } catch (e) {
    next(e)
  }
}
