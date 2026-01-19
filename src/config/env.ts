import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: process.env.PORT || 3010,
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || '',
  jwt: {
    secret: process.env.JWT_SECRET || '',
    accessExpiry: process.env.JWT_ACCESS_EXPIRY || '1h',
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
  },
  aws: {
    region: process.env.AWS_REGION || '',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    s3BucketName: process.env.S3_BUCKET_NAME || '',
  },
  upload: {
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '10485760'),
    allowedFileTypes: process.env.ALLOWED_FILE_TYPES?.split(',') || [],
  },
  // TronGrid API (USDT TRC-20 입금 모니터링)
  tron: {
    apiKey: process.env.TRON_API_KEY || '',
    apiBase: process.env.TRON_API_BASE || 'https://api.trongrid.io',
    depositAddress: process.env.TRON_DEPOSIT_ADDRESS || '',
    usdtContract: process.env.TRON_USDT_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', // 메인넷 USDT
    pollInterval: parseInt(process.env.TRON_POLL_INTERVAL || '30000'), // 30초
  },
  // USDT 구독 설정
  usdt: {
    subscriptionAmount: parseFloat(process.env.USDT_SUBSCRIPTION_AMOUNT || '10'), // 월 10 USDT
    subscriptionDays: parseInt(process.env.USDT_SUBSCRIPTION_DAYS || '30'),
    depositExpireHours: parseInt(process.env.USDT_DEPOSIT_EXPIRE_HOURS || '24'),
  },
  // Stripe (카드 결제)
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    successUrl: process.env.STRIPE_SUCCESS_URL || 'http://localhost:3000/settings?success=true',
    cancelUrl: process.env.STRIPE_CANCEL_URL || 'http://localhost:3000/pricing?canceled=true',
    prices: {
      proMonthly: process.env.STRIPE_PRO_MONTHLY_PRICE_ID || '',
      proYearly: process.env.STRIPE_PRO_YEARLY_PRICE_ID || '',
      premiumMonthly: process.env.STRIPE_PREMIUM_MONTHLY_PRICE_ID || '',
      premiumYearly: process.env.STRIPE_PREMIUM_YEARLY_PRICE_ID || '',
    },
  },
};
