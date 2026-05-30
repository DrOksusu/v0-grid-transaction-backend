-- 수동 거래 기록 테이블 생성 (평균 취득단가 계산용)
CREATE TABLE `manual_trades` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `ticker` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `price` DECIMAL(20, 2) NOT NULL,
    `quantity` DECIMAL(20, 8) NOT NULL,
    `note` VARCHAR(200) NULL,
    `tradedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `manual_trades_userId_ticker_idx`(`userId`, `ticker`),
    INDEX `manual_trades_userId_ticker_type_idx`(`userId`, `ticker`, `type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- User 테이블과 외래키 연결
ALTER TABLE `manual_trades` ADD CONSTRAINT `manual_trades_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
