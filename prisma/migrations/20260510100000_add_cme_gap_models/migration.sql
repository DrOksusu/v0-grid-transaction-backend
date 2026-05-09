-- CME 갭 매매 봇 설정 테이블
CREATE TABLE `cme_gap_bots` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL DEFAULT 'BTC CME 갭 봇',
    `quantity` DECIMAL(10, 6) NOT NULL,
    `minGapPct` DECIMAL(5, 2) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `live` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CME 갭 감지 이력 및 상태 테이블
CREATE TABLE `cme_gaps` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `botId` INTEGER NOT NULL,
    `weekKey` VARCHAR(191) NOT NULL,
    `detectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `fridayCloseKrw` DECIMAL(20, 2) NOT NULL,
    `mondayOpenKrw` DECIMAL(20, 2) NOT NULL,
    `gapPct` DECIMAL(6, 3) NOT NULL,
    `direction` VARCHAR(191) NOT NULL,
    `gapHiKrw` DECIMAL(20, 2) NOT NULL,
    `gapLoKrw` DECIMAL(20, 2) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'watching',
    `entryPrice` DECIMAL(20, 2) NULL,
    `entryOrderId` VARCHAR(191) NULL,
    `entryFilledQty` DECIMAL(10, 6) NULL,
    `tpPrice` DECIMAL(20, 2) NULL,
    `tpOrderId` VARCHAR(191) NULL,
    `exitPrice` DECIMAL(20, 2) NULL,
    `exitFilledQty` DECIMAL(10, 6) NULL,
    `pnlKrw` DECIMAL(20, 2) NULL,
    `pnlPct` DECIMAL(6, 3) NULL,
    `enteredAt` DATETIME(3) NULL,
    `closedAt` DATETIME(3) NULL,

    INDEX `cme_gaps_botId_status_idx`(`botId`, `status`),
    INDEX `cme_gaps_status_idx`(`status`),
    INDEX `cme_gaps_weekKey_idx`(`weekKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 외래키 제약 추가
ALTER TABLE `cme_gaps` ADD CONSTRAINT `cme_gaps_botId_fkey` FOREIGN KEY (`botId`) REFERENCES `cme_gap_bots`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
