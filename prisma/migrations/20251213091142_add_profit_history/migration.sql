-- CreateTable
CREATE TABLE `monthly_profits` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `exchange` ENUM('upbit', 'binance', 'kis') NOT NULL,
    `month` VARCHAR(191) NOT NULL,
    `totalProfit` DOUBLE NOT NULL DEFAULT 0,
    `tradeCount` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `monthly_profits_userId_idx`(`userId`),
    INDEX `monthly_profits_month_idx`(`month`),
    UNIQUE INDEX `monthly_profits_userId_exchange_month_key`(`userId`, `exchange`, `month`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `profit_snapshots` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `exchange` ENUM('upbit', 'binance', 'kis') NOT NULL,
    `ticker` VARCHAR(191) NOT NULL,
    `botType` VARCHAR(191) NOT NULL DEFAULT 'grid',
    `finalProfit` DOUBLE NOT NULL,
    `totalTrades` INTEGER NOT NULL,
    `investmentAmount` DOUBLE NOT NULL,
    `profitPercent` DOUBLE NOT NULL,
    `startedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `runningDays` INTEGER NOT NULL,

    INDEX `profit_snapshots_userId_idx`(`userId`),
    INDEX `profit_snapshots_deletedAt_idx`(`deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `monthly_profits` ADD CONSTRAINT `monthly_profits_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `profit_snapshots` ADD CONSTRAINT `profit_snapshots_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
