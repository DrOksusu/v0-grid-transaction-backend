-- CreateTable
CREATE TABLE `btc_dormant_snapshots` (
    `date` DATE NOT NULL,
    `dormant1yRatio` DECIMAL(6, 5) NOT NULL,
    `dormant2yRatio` DECIMAL(6, 5) NOT NULL,
    `dormant3yRatio` DECIMAL(6, 5) NOT NULL,
    `btcPriceUsd` DECIMAL(20, 8) NOT NULL,
    `rawCoinmetrics` JSON NULL,
    `rawBitcoinData` JSON NULL,
    `reconcileWarning` TINYINT(1) NOT NULL DEFAULT 0,
    `dataSource` VARCHAR(16) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `btc_dormant_snapshots_date_idx`(`date`),
    PRIMARY KEY (`date`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
