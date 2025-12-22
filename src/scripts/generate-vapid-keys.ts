/**
 * VAPID 키 생성 스크립트
 *
 * 실행 방법:
 * npx ts-node src/scripts/generate-vapid-keys.ts
 *
 * 생성된 키를 .env 파일에 추가하세요:
 * VAPID_PUBLIC_KEY=생성된_공개키
 * VAPID_PRIVATE_KEY=생성된_비밀키
 * VAPID_SUBJECT=mailto:your-email@example.com
 */

import webPush from 'web-push';

const vapidKeys = webPush.generateVAPIDKeys();

console.log('\n========== VAPID Keys Generated ==========\n');
console.log('Add these to your .env file:\n');
console.log(`VAPID_PUBLIC_KEY=${vapidKeys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${vapidKeys.privateKey}`);
console.log(`VAPID_SUBJECT=mailto:admin@example.com`);
console.log('\n============================================\n');
