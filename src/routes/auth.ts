import { Router } from 'express';
import { register, login, logout, getProfile, updateNickname } from '../controllers/auth.controller';
import { authenticate } from '../middlewares/auth';

const router = Router();

router.post('/register', register);
router.post('/login', login);
router.post('/logout', authenticate, logout);

// 프로필 관련
router.get('/profile', authenticate, getProfile);
router.put('/nickname', authenticate, updateNickname);

export default router;
