import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 6238 TOTP（HMAC-SHA1、30 秒、6 位數；相容 Google Authenticator / Authy / 1Password）。 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: string, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const off = h[h.length - 1]! & 0xf;
  const code = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(code % 10 ** digits).padStart(digits, '0');
}

export const TOTP_STEP_SEC = 30;

export function totpStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SEC);
}

export function totp(secret: string, nowMs = Date.now()): string {
  return hotp(secret, totpStep(nowMs));
}

/**
 * 驗證 TOTP（容許 ±window 個時間步的時鐘誤差）。回傳吻合的時間步；lastUsedStep 以前（含）的步不接受（防重放）。
 */
export function verifyTotp(secret: string, code: string, opts: { nowMs?: number; window?: number; lastUsedStep?: number | null } = {}): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = totpStep(opts.nowMs);
  const w = opts.window ?? 1;
  for (let d = -w; d <= w; d++) {
    const step = now + d;
    if (opts.lastUsedStep !== undefined && opts.lastUsedStep !== null && step <= opts.lastUsedStep) continue;
    const a = Buffer.from(hotp(secret, step));
    const b = Buffer.from(code);
    if (timingSafeEqual(a, b)) return step;
  }
  return null;
}

export function otpauthUrl(secret: string, account: string, issuer = 'CHIAKI Admin'): string {
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_STEP_SEC}`;
}
