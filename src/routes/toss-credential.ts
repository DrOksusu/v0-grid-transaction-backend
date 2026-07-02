import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import {
  saveCredential,
  getCredentialStatus,
  deleteCredential,
  previewAccounts,
  listAccounts,
} from '../controllers/toss-credential.controller';

const router = Router();

router.use(authenticate);

router.post('/', saveCredential);
router.get('/me', getCredentialStatus);
router.delete('/me', deleteCredential);
router.post('/preview-accounts', previewAccounts);
router.get('/accounts', listAccounts);

export default router;
