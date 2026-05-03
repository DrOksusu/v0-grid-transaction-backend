/**
 * Grid-bot-DB 정리 스크립트 — grid_transaction 외 모든 프로젝트 스키마 DROP
 *
 * ⚠️ Grid-bot-DB 전용. 다른 프로젝트는 원본 ls-e143b... 에 있으므로 영향 없음.
 * ⚠️ Lightsail PITR 5분 백업으로 복구 가능.
 *
 * 사용:
 *   npx ts-node scripts/cleanup-other-schemas.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const SCHEMAS_TO_DROP = [
  'ai_analysis',
  'autoblog',
  'building_pt',
  'dba-wing',
  'dbmaster',
  'email_automation',
  'face_recognition',
  'intellij',
  'koco',
  'koco_auth',
  'koco_gateway',
  'okfamily',
  'real_estate',
  'salang_db',
  'space0101',
  'space0101_academy',
  'theone',
  'to_the_moon',
  'tstory_blog',
  'watermark_V2',
  'watermark_db',
];

async function main() {
  const p = new PrismaClient();
  try {
    console.log(`총 ${SCHEMAS_TO_DROP.length}개 스키마 DROP 시작...\n`);
    let ok = 0, fail = 0;

    for (const s of SCHEMAS_TO_DROP) {
      try {
        await p.$executeRawUnsafe('DROP DATABASE IF EXISTS `' + s + '`');
        console.log(`  ✅ DROPPED: ${s}`);
        ok++;
      } catch (e: any) {
        console.log(`  ❌ FAIL: ${s} - ${e.message.split('\n')[0]}`);
        fail++;
      }
    }
    console.log(`\n결과: 성공 ${ok} / 실패 ${fail}\n`);

    const remaining: any = await p.$queryRawUnsafe(
      "SELECT SCHEMA_NAME as name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('information_schema','mysql','performance_schema','sys') ORDER BY SCHEMA_NAME"
    );
    console.log('정리 후 남은 스키마:');
    remaining.forEach((r: any) => console.log('  -', r.name));

    const gridTables: any = await p.$queryRawUnsafe(
      "SELECT COUNT(*) as c FROM information_schema.tables WHERE TABLE_SCHEMA='grid_transaction'"
    );
    console.log(`\ngrid_transaction 테이블 개수: ${Number(gridTables[0].c)} (21이어야 정상)`);
  } finally {
    await p.$disconnect();
  }
}

main().catch(err => {
  console.error('ERROR:', err);
  process.exit(1);
});
