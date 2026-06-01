-- AlterTable
ALTER TABLE `listing_auto_trade_config`
  ADD COLUMN `useTrailingStop` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `trailingStopPct` DOUBLE NOT NULL DEFAULT 20;
