-- CreateTable
CREATE TABLE `upbit_donations` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `currency` ENUM('KRW', 'USDT') NOT NULL,
    `expectedAmount` DOUBLE NOT NULL,
    `status` ENUM('pending', 'confirmed', 'expired') NOT NULL DEFAULT 'pending',
    `txId` VARCHAR(191) NULL,
    `confirmedAmount` DOUBLE NULL,
    `confirmedAt` DATETIME(3) NULL,
    `periodStart` DATETIME(3) NULL,
    `periodEnd` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `upbit_donations_userId_idx`(`userId`),
    INDEX `upbit_donations_status_idx`(`status`),
    INDEX `upbit_donations_currency_status_idx`(`currency`, `status`),
    INDEX `upbit_donations_expectedAmount_currency_status_idx`(`expectedAmount`, `currency`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `upbit_donations` ADD CONSTRAINT `upbit_donations_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
