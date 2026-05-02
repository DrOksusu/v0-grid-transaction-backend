-- CreateTable
CREATE TABLE `cross_exchange_arb_bots` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `killSwitch` BOOLEAN NOT NULL DEFAULT false,
    `coin` VARCHAR(191) NOT NULL,
    `targetDirection` VARCHAR(191) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `minSpreadBps` INTEGER NOT NULL DEFAULT 50,
    `depegMinKrw` INTEGER NOT NULL DEFAULT 1380,
    `depegMaxKrw` INTEGER NOT NULL DEFAULT 1420,
    `liquidityMultiplier` DOUBLE NOT NULL DEFAULT 1.5,
    `dailyCountLimit` INTEGER NOT NULL DEFAULT 5,
    `dailyLossLimitKrw` INTEGER NOT NULL DEFAULT 50000,
    `lastResumeAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cross_exchange_arb_trades` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `botId` INTEGER NOT NULL,
    `direction` VARCHAR(191) NOT NULL,
    `spreadBpsAtPlacement` INTEGER NOT NULL,
    `legAExchange` VARCHAR(191) NOT NULL,
    `legASide` VARCHAR(191) NOT NULL,
    `legAOrderId` VARCHAR(191) NULL,
    `legAFilledQty` DECIMAL(24, 8) NULL,
    `legAAvgPrice` DECIMAL(18, 4) NULL,
    `legAFeeKrw` DECIMAL(18, 4) NULL,
    `legBExchange` VARCHAR(191) NOT NULL,
    `legBSide` VARCHAR(191) NOT NULL,
    `legBOrderId` VARCHAR(191) NULL,
    `legBFilledQty` DECIMAL(24, 8) NULL,
    `legBAvgPrice` DECIMAL(18, 4) NULL,
    `legBFeeKrw` DECIMAL(18, 4) NULL,
    `profitKrw` DECIMAL(18, 4) NULL,
    `status` VARCHAR(191) NOT NULL,
    `failureReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,

    INDEX `cross_exchange_arb_trades_botId_createdAt_idx`(`botId`, `createdAt`),
    INDEX `cross_exchange_arb_trades_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `cross_exchange_arb_trades` ADD CONSTRAINT `cross_exchange_arb_trades_botId_fkey` FOREIGN KEY (`botId`) REFERENCES `cross_exchange_arb_bots`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
