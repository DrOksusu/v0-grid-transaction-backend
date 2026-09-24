-- 매도측 재고 안정화 대기(그리드봇 경합 방지) 컬럼 추가 (기본 60초)
ALTER TABLE `inventory_arb_bots` ADD COLUMN `inventoryStableSec` INTEGER NOT NULL DEFAULT 60;
ALTER TABLE `usdt_inventory_arb_bots` ADD COLUMN `inventoryStableSec` INTEGER NOT NULL DEFAULT 60;
