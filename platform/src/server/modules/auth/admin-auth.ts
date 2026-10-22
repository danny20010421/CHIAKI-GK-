import { z } from 'zod';
import { AppError } from '../../errors';
import { config } from '../../config';
import { db, transaction, type Db } from '../../db';
import { DUMMY_HASH, hashPassword, PASSWORD_MIN_LENGTH, verifyPassword } from '../../lib/password';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../../lib/totp';
import { open, seal } from '../../lib/secretbox';
import { appendAudit } from '../audit/audit';
import { assertNotLocked, clearLoginFailures, recordLoginFailure } from '../../security/lockout';
import { createSession, hashToken } from './users';
import type { Principal, Role } from './rbac';

/**
 * 後台帳號密碼登入（scrypt 雜湊；密碼明文永不落地、永不進版控）＋ 選用的 TOTP 兩步驟驗證。
 *  - 登入成功 → auth_method=PASSWORD 的 session（12 小時），reauth_at = now()。
 *  - 後台 API 需要「近期重新驗證」（ADMIN_REAUTH_MAX_AGE_MIN，預設 30 分鐘）→ POST /api/admin/auth/reauth 重新輸入密碼（＋TOTP）。
 *  - ADMIN_MFA_REQUIRED=true 時：未綁定 MFA 的帳號登入後只能使用 MFA 綁定端點；已綁定者登入必須提供 TOTP。
 */
export const AdminLoginSchema = z.object({
  loginId: z.string().min(3).max(64).transform((s) => s.trim().toLowerCase()),
  password: z.string().min(1).max(200),
  totp: z.string().regex(/^\d{6}$/).optional(),
});

const lockKey = (loginId: string) => `admin:${loginId}`;

interface CredRow {
  userId: string;
  loginId: string;
  passwordHash: string;
  mfaSecretEnc: string | null;
  mfaEnabledAt: Date | null;
  mfaLastStep: number | null;
  status: string;
  roles: Role[];
}

async function loadCred(d: Db, by: { loginId?: string; userId?: string }): Promise<CredRow | null> {
  const rows = await d<CredRow[]>`
    SELECT ac.user_id, ac.login_id, ac.password_hash, ac.mfa_secret_enc, ac.mfa_enabled_at, ac.mfa_last_step, u.status,
           COALESCE(array_agg(r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles
    FROM admin_credentials ac JOIN users u ON u.id = ac.user_id LEFT JOIN user_roles r ON r.user_id = u.id
    WHERE ${by.loginId ? d`ac.login_id = ${by.loginId}` : d`ac.user_id = ${by.userId!}`}
    GROUP BY ac.user_id, u.status`;
  return rows[0] ?? null;
}

async function checkTotp(cred: CredRow, code: string | undefined): Promise<'OK' | 'MISSING' | 'BAD'> {
  if (!cred.mfaEnabledAt || !cred.mfaSecretEnc) return 'OK';
  if (!code) return 'MISSING';
  const step = verifyTotp(open(cred.mfaSecretEnc), code, { lastUsedStep: cred.mfaLastStep });
  if (step === null) return 'BAD';
  // 防重放：同一時間步的驗證碼只能用一次（條件式更新，並發時只有一個成功）
  const upd = await db()`UPDATE admin_credentials SET mfa_last_step = ${step}
                         WHERE user_id = ${cred.userId} AND (mfa_last_step IS NULL OR mfa_last_step < ${step}) RETURNING user_id`;
  return upd.length ? 'OK' : 'BAD';
}

export async function adminLogin(input: z.input<typeof AdminLoginSchema>, meta: { ip?: string | null } = {}) {
  const v = AdminLoginSchema.parse(input);
  const key = lockKey(v.loginId);
  await assertNotLocked(key);
  const cred = await loadCred(db(), { loginId: v.loginId });
  const pwOk = await verifyPassword(v.password, cred?.passwordHash ?? DUMMY_HASH);
  const staff = cred?.roles.some((r) => r !== 'MEMBER') ?? false;
  if (!cred || !pwOk || cred.status !== 'ACTIVE' || !staff) {
    await recordLoginFailure(key, { ip: meta.ip, userId: cred?.userId ?? null });
    throw new AppError('INVALID_CREDENTIALS', '帳號或密碼錯誤');
  }
  const t = await checkTotp(cred, v.totp);
  if (t === 'MISSING') throw new AppError('MFA_REQUIRED', '請輸入兩步驟驗證碼', { mfa: 'TOTP' });
  if (t === 'BAD') {
    await recordLoginFailure(key, { ip: meta.ip, userId: cred.userId });
    throw new AppError('INVALID_CREDENTIALS', '驗證碼錯誤');
  }
  await clearLoginFailures(key);
  const mfaEnabled = cred.mfaEnabledAt !== null;
  const token = await transaction(async (tx) => {
    const tk = await createSession(tx, cred.userId, { authMethod: 'PASSWORD', mfa: mfaEnabled });
    await appendAudit(tx, { actorType: 'ADMIN', actorId: cred.userId, action: 'ADMIN_LOGIN', entityType: 'user', entityId: cred.userId, payload: { mfa: mfaEnabled, ip: meta.ip ?? null } });
    return tk;
  });
  return {
    token,
    userId: cred.userId,
    roles: cred.roles,
    mfaEnabled,
    mfaEnrollmentRequired: config().ADMIN_MFA_REQUIRED && !mfaEnabled,
  };
}

/**
 * 登入頁的密碼提示。
 * ⚠ 安全性：密碼提示會降低安全性（提示本身就是給攻擊者的線索，且此端點可被用來探測帳號是否存在）。
 *   業主要求保留此功能；正式上線建議移除提示或只在內網顯示，並務必搭配 MFA、IP 允許清單與登入鎖定。
 *   帳號不存在與「沒有設定提示」回傳相同結果（null）。
 */
export async function getPasswordHint(loginId: string): Promise<string | null> {
  const [r] = await db()<{ passwordHint: string | null }[]>`SELECT password_hint FROM admin_credentials WHERE login_id = ${loginId.trim().toLowerCase()}`;
  return r?.passwordHint ?? null;
}

/** 設定（或重設）後台帳號密碼。供種子腳本與日後的帳號管理使用；只存 scrypt 雜湊。 */
export async function setAdminCredentials(d: Db, a: { userId: string; loginId: string; password: string; hint?: string | null }): Promise<void> {
  if (a.password.length < PASSWORD_MIN_LENGTH) throw new AppError('VALIDATION', `密碼至少 ${PASSWORD_MIN_LENGTH} 碼`);
  const hash = await hashPassword(a.password);
  await d`
    INSERT INTO admin_credentials (user_id, login_id, password_hash, password_hint)
    VALUES (${a.userId}, ${a.loginId.toLowerCase()}, ${hash}, ${a.hint ?? null})
    ON CONFLICT (user_id) DO UPDATE SET login_id = EXCLUDED.login_id, password_hash = EXCLUDED.password_hash,
      password_hint = EXCLUDED.password_hint, password_changed_at = now()`;
}

export const ReauthSchema = z.object({ password: z.string().min(1).max(200), totp: z.string().regex(/^\d{6}$/).optional() });

/** 重新驗證（高風險後台操作前）：密碼 ＋（已綁定時）TOTP → 更新本 session 的 reauth_at / mfa_verified_at */
export async function adminReauth(p: Principal, input: z.input<typeof ReauthSchema>, meta: { ip?: string | null } = {}) {
  const v = ReauthSchema.parse(input);
  if (!p.session || p.session.authMethod !== 'PASSWORD') throw new AppError('FORBIDDEN', '請以後台帳號密碼登入');
  const cred = await loadCred(db(), { userId: p.userId });
  if (!cred) throw new AppError('FORBIDDEN', 'no admin credentials');
  const key = lockKey(cred.loginId);
  await assertNotLocked(key);
  if (!(await verifyPassword(v.password, cred.passwordHash))) {
    await recordLoginFailure(key, { ip: meta.ip, userId: p.userId });
    throw new AppError('INVALID_CREDENTIALS', '密碼錯誤');
  }
  const t = await checkTotp(cred, v.totp);
  if (t === 'MISSING') throw new AppError('MFA_REQUIRED', '請輸入兩步驟驗證碼', { mfa: 'TOTP' });
  if (t === 'BAD') {
    await recordLoginFailure(key, { ip: meta.ip, userId: p.userId });
    throw new AppError('INVALID_CREDENTIALS', '驗證碼錯誤');
  }
  await clearLoginFailures(key);
  await db()`UPDATE auth_sessions SET reauth_at = now(), mfa_verified_at = ${cred.mfaEnabledAt ? new Date() : null} WHERE token_hash = ${p.session.tokenHash}`;
  return { reauthenticated: true, validForMinutes: config().ADMIN_REAUTH_MAX_AGE_MIN };
}

/** MFA 綁定第一步：產生秘密金鑰（加密暫存），回傳給驗證器 App 掃描的 otpauth URL */
export async function enrollMfa(p: Principal) {
  if (!p.session || p.session.authMethod !== 'PASSWORD') throw new AppError('FORBIDDEN', '請以後台帳號密碼登入');
  const cred = await loadCred(db(), { userId: p.userId });
  if (!cred) throw new AppError('FORBIDDEN', 'no admin credentials');
  const secret = generateTotpSecret();
  await db()`UPDATE admin_credentials SET mfa_pending_secret_enc = ${seal(secret)} WHERE user_id = ${p.userId}`;
  return { secret, otpauthUrl: otpauthUrl(secret, cred.loginId), alreadyEnabled: cred.mfaEnabledAt !== null };
}

export const MfaVerifySchema = z.object({ code: z.string().regex(/^\d{6}$/) });

/** MFA 綁定第二步：以驗證碼確認 → 啟用 MFA，並將本 session 標記為已通過 MFA */
export async function verifyMfaEnrollment(p: Principal, input: z.input<typeof MfaVerifySchema>) {
  const v = MfaVerifySchema.parse(input);
  if (!p.session || p.session.authMethod !== 'PASSWORD') throw new AppError('FORBIDDEN', '請以後台帳號密碼登入');
  return transaction(async (tx) => {
    const [c] = await tx<{ pending: string | null }[]>`SELECT mfa_pending_secret_enc AS pending FROM admin_credentials WHERE user_id = ${p.userId} FOR UPDATE`;
    if (!c?.pending) throw new AppError('INVALID_STATE', '請先產生 MFA 金鑰');
    const step = verifyTotp(open(c.pending), v.code);
    if (step === null) throw new AppError('INVALID_CREDENTIALS', '驗證碼錯誤');
    await tx`UPDATE admin_credentials SET mfa_secret_enc = mfa_pending_secret_enc, mfa_pending_secret_enc = NULL, mfa_enabled_at = now(), mfa_last_step = ${step}
             WHERE user_id = ${p.userId}`;
    await tx`UPDATE auth_sessions SET mfa_verified_at = now(), reauth_at = now() WHERE token_hash = ${p.session!.tokenHash}`;
    await appendAudit(tx, { actorType: 'ADMIN', actorId: p.userId, action: 'ADMIN_MFA_ENABLED', entityType: 'user', entityId: p.userId });
    return { mfaEnabled: true };
  });
}

export async function logoutSession(token: string): Promise<void> {
  await db()`UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = ${hashToken(token)} AND revoked_at IS NULL`;
}
