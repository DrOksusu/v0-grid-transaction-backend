-- CreateTable
CREATE TABLE `usdt_inventory_arb_bots` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `symbol` VARCHAR(191) NOT NULL DEFAULT 'ALEO',
    `buyExchange` VARCHAR(191) NOT NULL DEFAULT 'gateio',
    `sellExchange` VARCHAR(191) NOT NULL DEFAULT 'mexc',
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `autoExecute` BOOLEAN NOT NULL DEFAULT false,
    `thresholdPct` DOUBLE NOT NULL DEFAULT 2,
    `orderUsdt` DOUBLE NOT NULL DEFAULT 10,
    `dailyMaxCount` INTEGER NULL DEFAULT 200,
    `dailyMaxLossUsdt` DOUBLE NULL DEFAULT 5,
    `killSwitch` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `usdt_inventory_arb_bots_userId_enabled_idx`(`userId`, `enabled`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `usdt_inventory_arb_trades` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `botId` INTEGER NOT NULL,
    `symbol` VARCHAR(191) NOT NULL,
    `buyExchange` VARCHAR(191) NOT NULL,
    `sellExchange` VARCHAR(191) NOT NULL,
    `qty` DOUBLE NOT NULL,
    `buyPrice` DOUBLE NOT NULL,
    `sellPrice` DOUBLE NOT NULL,
    `buyFilled` DOUBLE NOT NULL DEFAULT 0,
    `sellFilled` DOUBLE NOT NULL DEFAULT 0,
    `grossUsdt` DOUBLE NOT NULL DEFAULT 0,
    `feeUsdt` DOUBLE NOT NULL DEFAULT 0,
    `netUsdt` DOUBLE NOT NULL DEFAULT 0,
    `status` VARCHAR(191) NOT NULL,
    `flattenSide` VARCHAR(191) NULL,
    `note` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `usdt_inventory_arb_trades_botId_createdAt_idx`(`botId`, `createdAt`),
    INDEX `usdt_inventory_arb_trades_botId_status_idx`(`botId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
