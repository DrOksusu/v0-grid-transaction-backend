import { Router } from 'express'
import { authenticate } from '../middlewares/auth'
import { getCurrent, getTimeseries } from '../controllers/market-regime.controller'

const router = Router()

router.get('/btc/current', authenticate, getCurrent)
router.get('/btc/timeseries', authenticate, getTimeseries)

export default router
