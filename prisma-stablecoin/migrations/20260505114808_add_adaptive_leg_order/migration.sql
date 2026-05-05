-- AlterTable
ALTER TABLE `maker_taker_sim_trades` ADD COLUMN `legOrder` VARCHAR(191) NOT NULL DEFAULT 'MAKER_BUY_FIRST',
    ADD COLUMN `takerFirstCostKrw` DECIMAL(18, 4) NULL,
    ADD COLUMN `takerFirstFeeKrw` DECIMAL(14, 4) NULL;
