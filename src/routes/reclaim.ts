import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import { requireAdmin } from '../middlewares/requireAdmin';
import { getReclaimStatus, putReclaimConfig } from '../controllers/reclaim.controller';

const router = Router();
router.use(authenticate);
router.use(requireAdmin);

router.get('/status', getReclaimStatus);
router.put('/config', putReclaimConfig);

export default router;
