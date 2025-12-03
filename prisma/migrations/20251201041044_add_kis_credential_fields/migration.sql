-- AlterTable
ALTER TABLE `bots` MODIFY `exchange` ENUM('upbit', 'binance', 'kis') NOT NULL;

-- AlterTable
ALTER TABLE `credentials` ADD COLUMN `accessToken` TEXT NULL,
    ADD COLUMN `accountNo` VARCHAR(191) NULL,
    ADD COLUMN `isPaper` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `tokenExpireAt` DATETIME(3) NULL,
    MODIFY `exchange` ENUM('upbit', 'binance', 'kis') NOT NULL;
