import { Router } from 'express';
import {
  register,
  login,
  logout,
  getProfile,
  updateNickname,
  forgotPassword,
  resetPassword,
  verifyResetToken,
} from '../controllers/auth.controller';
import { authenticate } from '../middlewares/auth';

const router = Router();

router.post('/register', register);
router.post('/login', login);
router.post('/logout', authenticate, logout);

// 프로필 관련
router.get('/profile', authenticate, getProfile);
router.put('/nickname', authenticate, updateNickname);

// 비밀번호 찾기
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);
router.get('/verify-reset-token', verifyResetToken);

export default router;
