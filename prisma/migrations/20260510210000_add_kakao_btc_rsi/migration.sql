-- 카카오 OAuth 토큰 저장 테이블
CREATE TABLE `kakao_tokens` (
  `id`           INT          NOT NULL DEFAULT 1,
  `accessToken`  LONGTEXT     NOT NULL,
  `refreshToken` LONGTEXT     NOT NULL,
  `expiresAt`    DATETIME(3)  NOT NULL,
  `createdAt`    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`    DATETIME(3)  NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- BTC RSI 다이버전스 알림 이력
CREATE TABLE `btc_rsi_alerts` (
  `id`         INT          NOT NULL AUTO_INCREMENT,
  `rsiValue`   DOUBLE       NOT NULL,
  `priceValue` DOUBLE       NOT NULL,
  `alertType`  VARCHAR(191) NOT NULL DEFAULT 'bullish_divergence',
  `message`    LONGTEXT     NOT NULL,
  `sentAt`     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `btc_rsi_alerts_sentAt_idx` (`sentAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
