-- AlterTable: 자동매수 주문 관계 추가 (FK는 listing_auto_orders에서 선언)

-- CreateTable: 자동매수 설정 (싱글톤 id=1)
CREATE TABLE `listing_auto_trade_config` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `amountKrw` INTEGER NOT NULL DEFAULT 100000,
    `useBinance` BOOLEAN NOT NULL DEFAULT true,
    `useBithumb` BOOLEAN NOT NULL DEFAULT true,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: 자동매수 주문 기록
CREATE TABLE `listing_auto_orders` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `announcementId` INTEGER NOT NULL,
    `exchange` VARCHAR(191) NOT NULL,
    `ticker` VARCHAR(191) NOT NULL,
    `amountKrw` INTEGER NOT NULL,
    `amountUsdt` DOUBLE NULL,
    `orderId` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `filledQty` DOUBLE NULL,
    `filledPrice` DOUBLE NULL,
    `errorMsg` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `listing_auto_orders_announcementId_exchange_key`(`announcementId`, `exchange`),
    INDEX `listing_auto_orders_status_idx`(`status`),
    INDEX `listing_auto_orders_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `listing_auto_orders` ADD CONSTRAINT `listing_auto_orders_announcementId_fkey` FOREIGN KEY (`announcementId`) REFERENCES `upbit_listing_announcements`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Insert default singleton config (id=1)
INSERT INTO `listing_auto_trade_config` (`enabled`, `amountKrw`, `useBinance`, `useBithumb`, `updatedAt`)
VALUES (false, 100000, true, true, NOW());
