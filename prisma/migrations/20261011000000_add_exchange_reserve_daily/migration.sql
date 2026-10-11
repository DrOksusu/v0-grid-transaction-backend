-- CreateTable
CREATE TABLE `exchange_reserve_daily` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `date` DATE NOT NULL,
    `supplyBtc` DECIMAL(20, 8) NOT NULL,
    `inflowBtc` DECIMAL(20, 8) NULL,
    `outflowBtc` DECIMAL(20, 8) NULL,
    `fetchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `exchange_reserve_daily_date_key`(`date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

