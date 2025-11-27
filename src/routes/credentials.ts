import { Router } from 'express';
import {
  createCredential,
  getAllCredentials,
  getCredentialByExchange,
  updateCredential,
  deleteCredential,
  testUpbitApiKey,
} from '../controllers/credential.controller';
import { authenticate } from '../middlewares/auth';

const router = Router();

router.use(authenticate);

router.post('/', createCredential);
router.get('/', getAllCredentials);
router.get('/test/upbit', testUpbitApiKey); // 테스트 엔드포인트
router.get('/:exchange', getCredentialByExchange);
router.put('/:exchange', updateCredential);
router.delete('/:exchange', deleteCredential);

export default router;
