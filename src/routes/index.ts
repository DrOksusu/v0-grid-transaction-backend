import { Router } from 'express';
import authRoutes from './auth';
import botRoutes from './bots';
import exchangeRoutes from './exchange';
import credentialRoutes from './credentials';
import kisRoutes from './kis';
import infiniteBuyRoutes from './infinite-buy';
import profitRoutes from './profits';
import pushRoutes from './push';

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
router.use('/kis', kisRoutes);
router.use('/infinite-buy', infiniteBuyRoutes);
router.use('/profits', profitRoutes);
router.use('/push', pushRoutes);

export default router;
