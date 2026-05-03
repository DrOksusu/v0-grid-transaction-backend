-- CreateTable
CREATE TABLE `general_arb_watched_symbols` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `symbol` VARCHAR(191) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `general_arb_watched_symbols_symbol_key`(`symbol`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `general_arb_opportunities` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `symbol` VARCHAR(191) NOT NULL,
    `upbitPrice` DECIMAL(20, 2) NOT NULL,
    `bithumbPrice` DECIMAL(20, 2) NOT NULL,
    `spreadPct` DECIMAL(10, 4) NOT NULL,
    `direction` VARCHAR(191) NOT NULL,
    `thresholdPct` DECIMAL(10, 4) NOT NULL,
    `detectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `general_arb_opportunities_symbol_detectedAt_idx`(`symbol`, `detectedAt`),
    INDEX `general_arb_opportunities_detectedAt_idx`(`detectedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `general_arb_config` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `thresholdPct` DECIMAL(10, 4) NOT NULL DEFAULT 0.5000,
    `minIntervalSec` INTEGER NOT NULL DEFAULT 60,
    `isEnabled` BOOLEAN NOT NULL DEFAULT true,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
