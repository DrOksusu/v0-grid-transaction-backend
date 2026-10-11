import type { Request, Response, NextFunction } from 'express'
import { ALLOWED_VIEW_DAYS, type ViewRange } from '../config/exchange-reserve'
import { getReserveView } from '../services/exchange-reserve.service'

// GET /api/exchange-reserve?days=90|365|1095|1825|all — 거래소 BTC 보유량 시계열 + 요약
export async function getExchangeReserve(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const raw = req.query.days ?? 365
    const range = raw === 'all' ? 'all' : Number(raw)
    if (range !== 'all' && !(ALLOWED_VIEW_DAYS as readonly number[]).includes(range)) {
      res.status(400).json({ error: 'invalid days (use 90|365|1095|1825|all)' })
      return
    }
    res.json(await getReserveView(range as ViewRange))
  } catch (e) {
    next(e)
  }
}
