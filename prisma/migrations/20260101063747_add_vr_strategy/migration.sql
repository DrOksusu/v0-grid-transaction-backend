-- AlterTable
ALTER TABLE `infinite_buy_records` ADD COLUMN `vrOrderIndex` INTEGER NULL,
    ADD COLUMN `vrTargetBand` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `infinite_buy_stocks` ADD COLUMN `vrBandPercent` DOUBLE NULL DEFAULT 15,
    ADD COLUMN `vrCycleStartDate` DATETIME(3) NULL,
    ADD COLUMN `vrCycleWeeks` INTEGER NULL DEFAULT 2,
    ADD COLUMN `vrDepositAmount` DOUBLE NULL,
    ADD COLUMN `vrGradient` INTEGER NULL DEFAULT 10,
    ADD COLUMN `vrLastCycleDate` DATETIME(3) NULL,
    ADD COLUMN `vrPool` DOUBLE NULL,
    ADD COLUMN `vrStyle` VARCHAR(191) NULL,
    ADD COLUMN `vrValue` DOUBLE NULL,
    MODIFY `strategy` ENUM('basic', 'strategy1', 'vr') NOT NULL DEFAULT 'basic';

-- AlterTable
ALTER TABLE `scheduler_logs` MODIFY `type` ENUM('auto_buy', 'strategy1_buy', 'vr_cycle', 'vr_order', 'price_check', 'order_check') NOT NULL;
