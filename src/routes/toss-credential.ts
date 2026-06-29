import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import {
  saveCredential,
  getCredentialStatus,
  deleteCredential,
} from '../controllers/toss-credential.controller';

const router = Router();

router.use(authenticate);

router.post('/', saveCredential);
router.get('/me', getCredentialStatus);
router.delete('/me', deleteCredential);

export default router;
