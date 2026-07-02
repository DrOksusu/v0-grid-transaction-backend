-- Add clientOrderId column to grid_levels for Toss idempotency (spec § 13)
ALTER TABLE `grid_levels` ADD COLUMN `clientOrderId` VARCHAR(64) NULL;
