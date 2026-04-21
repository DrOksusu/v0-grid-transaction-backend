-- AlterTable: detectedAt을 TIMESTAMP(3) -> DATETIME(3)로 통일 (타임존 의존성 및 2038 오버플로 회피)
ALTER TABLE `stablecoin_arb_opportunities` MODIFY `detectedAt` DATETIME(3) NOT NULL;

-- CreateIndex: 7일 보관 cleanup 쿼리 가속을 위한 단독 인덱스
CREATE INDEX `stablecoin_arb_opportunities_detectedAt_idx` ON `stablecoin_arb_opportunities`(`detectedAt`);
