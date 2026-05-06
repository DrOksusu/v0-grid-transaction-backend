-- 신규상장 자동매도 기능 추가
-- ListingAutoTradeConfig: 자동매도 설정 필드 추가
ALTER TABLE `listing_auto_trade_config`
  ADD COLUMN `autoSellEnabled` BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN `takeProfitPct`   DOUBLE  NOT NULL DEFAULT 20,
  ADD COLUMN `stopLossPct`     DOUBLE  NOT NULL DEFAULT 10,
  ADD COLUMN `maxHoldMinutes`  INTEGER NOT NULL DEFAULT 30;

-- ListingAutoOrder: 자동매도 결과 필드 추가
ALTER TABLE `listing_auto_orders`
  ADD COLUMN `sellReason`   VARCHAR(191)  NULL,
  ADD COLUMN `sellStatus`   VARCHAR(191)  NULL,
  ADD COLUMN `sellOrderId`  VARCHAR(191)  NULL,
  ADD COLUMN `sellFilledQty` DOUBLE       NULL,
  ADD COLUMN `sellAvgPrice`  DOUBLE       NULL,
  ADD COLUMN `profitPct`     DOUBLE       NULL,
  ADD COLUMN `soldAt`        DATETIME(3)  NULL,
  ADD COLUMN `sellErrorMsg`  LONGTEXT     NULL;

-- sellStatus 인덱스 추가
CREATE INDEX `listing_auto_orders_sellStatus_idx` ON `listing_auto_orders`(`sellStatus`);
