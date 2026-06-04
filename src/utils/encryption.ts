import crypto from 'crypto';
import { config } from '../config/env';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

// 파생 키 캐시 — 입력(jwt.secret + 'salt')이 상수라 결과 키도 항상 동일.
// scryptSync는 의도적으로 느린 동기 KDF(호출당 수십~수백 ms)라 매 암복호화마다
// 재계산하면 봇 주기 루프에서 이벤트 루프가 주기적으로 블로킹됨 → 1회만 파생해 재사용.
let cachedKey: Buffer | null = null;
const getKey = (): Buffer => {
  if (!cachedKey) {
    cachedKey = crypto.scryptSync(config.jwt.secret, 'salt', 32);
  }
  return cachedKey;
};

export const encrypt = (text: string): string => {
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = getKey();

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
};

export const decrypt = (encryptedText: string): string => {
  const parts = encryptedText.split(':');
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];

  const key = getKey();

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
};

export const maskApiKey = (apiKey: string): string => {
  if (apiKey.length <= 8) return '****';
  return '****-****-****-' + apiKey.slice(-4);
};
