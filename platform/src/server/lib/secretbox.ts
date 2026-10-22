import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config';

/**
 * 以 AES-256-GCM 加密小型機密（例如 TOTP 秘密金鑰）。金鑰 MFA_ENCRYPTION_KEY：32 bytes 的 hex（64 字）或 base64。
 * 非 production 未設定時使用固定的開發金鑰（production 啟動檢查會要求必填）。
 */
function key(): Buffer {
  const raw = config().MFA_ENCRYPTION_KEY;
  if (!raw) return createHash('sha256').update('chiaki-dev-only-mfa-key').digest();
  const k = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (k.length !== 32) throw new Error('MFA_ENCRYPTION_KEY must be 32 bytes (hex or base64)');
  return k;
}

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${ct.toString('base64url')}`;
}

export function open(sealed: string): string {
  const [v, iv, tag, ct] = sealed.split(':');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('invalid sealed value');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
