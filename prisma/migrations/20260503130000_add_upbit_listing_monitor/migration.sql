-- CreateTable
CREATE TABLE `upbit_listing_announcements` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `noticeId` INTEGER NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `ticker` VARCHAR(191) NULL,
    `url` VARCHAR(191) NOT NULL,
    `announcedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `listedAt` DATETIME(3) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'announced',

    UNIQUE INDEX `upbit_listing_announcements_noticeId_key`(`noticeId`),
    INDEX `upbit_listing_announcements_announcedAt_idx`(`announcedAt`),
    INDEX `upbit_listing_announcements_ticker_idx`(`ticker`),
    INDEX `upbit_listing_announcements_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `listing_price_snapshots` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `announcementId` INTEGER NOT NULL,
    `exchange` VARCHAR(191) NOT NULL,
    `price` DECIMAL(30, 8) NOT NULL,
    `volume24h` DECIMAL(30, 4) NULL,
    `snapshotType` VARCHAR(191) NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `listing_price_snapshots_announcementId_idx`(`announcementId`),
    INDEX `listing_price_snapshots_announcementId_snapshotType_idx`(`announcementId`, `snapshotType`),
    INDEX `listing_price_snapshots_exchange_snapshotType_idx`(`exchange`, `snapshotType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `listing_price_snapshots` ADD CONSTRAINT `listing_price_snapshots_announcementId_fkey` FOREIGN KEY (`announcementId`) REFERENCES `upbit_listing_announcements`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
