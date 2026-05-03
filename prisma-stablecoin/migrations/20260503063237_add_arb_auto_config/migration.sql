-- CreateTable
CREATE TABLE `arb_auto_config` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `bithumbEnabled` BOOLEAN NOT NULL DEFAULT false,
    `bithumbCoins` JSON NOT NULL,
    `bithumbQty` INTEGER NOT NULL DEFAULT 10,
    `bithumbMinSpreadBps` INTEGER NOT NULL DEFAULT 10,
    `bithumbDailyCountLimit` INTEGER NOT NULL DEFAULT 20,
    `bithumbDailyLossLimitKrw` INTEGER NOT NULL DEFAULT 50000,
    `upbitEnabled` BOOLEAN NOT NULL DEFAULT false,
    `crossEnabled` BOOLEAN NOT NULL DEFAULT false,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bithumb_single_arb_trades` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `coinSell` VARCHAR(191) NOT NULL,
    `coinBuy` VARCHAR(191) NOT NULL,
    `qty` DECIMAL(20, 8) NOT NULL,
    `spreadBpsAtExec` INTEGER NOT NULL,
    `legASellOrderId` VARCHAR(191) NULL,
    `legAFilledQty` DECIMAL(20, 8) NULL,
    `legAAvgPriceKrw` DECIMAL(18, 4) NULL,
    `legAFeeKrw` DECIMAL(18, 4) NULL,
    `legAReceivedKrw` DECIMAL(18, 4) NULL,
    `legBBuyOrderId` VARCHAR(191) NULL,
    `legBFilledQty` DECIMAL(20, 8) NULL,
    `legBAvgPriceKrw` DECIMAL(18, 4) NULL,
    `legBFeeKrw` DECIMAL(18, 4) NULL,
    `legBSpentKrw` DECIMAL(18, 4) NULL,
    `profitKrw` DECIMAL(18, 4) NULL,
    `status` VARCHAR(191) NOT NULL,
    `failureReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,

    INDEX `bithumb_single_arb_trades_createdAt_idx`(`createdAt`),
    INDEX `bithumb_single_arb_trades_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
