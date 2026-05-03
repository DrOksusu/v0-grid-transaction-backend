import { Router } from 'express';
import {
  createCredential,
  getAllCredentials,
  getCredentialByExchange,
  updateCredential,
  deleteCredential,
  testUpbitApiKey,
  getUpbitBalance,
  testBithumbConnection,
} from '../controllers/credential.controller';
import { authenticate } from '../middlewares/auth';

const router = Router();

router.use(authenticate);

router.post('/', createCredential);
router.get('/', getAllCredentials);
router.get('/test/upbit', testUpbitApiKey);
router.get('/test/bithumb', testBithumbConnection);
router.get('/upbit/balance', getUpbitBalance);
router.get('/:exchange', getCredentialByExchange);
router.put('/:exchange', updateCredential);
router.delete('/:exchange', deleteCredential);

export default router;
