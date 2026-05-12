-- CreateTable
CREATE TABLE `coin_transfers` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `fromExchange` VARCHAR(191) NOT NULL,
    `toExchange` VARCHAR(191) NOT NULL,
    `currency` VARCHAR(191) NOT NULL,
    `netType` VARCHAR(191) NOT NULL,
    `amount` DECIMAL(20, 8) NOT NULL,
    `fee` DECIMAL(20, 8) NULL,
    `destAddress` TEXT NOT NULL,
    `secondaryAddress` VARCHAR(191) NULL,
    `state` VARCHAR(191) NOT NULL,
    `srcWithdrawUuid` VARCHAR(191) NULL,
    `errorCode` VARCHAR(191) NULL,
    `errorMessage` TEXT NULL,
    `preparedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `executedAt` DATETIME(3) NULL,

    INDEX `coin_transfers_userId_idx`(`userId`),
    INDEX `coin_transfers_state_idx`(`state`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `coin_transfers` ADD CONSTRAINT `coin_transfers_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
