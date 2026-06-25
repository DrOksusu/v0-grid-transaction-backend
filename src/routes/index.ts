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
import upbitDonationRoutes from './upbit-donation';
import adminDonationRoutes from './admin-donation';
import maRoutes from './ma';
import agentRoutes from './agents';
import stablecoinAdminRoutes from './stablecoin-admin';
import volatilityAdminRoutes from './volatility-admin';
import pairScannerRoutes from './pair-scanner';
import generalArbAdminRoutes from './general-arb-admin';
import listingAdminRoutes from './listing-admin';
import kakaoAdminRoutes from './kakao-admin';
import transferRoutes from './transfer';
import internalRoutes from './internal';
import costBasisRoutes from './cost-basis';
import marketRegimeRoutes from './market-regime';

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
router.use('/upbit-donation', upbitDonationRoutes);
router.use('/admin', adminDonationRoutes);
router.use('/ma', maRoutes);
router.use('/agents', agentRoutes);
router.use('/admin/stablecoin', stablecoinAdminRoutes);
router.use('/admin/volatility', volatilityAdminRoutes);
router.use('/pair-scanner', pairScannerRoutes);
router.use('/admin/general-arb', generalArbAdminRoutes);
router.use('/admin/listings', listingAdminRoutes);
router.use('/admin/upbit-listings', listingAdminRoutes); // 1주일 별칭 유지 (Task 13 후 제거)
router.use('/admin/btc-rsi', kakaoAdminRoutes);
router.use('/transfer', transferRoutes);
router.use('/internal', internalRoutes);
router.use('/cost-basis', costBasisRoutes);
router.use('/market-regime', marketRegimeRoutes);

export default router;
