-- Add performance indexes for frequently queried tables

-- Bot table indexes
CREATE INDEX `bots_userId_idx` ON `bots`(`userId`);
CREATE INDEX `bots_status_idx` ON `bots`(`status`);
CREATE INDEX `bots_userId_status_idx` ON `bots`(`userId`, `status`);

-- GridLevel table indexes
CREATE INDEX `grid_levels_botId_idx` ON `grid_levels`(`botId`);
CREATE INDEX `grid_levels_botId_status_idx` ON `grid_levels`(`botId`, `status`);
CREATE INDEX `grid_levels_status_idx` ON `grid_levels`(`status`);

-- Trade table indexes
CREATE INDEX `trades_botId_idx` ON `trades`(`botId`);
CREATE INDEX `trades_botId_status_idx` ON `trades`(`botId`, `status`);
CREATE INDEX `trades_gridLevelId_idx` ON `trades`(`gridLevelId`);

-- Credential table indexes
CREATE INDEX `credentials_userId_idx` ON `credentials`(`userId`);
CREATE INDEX `credentials_userId_exchange_idx` ON `credentials`(`userId`, `exchange`);
