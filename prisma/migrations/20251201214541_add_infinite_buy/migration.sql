-- CreateTable
CREATE TABLE `infinite_buy_stocks` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `ticker` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `exchange` VARCHAR(191) NOT NULL DEFAULT 'NAS',
    `buyAmount` DOUBLE NOT NULL,
    `totalRounds` INTEGER NOT NULL DEFAULT 40,
    `targetProfit` DOUBLE NOT NULL DEFAULT 10,
    `status` ENUM('buying', 'completed', 'stopped') NOT NULL DEFAULT 'buying',
    `currentRound` INTEGER NOT NULL DEFAULT 0,
    `totalInvested` DOUBLE NOT NULL DEFAULT 0,
    `totalQuantity` DOUBLE NOT NULL DEFAULT 0,
    `avgPrice` DOUBLE NOT NULL DEFAULT 0,
    `autoEnabled` BOOLEAN NOT NULL DEFAULT true,
    `buyTime` VARCHAR(191) NULL,
    `buyCondition` VARCHAR(191) NOT NULL DEFAULT 'daily',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `completedAt` DATETIME(3) NULL,

    INDEX `infinite_buy_stocks_userId_idx`(`userId`),
    INDEX `infinite_buy_stocks_status_idx`(`status`),
    UNIQUE INDEX `infinite_buy_stocks_userId_ticker_key`(`userId`, `ticker`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `infinite_buy_records` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `stockId` INTEGER NOT NULL,
    `type` ENUM('buy', 'sell') NOT NULL,
    `round` INTEGER NULL,
    `price` DOUBLE NOT NULL,
    `quantity` DOUBLE NOT NULL,
    `amount` DOUBLE NOT NULL,
    `profit` DOUBLE NULL,
    `profitPercent` DOUBLE NULL,
    `orderId` VARCHAR(191) NULL,
    `orderStatus` VARCHAR(191) NOT NULL DEFAULT 'filled',
    `executedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `infinite_buy_records_stockId_idx`(`stockId`),
    INDEX `infinite_buy_records_type_idx`(`type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `infinite_buy_stocks` ADD CONSTRAINT `infinite_buy_stocks_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `infinite_buy_records` ADD CONSTRAINT `infinite_buy_records_stockId_fkey` FOREIGN KEY (`stockId`) REFERENCES `infinite_buy_stocks`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
