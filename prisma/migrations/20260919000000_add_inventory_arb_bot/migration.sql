-- CreateTable
CREATE TABLE `inventory_arb_bots` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `symbol` VARCHAR(191) NOT NULL,
    `minSpreadBps` INTEGER NOT NULL DEFAULT 30,
    `anomalyMaxBps` INTEGER NOT NULL DEFAULT 2000,
    `maxOrderKrw` DOUBLE NOT NULL,
    `dailyMaxKrw` DOUBLE NULL,
    `dailyMaxCount` INTEGER NULL,
    `fallbackMode` VARCHAR(191) NOT NULL DEFAULT 'market_flatten',
    `autoExecute` BOOLEAN NOT NULL DEFAULT false,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `killSwitch` BOOLEAN NOT NULL DEFAULT false,
    `buyFeeBps` INTEGER NOT NULL DEFAULT 5,
    `lastResumeAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `inventory_arb_bots_userId_enabled_idx`(`userId`, `enabled`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inventory_arb_trades` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `botId` INTEGER NOT NULL,
    `symbol` VARCHAR(191) NOT NULL,
    `direction` VARCHAR(191) NOT NULL,
    `qty` DOUBLE NOT NULL,
    `buyExchange` VARCHAR(191) NOT NULL,
    `buyPrice` DOUBLE NOT NULL,
    `sellExchange` VARCHAR(191) NOT NULL,
    `sellPrice` DOUBLE NOT NULL,
    `notionalKrw` DOUBLE NOT NULL DEFAULT 0,
    `grossKrw` DOUBLE NOT NULL DEFAULT 0,
    `feeKrw` DOUBLE NOT NULL DEFAULT 0,
    `netKrw` DOUBLE NOT NULL DEFAULT 0,
    `status` VARCHAR(191) NOT NULL,
    `note` TEXT NULL,
    `detectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `executedAt` DATETIME(3) NULL,

    INDEX `inventory_arb_trades_botId_executedAt_idx`(`botId`, `executedAt`),
    INDEX `inventory_arb_trades_botId_status_idx`(`botId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
