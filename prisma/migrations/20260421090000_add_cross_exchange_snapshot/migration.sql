-- CreateTable
CREATE TABLE `cross_exchange_snapshots` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `timestamp` DATETIME(3) NOT NULL,
    `market` VARCHAR(191) NOT NULL,
    `upbitBid` DECIMAL(18, 4) NOT NULL,
    `upbitAsk` DECIMAL(18, 4) NOT NULL,
    `bithumbBid` DECIMAL(18, 4) NOT NULL,
    `bithumbAsk` DECIMAL(18, 4) NOT NULL,
    `ubSpreadBps` INTEGER NOT NULL,
    `buSpreadBps` INTEGER NOT NULL,
    `maxSpreadBps` INTEGER NOT NULL,

    INDEX `cross_exchange_snapshots_timestamp_idx`(`timestamp`),
    INDEX `cross_exchange_snapshots_market_timestamp_idx`(`market`, `timestamp`),
    INDEX `cross_exchange_snapshots_maxSpreadBps_idx`(`maxSpreadBps`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

