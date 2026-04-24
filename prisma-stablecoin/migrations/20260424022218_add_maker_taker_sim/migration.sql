-- CreateTable
CREATE TABLE `maker_taker_sim_bots` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `killSwitch` BOOLEAN NOT NULL DEFAULT false,
    `makerCoin` VARCHAR(191) NOT NULL,
    `takerCoin` VARCHAR(191) NOT NULL,
    `bidOffsetKrw` INTEGER NOT NULL,
    `quantity` DECIMAL(20, 8) NOT NULL,
    `maxPendingMs` INTEGER NOT NULL DEFAULT 3600000,
    `minTakerBidKrw` INTEGER NULL,
    `makerFeeBps` INTEGER NOT NULL DEFAULT 5,
    `takerFeeBps` INTEGER NOT NULL DEFAULT 5,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `maker_taker_sim_trades` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `botId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `makerCoin` VARCHAR(191) NOT NULL,
    `takerCoin` VARCHAR(191) NOT NULL,
    `makerOrderPrice` INTEGER NOT NULL,
    `makerFilledAt` DATETIME(3) NULL,
    `makerFilledPrice` INTEGER NULL,
    `takerExecutedAt` DATETIME(3) NULL,
    `takerMarketBid` INTEGER NULL,
    `takerSlippageBps` INTEGER NULL,
    `quantity` DECIMAL(20, 8) NOT NULL,
    `grossProfitKrw` DECIMAL(18, 4) NULL,
    `feeKrw` DECIMAL(14, 4) NULL,
    `netProfitKrw` DECIMAL(18, 4) NULL,
    `realizedSpreadBps` INTEGER NULL,
    `status` VARCHAR(191) NOT NULL,
    `notes` TEXT NULL,

    INDEX `maker_taker_sim_trades_botId_createdAt_idx`(`botId`, `createdAt`),
    INDEX `maker_taker_sim_trades_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `maker_taker_sim_trades` ADD CONSTRAINT `maker_taker_sim_trades_botId_fkey` FOREIGN KEY (`botId`) REFERENCES `maker_taker_sim_bots`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
