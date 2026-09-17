-- AlterTable
ALTER TABLE `bots` ADD COLUMN `profitMode` VARCHAR(191) NOT NULL DEFAULT 'fixed_amount';

-- AlterTable
ALTER TABLE `grid_levels` ADD COLUMN `filledQty` DOUBLE NULL;

