// 거래소 보유량 알림 관리자 라우트 — Base path: /admin/exchange-reserve
import { Router } from 'express'
import { authenticate } from '../middlewares/auth'
import { requireAdmin } from '../middlewares/requireAdmin'
import { getAlerts, getConfig, putConfig } from '../controllers/exchange-reserve-admin.controller'

const router = Router()

router.use(authenticate)
router.use(requireAdmin)

router.get('/config', getConfig)
router.put('/config', putConfig)
router.get('/alerts', getAlerts)

export default router
