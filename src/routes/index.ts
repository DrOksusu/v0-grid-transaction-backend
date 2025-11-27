import { Router } from 'express';
import authRoutes from './auth';
import botRoutes from './bots';
import exchangeRoutes from './exchange';
import credentialRoutes from './credentials';

const router = Router();

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Server is running',
    timestamp: new Date().toISOString(),
  });
});

router.use('/auth', authRoutes);
router.use('/bots', botRoutes);
router.use('/exchange', exchangeRoutes);
router.use('/credentials', credentialRoutes);

export default router;
