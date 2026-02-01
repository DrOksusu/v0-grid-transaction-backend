-- DropForeignKey
ALTER TABLE `trades` DROP FOREIGN KEY `trades_botId_fkey`;

-- AlterTable
ALTER TABLE `trades` ADD COLUMN `exchange` VARCHAR(191) NULL,
    ADD COLUMN `ticker` VARCHAR(191) NULL,
    MODIFY `botId` INTEGER NULL;

-- CreateTable (password_resets - 비밀번호 재설정용)
CREATE TABLE IF NOT EXISTS `password_resets` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `token` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `password_resets_token_key`(`token`),
    INDEX `password_resets_token_idx`(`token`),
    INDEX `password_resets_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `trades_ticker_idx` ON `trades`(`ticker`);

-- AddForeignKey (password_resets)
ALTER TABLE `password_resets` ADD CONSTRAINT `password_resets_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (trades - SetNull로 변경)
ALTER TABLE `trades` ADD CONSTRAINT `trades_botId_fkey` FOREIGN KEY (`botId`) REFERENCES `bots`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
