-- 재고 되돌림 리컴실러: 대형코인 제외 토글 (기본 true=제외)
ALTER TABLE `arb_reclaim_configs` ADD COLUMN `excludeMajors` BOOLEAN NOT NULL DEFAULT true;
