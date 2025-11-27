-- CreateTable
CREATE TABLE `users` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `email` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NULL,
    `password` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `users_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bots` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `exchange` ENUM('upbit', 'binance') NOT NULL,
    `ticker` VARCHAR(191) NOT NULL,
    `lowerPrice` DOUBLE NOT NULL,
    `upperPrice` DOUBLE NOT NULL,
    `priceChangePercent` DOUBLE NOT NULL,
    `gridCount` INTEGER NOT NULL,
    `orderAmount` DOUBLE NOT NULL,
    `stopAtMax` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('running', 'stopped', 'error') NOT NULL DEFAULT 'stopped',
    `investmentAmount` DOUBLE NOT NULL DEFAULT 0,
    `currentProfit` DOUBLE NOT NULL DEFAULT 0,
    `totalTrades` INTEGER NOT NULL DEFAULT 0,
    `lastExecutedAt` DATETIME(3) NULL,
    `errorMessage` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `grid_levels` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `botId` INTEGER NOT NULL,
    `price` DOUBLE NOT NULL,
    `type` ENUM('buy', 'sell') NOT NULL,
    `status` ENUM('available', 'pending', 'filled') NOT NULL DEFAULT 'available',
    `orderId` VARCHAR(191) NULL,
    `filledAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `trades` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `botId` INTEGER NOT NULL,
    `gridLevelId` INTEGER NULL,
    `type` ENUM('buy', 'sell') NOT NULL,
    `price` DOUBLE NOT NULL,
    `amount` DOUBLE NOT NULL,
    `total` DOUBLE NOT NULL,
    `profit` DOUBLE NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `executedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `credentials` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `exchange` ENUM('upbit', 'binance') NOT NULL,
    `apiKey` TEXT NOT NULL,
    `secretKey` TEXT NOT NULL,
    `ipWhitelist` VARCHAR(191) NULL,
    `ipRestricted` BOOLEAN NOT NULL DEFAULT false,
    `isValid` BOOLEAN NOT NULL DEFAULT false,
    `lastValidatedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `credentials_userId_exchange_key`(`userId`, `exchange`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `bots` ADD CONSTRAINT `bots_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `grid_levels` ADD CONSTRAINT `grid_levels_botId_fkey` FOREIGN KEY (`botId`) REFERENCES `bots`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trades` ADD CONSTRAINT `trades_botId_fkey` FOREIGN KEY (`botId`) REFERENCES `bots`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trades` ADD CONSTRAINT `trades_gridLevelId_fkey` FOREIGN KEY (`gridLevelId`) REFERENCES `grid_levels`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `credentials` ADD CONSTRAINT `credentials_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
