-- CreateTable
CREATE TABLE `stablecoin_arb_bots` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `killSwitch` BOOLEAN NOT NULL DEFAULT false,
    `coinsEnabled` JSON NOT NULL,
    `entryThresholdBps` INTEGER NOT NULL DEFAULT 20,
    `tradeSizeKrw` INTEGER NOT NULL DEFAULT 50000,
    `perCoinMinUsd` DECIMAL(10, 2) NOT NULL DEFAULT 10,
    `perCoinMaxUsd` DECIMAL(10, 2) NOT NULL DEFAULT 500,
    `depegBps` INTEGER NOT NULL DEFAULT 200,
    `maxDailyTrades` INTEGER NOT NULL DEFAULT 30,
    `dailyLossLimitKrw` INTEGER NOT NULL DEFAULT 50000,
    `totalTrades` INTEGER NOT NULL DEFAULT 0,
    `totalProfitUsd` DECIMAL(14, 6) NOT NULL DEFAULT 0,
    `lastExecutedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `stablecoin_arb_bots_userId_key`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stablecoin_arb_trades` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `botId` INTEGER NOT NULL,
    `soldCoin` VARCHAR(191) NOT NULL,
    `boughtCoin` VARCHAR(191) NOT NULL,
    `detectedAt` DATETIME(3) NOT NULL,
    `bidSoldKrw` DECIMAL(18, 4) NOT NULL,
    `askBoughtKrw` DECIMAL(18, 4) NOT NULL,
    `expectedSpreadBps` INTEGER NOT NULL,
    `plannedSizeCoin` DECIMAL(20, 8) NOT NULL,
    `status` ENUM('DETECTED', 'LEG1_SUBMITTED', 'LEG1_FILLED', 'LEG1_PARTIAL', 'LEG2_SUBMITTED', 'COMPLETED', 'FALLBACK_DONE', 'FAILED', 'ABORTED', 'EMERGENCY') NOT NULL,
    `leg1OrderUuid` VARCHAR(191) NULL,
    `leg1FilledVol` DECIMAL(20, 8) NULL,
    `leg1ReceivedKrw` DECIMAL(20, 4) NULL,
    `leg1FeeKrw` DECIMAL(14, 4) NULL,
    `leg1CompletedAt` DATETIME(3) NULL,
    `leg2OrderUuid` VARCHAR(191) NULL,
    `leg2FilledVol` DECIMAL(20, 8) NULL,
    `leg2SpentKrw` DECIMAL(20, 4) NULL,
    `leg2FeeKrw` DECIMAL(14, 4) NULL,
    `leg2CompletedAt` DATETIME(3) NULL,
    `fallbackOrderUuid` VARCHAR(191) NULL,
    `fallbackFilledVol` DECIMAL(20, 8) NULL,
    `fallbackFeeKrw` DECIMAL(14, 4) NULL,
    `realizedSpreadBps` INTEGER NULL,
    `profitUsd` DECIMAL(12, 6) NULL,
    `totalFeeKrw` DECIMAL(14, 4) NULL,
    `error` TEXT NULL,
    `completedAt` DATETIME(3) NULL,

    INDEX `stablecoin_arb_trades_botId_detectedAt_idx`(`botId`, `detectedAt`),
    INDEX `stablecoin_arb_trades_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stablecoin_arb_opportunities` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `botId` INTEGER NOT NULL,
    `detectedAt` DATETIME(3) NOT NULL,
    `soldCoin` VARCHAR(191) NOT NULL,
    `boughtCoin` VARCHAR(191) NOT NULL,
    `bidSoldKrw` DECIMAL(18, 4) NOT NULL,
    `askBoughtKrw` DECIMAL(18, 4) NOT NULL,
    `spreadBps` INTEGER NOT NULL,
    `executed` BOOLEAN NOT NULL DEFAULT false,
    `skipReason` VARCHAR(191) NULL,

    INDEX `stablecoin_arb_opportunities_botId_detectedAt_idx`(`botId`, `detectedAt`),
    INDEX `stablecoin_arb_opportunities_soldCoin_boughtCoin_detectedAt_idx`(`soldCoin`, `boughtCoin`, `detectedAt`),
    INDEX `stablecoin_arb_opportunities_detectedAt_idx`(`detectedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `stablecoin_arb_trades` ADD CONSTRAINT `stablecoin_arb_trades_botId_fkey` FOREIGN KEY (`botId`) REFERENCES `stablecoin_arb_bots`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stablecoin_arb_opportunities` ADD CONSTRAINT `stablecoin_arb_opportunities_botId_fkey` FOREIGN KEY (`botId`) REFERENCES `stablecoin_arb_bots`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
