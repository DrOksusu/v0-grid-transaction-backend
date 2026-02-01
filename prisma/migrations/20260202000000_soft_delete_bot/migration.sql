-- Soft Delete: 봇 삭제 시 실제 삭제하지 않고 deletedAt 타임스탬프 설정
-- 이로 인해 Trade의 botId를 NULL로 만들 필요 없음

-- AddColumn: bots 테이블에 deletedAt 추가
ALTER TABLE `bots` ADD COLUMN `deletedAt` DATETIME(3) NULL;

-- CreateIndex: deletedAt 필터링용 인덱스
CREATE INDEX `bots_deletedAt_idx` ON `bots`(`deletedAt`);

-- 이전 마이그레이션(20250201000000)에서 SetNull로 변경된 외래키를 RESTRICT로 되돌림
-- DropForeignKey: 기존 외래키 삭제
ALTER TABLE `trades` DROP FOREIGN KEY `trades_botId_fkey`;

-- NULL인 botId가 있으면 삭제 (Soft Delete 전에 삭제된 봇의 Trade)
DELETE FROM `trades` WHERE `botId` IS NULL;

-- AlterTable: botId를 NOT NULL로 변경 (Soft Delete로 봇이 실제 삭제되지 않음)
ALTER TABLE `trades` MODIFY `botId` INTEGER NOT NULL;

-- AddForeignKey: 새 외래키 (RESTRICT - 봇 삭제 시 에러, 하지만 Soft Delete라 실제 삭제 없음)
ALTER TABLE `trades` ADD CONSTRAINT `trades_botId_fkey` FOREIGN KEY (`botId`) REFERENCES `bots`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
