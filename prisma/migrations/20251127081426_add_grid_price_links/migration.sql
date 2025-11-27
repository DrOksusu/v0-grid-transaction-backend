-- AlterTable
ALTER TABLE `grid_levels` ADD COLUMN `buyPrice` DOUBLE NULL,
    ADD COLUMN `sellPrice` DOUBLE NULL,
    MODIFY `status` ENUM('available', 'pending', 'filled', 'inactive') NOT NULL DEFAULT 'available';
