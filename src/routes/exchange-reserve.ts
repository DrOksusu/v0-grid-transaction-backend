import { Router } from 'express'
import { authenticate } from '../middlewares/auth'
import { getExchangeReserve } from '../controllers/exchange-reserve.controller'

const router = Router()

router.get('/', authenticate, getExchangeReserve)

export default router
