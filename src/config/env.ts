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
  // 업비트 후원 설정 (운영자 계정 - 기존 업비트 키 fallback)
  donation: {
    upbitAccessKey: process.env.DONATION_UPBIT_ACCESS_KEY || process.env.UPBIT_ACCESS_KEY || '',
    upbitSecretKey: process.env.DONATION_UPBIT_SECRET_KEY || process.env.UPBIT_SECRET_KEY || '',
    upbitTronAddress: process.env.UPBIT_TRON_ADDRESS || '', // 업비트 USDT(TRC-20) 입금 주소
    // 후원 금액 설정
    krwAmount: parseInt(process.env.DONATION_KRW_AMOUNT || '10000'), // 기본 10,000원
    usdtAmount: parseFloat(process.env.DONATION_USDT_AMOUNT || '10'), // 기본 10 USDT
    // 구독 기간 (일)
    subscriptionDays: parseInt(process.env.DONATION_SUBSCRIPTION_DAYS || '30'),
    // 입금 대기 만료 시간 (시간)
    depositExpireHours: parseInt(process.env.DONATION_DEPOSIT_EXPIRE_HOURS || '24'),
    // 입금 확인 폴링 간격 (ms)
    pollInterval: parseInt(process.env.DONATION_POLL_INTERVAL || '30000'), // 30초
  },
};
