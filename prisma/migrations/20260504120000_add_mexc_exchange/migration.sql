-- AlterEnum: Exchange에 mexc 추가
ALTER TABLE `bots` MODIFY COLUMN `exchange` ENUM('upbit','binance','kis','bithumb','mexc') NOT NULL;
ALTER TABLE `credentials` MODIFY COLUMN `exchange` ENUM('upbit','binance','kis','bithumb','mexc') NOT NULL;
ALTER TABLE `profit_snapshots` MODIFY COLUMN `exchange` ENUM('upbit','binance','kis','bithumb','mexc') NOT NULL DEFAULT 'upbit';
ALTER TABLE `monthly_profits` MODIFY COLUMN `exchange` ENUM('upbit','binance','kis','bithumb','mexc') NOT NULL DEFAULT 'upbit';

-- AlterTable: listing_auto_trade_config에 useMexc 컬럼 추가
ALTER TABLE `listing_auto_trade_config` ADD COLUMN `useMexc` BOOLEAN NOT NULL DEFAULT false;

