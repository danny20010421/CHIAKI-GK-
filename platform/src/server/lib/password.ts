import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * 密碼雜湊：scrypt（N=2^15, r=8, p=1, 32 bytes, 16 bytes salt）。格式 scrypt$N$r$p$saltB64url$hashB64url。
 * 只存雜湊；驗證以 timing-safe 比較。參數寫在雜湊字串內，日後提高成本不影響舊雜湊驗證。
 */
const N = 1 << 15;
const R = 8;
const P = 1;
const KEYLEN = 32;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(password, salt, keylen, opts, (e, k) => (e ? reject(e) : resolve(k))));
}

export const PASSWORD_MIN_LENGTH = 8;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < PASSWORD_MIN_LENGTH) throw new Error(`password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: 128 * N * R * 2 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![n, r, p].every((x) => Number.isInteger(x) && x > 0) || n > 1 << 20) return false;
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  const key = await scrypt(password.normalize('NFKC'), salt, expected.length, { N: n, r, p, maxmem: 128 * n * r * 2 });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** 帳號不存在時也做一次等成本的驗證，避免以回應時間探測帳號是否存在 */
export const DUMMY_HASH = `scrypt$${N}$${R}$${P}$${Buffer.alloc(16).toString('base64url')}$${Buffer.alloc(KEYLEN).toString('base64url')}`;
