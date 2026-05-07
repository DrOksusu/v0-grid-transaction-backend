-- minSpreadKrw(절댓값 KRW) → minSpreadBps(상대값 bp) 교체
-- 기존 12 KRW ≈ 82bp를 사용하던 모든 봇을 20bp로 초기화 (수수료 10bp + 여유 10bp)
ALTER TABLE `maker_taker_sim_bots` ADD COLUMN `minSpreadBps` INTEGER NOT NULL DEFAULT 20;
ALTER TABLE `maker_taker_sim_bots` DROP COLUMN `minSpreadKrw`;
