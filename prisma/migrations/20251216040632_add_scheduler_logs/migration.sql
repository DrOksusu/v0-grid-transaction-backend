-- CreateTable
CREATE TABLE `scheduler_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `type` ENUM('auto_buy', 'strategy1_buy', 'price_check', 'order_check') NOT NULL,
    `status` ENUM('started', 'completed', 'skipped', 'error') NOT NULL,
    `stockId` INTEGER NULL,
    `ticker` VARCHAR(191) NULL,
    `message` TEXT NOT NULL,
    `details` TEXT NULL,
    `errorMessage` TEXT NULL,
    `executedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `scheduler_logs_type_idx`(`type`),
    INDEX `scheduler_logs_status_idx`(`status`),
    INDEX `scheduler_logs_executedAt_idx`(`executedAt`),
    INDEX `scheduler_logs_stockId_idx`(`stockId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
