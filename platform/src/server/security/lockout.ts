import { config } from '../config';
import { db } from '../db';
import { AppError } from '../errors';
import { recordSecurityEvent } from './events';

/**
 * 登入暴力破解防護（後台密碼登入 key = admin:<loginId>；手機 OTP key = otp:<phone>）：
 *  - 連續失敗達 LOGIN_BACKOFF_AFTER（3）次起，每次失敗鎖定 LOGIN_BACKOFF_BASE_SEC × 2^(n−3) 秒（指數退避）；
 *  - 達 LOGIN_MAX_FAILURES（10）次 → 鎖定 LOGIN_LOCK_MINUTES（30）分鐘；
 *  - 成功登入清除；最後一次失敗超過 24 小時則重新計數。鎖定期間不檢查密碼（避免持續猜測）。
 */
export async function assertNotLocked(key: string): Promise<void> {
  const [r] = await db()<{ lockedUntil: Date | null }[]>`SELECT locked_until FROM auth_lockouts WHERE key = ${key}`;
  if (r?.lockedUntil && r.lockedUntil.getTime() > Date.now()) {
    throw new AppError('ACCOUNT_LOCKED', '登入失敗次數過多，請稍後再試', { retryAfterSec: Math.ceil((r.lockedUntil.getTime() - Date.now()) / 1000) });
  }
}

export async function recordLoginFailure(key: string, meta: { ip?: string | null; userId?: string | null } = {}): Promise<{ failures: number; lockedForSec: number }> {
  const c = config();
  const [r] = await db()<{ failures: number }[]>`
    INSERT INTO auth_lockouts (key, failures, last_failure_at) VALUES (${key}, 1, now())
    ON CONFLICT (key) DO UPDATE SET
      failures = CASE WHEN auth_lockouts.last_failure_at < now() - interval '24 hours' THEN 1 ELSE auth_lockouts.failures + 1 END,
      last_failure_at = now(), updated_at = now()
    RETURNING failures`;
  const f = r!.failures;
  let lockSec = 0;
  if (f >= c.LOGIN_MAX_FAILURES) lockSec = c.LOGIN_LOCK_MINUTES * 60;
  else if (f >= c.LOGIN_BACKOFF_AFTER) lockSec = c.LOGIN_BACKOFF_BASE_SEC * 2 ** (f - c.LOGIN_BACKOFF_AFTER);
  if (lockSec > 0) {
    await db()`UPDATE auth_lockouts SET locked_until = now() + make_interval(secs => ${lockSec}) WHERE key = ${key}`;
    await recordSecurityEvent('LOGIN_LOCKOUT', {
      ip: meta.ip,
      userId: meta.userId,
      key: `${key}:${f >= c.LOGIN_MAX_FAILURES ? 'hard' : 'backoff'}`,
      severity: f >= c.LOGIN_MAX_FAILURES ? 'HIGH' : 'MEDIUM',
      details: { key, failures: f, lockedForSec: lockSec },
    });
  }
  return { failures: f, lockedForSec: lockSec };
}

export async function clearLoginFailures(key: string): Promise<void> {
  await db()`DELETE FROM auth_lockouts WHERE key = ${key}`;
}
