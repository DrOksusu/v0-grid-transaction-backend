-- Exchange enum에 bithumb 추가
ALTER TABLE `bots` MODIFY COLUMN `exchange` ENUM('upbit', 'binance', 'kis', 'bithumb') NOT NULL;
ALTER TABLE `credentials` MODIFY COLUMN `exchange` ENUM('upbit', 'binance', 'kis', 'bithumb') NOT NULL;
ALTER TABLE `monthly_profits` MODIFY COLUMN `exchange` ENUM('upbit', 'binance', 'kis', 'bithumb') NOT NULL;
ALTER TABLE `profit_snapshots` MODIFY COLUMN `exchange` ENUM('upbit', 'binance', 'kis', 'bithumb') NOT NULL;
