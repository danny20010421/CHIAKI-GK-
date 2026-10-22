import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../../errors';
import { config } from '../../config';
import { db, transaction, type Db } from '../../db';
import { appendAudit } from '../audit/audit';
import { ensureWallet } from '../wallet/wallet';
import { recordDevice } from '../risk/risk';
import { otpProvider } from './providers';
import type { Principal, Role } from './rbac';

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export async function createUser(
  d: Db,
  u: { phone?: string | null; displayName?: string; roles?: Role[]; merchantId?: string },
): Promise<{ id: string }> {
  const [row] = await d<{ id: string }[]>`
    INSERT INTO users (phone, display_name) VALUES (${u.phone ?? null}, ${u.displayName ?? ''}) RETURNING id`;
  const roles: Role[] = u.roles?.length ? u.roles : ['MEMBER'];
  for (const r of roles) {
    await d`INSERT INTO user_roles (user_id, role, merchant_id) VALUES (${row!.id}, ${r}, ${u.merchantId ?? 'chiaki'})`;
  }
  await ensureWallet(d, row!.id, u.merchantId);
  return row!;
}

export async function createSession(d: Db, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const ttlDays = config().SESSION_TTL_DAYS;
  await d`INSERT INTO auth_sessions (token_hash, user_id, expires_at)
          VALUES (${hashToken(token)}, ${userId}, now() + make_interval(days => ${ttlDays}))`;
  return token;
}

export async function revokeSession(d: Db, token: string): Promise<void> {
  await d`UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = ${hashToken(token)}`;
}

export async function authenticate(d: Db, token: string): Promise<Principal | null> {
  const rows = await d<{ userId: string; status: string; ageVerifiedAt: Date | null; roles: Role[] }[]>`
    SELECT u.id AS user_id, u.status, u.age_verified_at,
           COALESCE(array_agg(r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles
    FROM auth_sessions s JOIN users u ON u.id = s.user_id LEFT JOIN user_roles r ON r.user_id = u.id
    WHERE s.token_hash = ${hashToken(token)} AND s.revoked_at IS NULL AND s.expires_at > now()
    GROUP BY u.id`;
  const r = rows[0];
  if (!r || r.status !== 'ACTIVE') return null;
  return { userId: r.userId, roles: r.roles, ageVerified: r.ageVerifiedAt !== null };
}

export async function requestOtp(phone: string): Promise<void> {
  await otpProvider().send(phone);
}

/** 手機 OTP 登入（不存在則建立會員＋錢包），並記錄裝置指紋供風控。 */
export async function loginWithOtp(phone: string, code: string, deviceFingerprint?: string): Promise<{ token: string; userId: string; isNew: boolean }> {
  const ok = await otpProvider().verify(phone, code);
  if (!ok) throw new AppError('UNAUTHENTICATED', 'invalid OTP');
  const result = await transaction(async (tx) => {
    const [existing] = await tx<{ id: string; status: string }[]>`SELECT id, status FROM users WHERE phone = ${phone}`;
    if (existing && existing.status !== 'ACTIVE') throw new AppError('FORBIDDEN', 'account suspended');
    const isNew = !existing;
    const user = existing ?? (await createUser(tx, { phone }));
    const token = await createSession(tx, user.id);
    if (isNew) {
      await appendAudit(tx, { actorType: 'USER', actorId: user.id, action: 'USER_REGISTERED', entityType: 'user', entityId: user.id });
    }
    return { token, userId: user.id, isNew };
  });
  if (deviceFingerprint) await recordDevice(db(), result.userId, deviceFingerprint);
  return result;
}

function ageOn(birth: string, today: Date): number {
  const [y, m, d] = birth.split('-').map(Number) as [number, number, number];
  // 以台灣時區計算當日
  const tw = new Date(today.getTime() + 8 * 3600_000);
  const ty = tw.getUTCFullYear();
  const tm = tw.getUTCMonth() + 1;
  const td = tw.getUTCDate();
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}

/**
 * 年齡/身分驗證（替身）：目前以自填生日判定是否達 AGE_MIN。
 * 正式驗證方式（實名/證件/第三方）與年齡門檻待法務定案。首次付費抽賞前必須完成。
 */
export async function verifyAge(userId: string, birthDate: string, now = new Date()): Promise<{ verified: true; age: number }> {
  const age = ageOn(birthDate, now);
  if (age < config().AGE_MIN) throw new AppError('FORBIDDEN', `未滿 ${config().AGE_MIN} 歲不得參與付費抽賞`, { age });
  await transaction(async (tx) => {
    await tx`UPDATE users SET birth_date = ${birthDate}, age_verified_at = COALESCE(age_verified_at, now()) WHERE id = ${userId}`;
    await appendAudit(tx, { actorType: 'USER', actorId: userId, action: 'AGE_VERIFIED', entityType: 'user', entityId: userId, payload: { method: 'self_declared_stub' } });
  });
  return { verified: true, age };
}
