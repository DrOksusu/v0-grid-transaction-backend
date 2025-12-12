-- AlterTable: Add strategy column to infinite_buy_stocks
ALTER TABLE `infinite_buy_stocks` ADD COLUMN `strategy` ENUM('basic', 'strategy1') NOT NULL DEFAULT 'basic';

-- AlterTable: Add LOC order fields to infinite_buy_records
ALTER TABLE `infinite_buy_records`
  ADD COLUMN `orderType` VARCHAR(191) NOT NULL DEFAULT 'market',
  ADD COLUMN `targetPrice` DOUBLE NULL,
  ADD COLUMN `orderSubType` VARCHAR(191) NULL;
