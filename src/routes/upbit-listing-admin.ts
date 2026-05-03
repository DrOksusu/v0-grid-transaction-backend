import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import { requireAdmin } from '../middlewares/requireAdmin';
import {
  listAnnouncements,
  getAnnouncement,
  triggerSnapshot,
  fetchCurrentPrices,
  createManual,
} from '../controllers/upbit-listing-admin.controller';

const router = Router();

router.use(authenticate);
router.use(requireAdmin);

router.get('/', listAnnouncements);
router.post('/manual', createManual);
router.get('/:id', getAnnouncement);
router.post('/:id/snapshot', triggerSnapshot);
router.get('/:id/prices', fetchCurrentPrices);

export default router;
