import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import {
  searchSymbols,
  simulate,
  getBalance,
  listBots,
  createBot,
  updateBot,
  deleteBot,
} from '../controllers/korean-stock.controller';

const router = Router();

router.use(authenticate);

router.get('/symbols/search', searchSymbols);
router.post('/simulate', simulate);
router.get('/balance', getBalance);
router.get('/bots', listBots);
router.post('/bots', createBot);
router.put('/bots/:id', updateBot);
router.delete('/bots/:id', deleteBot);

export default router;
