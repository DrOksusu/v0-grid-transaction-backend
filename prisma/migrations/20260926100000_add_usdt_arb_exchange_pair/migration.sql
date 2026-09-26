-- USDT 재고형 아비 봇에 거래소 쌍 컬럼 추가 (기존 봇은 gateio_mexc 유지)
ALTER TABLE `usdt_inventory_arb_bots` ADD COLUMN `exchangePair` VARCHAR(191) NOT NULL DEFAULT 'gateio_mexc';
