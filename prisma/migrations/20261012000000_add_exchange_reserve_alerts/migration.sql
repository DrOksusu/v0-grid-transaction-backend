-- CreateTable
CREATE TABLE `exchange_reserve_alert_config` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `cooldownDays` INTEGER NOT NULL DEFAULT 7,
    `lookbackDays` INTEGER NOT NULL DEFAULT 365,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `exchange_reserve_alerts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `dataDate` DATE NOT NULL,
    `supplyBtc` DECIMAL(20, 8) NOT NULL,
    `prevLowBtc` DECIMAL(20, 8) NOT NULL,
    `newLowCount` INTEGER NOT NULL,
    `message` TEXT NOT NULL,
    `sentAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `exchange_reserve_alerts_sentAt_idx`(`sentAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

