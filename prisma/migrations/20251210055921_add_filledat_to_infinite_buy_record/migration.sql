-- AlterTable
ALTER TABLE `infinite_buy_records` ADD COLUMN `filledAt` DATETIME(3) NULL,
    MODIFY `orderStatus` VARCHAR(191) NOT NULL DEFAULT 'pending';
