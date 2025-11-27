-- AlterTable
ALTER TABLE `trades` ADD COLUMN `filledAt` DATETIME(3) NULL,
    ADD COLUMN `status` ENUM('pending', 'filled', 'cancelled') NOT NULL DEFAULT 'pending';
