import { Router } from 'express';
import authRoutes from './auth';
import botRoutes from './bots';
import exchangeRoutes from './exchange';
import credentialRoutes from './credentials';
import kisRoutes from './kis';
import infiniteBuyRoutes from './infinite-buy';
import profitRoutes from './profits';
import pushRoutes from './push';
import whaleRoutes from './whale';
import metricsRoutes from './metrics';
import subscriptionRoutes from './subscription';
import usdtSubscriptionRoutes from './usdt-subscription';

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
router.use('/whale', whaleRoutes);
router.use('/metrics', metricsRoutes);
router.use('/subscription', subscriptionRoutes);
router.use('/usdt', usdtSubscriptionRoutes);

export default router;
