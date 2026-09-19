import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import { createBot, getBots, getTrades, updateBot, deleteBot } from '../controllers/inventory-arb.controller';

const router = Router();
router.use(authenticate);

router.post('/', createBot);
router.get('/', getBots);
router.get('/:id/trades', getTrades);
router.put('/:id', updateBot);
router.delete('/:id', deleteBot);

export default router;
