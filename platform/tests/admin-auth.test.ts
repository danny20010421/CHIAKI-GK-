/** 後台帳號：scrypt 密碼（不存明文）、種子由環境變數讀取、密碼提示、登入鎖定、重新驗證、TOTP MFA（含 ADMIN_MFA_REQUIRED） */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../src/server/db';
import { resetConfig } from '../src/server/config';
import { hashPassword, verifyPassword } from '../src/server/lib/password';
import { base32Encode, hotp, totp, verifyTotp, totpStep } from '../src/server/lib/totp';
import { open, seal } from '../src/server/lib/secretbox';
import { setAdminCredentials } from '../src/server/modules/auth/admin-auth';
import { POST as loginRoute } from '../src/app/api/auth/admin/login/route';
import { GET as hintRoute } from '../src/app/api/auth/admin/hint/route';
import { POST as logoutRoute } from '../src/app/api/auth/logout/route';
import { POST as reauthRoute } from '../src/app/api/admin/auth/reauth/route';
import { POST as enrollRoute } from '../src/app/api/admin/auth/mfa/enroll/route';
import { POST as verifyRoute } from '../src/app/api/admin/auth/mfa/verify/route';
import { GET as dashboardRoute } from '../src/app/api/admin/cs/dashboard/route';
import { apiRequest, makeUser, setupTestDb } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
before(async () => {
  env = await setupTestDb();
});
after(async () => {
  await env.teardown();
});

const none = undefined as never;
const TEST_PASSWORD = 'Test-Only-Passw0rd!';
const j = async <T = Record<string, unknown>>(r: Response) => ({ status: r.status, body: (await r.json()) as T });
const login = (body: Record<string, unknown>) => loginRoute(apiRequest('POST', '/api/auth/admin/login', { body }), none);

describe('crypto primitives', () => {
  it('TOTP matches RFC 6238 SHA-1 vectors; secrets are sealed with AES-GCM; scrypt hashes verify', async () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    assert.equal(hotp(secret, Math.floor(59 / 30), 8), '94287082');
    assert.equal(hotp(secret, Math.floor(1111111109 / 30), 8), '07081804');
    assert.equal(totp(secret, 59_000), '287082');
    assert.equal(verifyTotp(secret, '287082', { nowMs: 59_000 }), 1);
    assert.equal(verifyTotp(secret, '287082', { nowMs: 59_000, lastUsedStep: 1 }), null, 'replay of a used step is rejected');
    assert.equal(verifyTotp(secret, '287082', { nowMs: 59_000 + 30_000 }), 1, '±1 step clock drift');
    assert.equal(verifyTotp(secret, '287082', { nowMs: 59_000 + 90_000 }), null);
    const sealed = seal(secret);
    assert.ok(!sealed.includes(secret));
    assert.equal(open(sealed), secret);
    const h = await hashPassword(TEST_PASSWORD);
    assert.match(h, /^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    assert.ok(!h.includes(TEST_PASSWORD));
    assert.equal(await verifyPassword(TEST_PASSWORD, h), true);
    assert.equal(await verifyPassword('wrong', h), false);
    assert.notEqual(await hashPassword(TEST_PASSWORD), h, 'salted');
  });

  it('the owner-requested test password is not stored in plaintext anywhere in the repository', () => {
    const secret = ['0421', '0421'].join('');
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        if (['node_modules', '.next', 'vendor', '.git'].includes(n)) return [];
        const p = join(d, n);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    const hits = walk('.').filter((f) => /\.(ts|tsx|mjs|js|json|sql|prisma|md|example)$/.test(f) && readFileSync(f, 'utf8').includes(secret));
    assert.deepEqual(hits, []);
    const example = readFileSync('.env.example', 'utf8');
    assert.match(example, /^ADMIN_INITIAL_PASSWORD=$/m, '.env.example documents the variable with an empty value');
  });
});

describe('seed reads ADMIN_INITIAL_PASSWORD and stores only scrypt hashes', () => {
  it('npm run db:seed with env password + hint → admin can log in; hint shown; plaintext never stored', async () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/seed.ts'], {
      env: { ...process.env, ADMIN_INITIAL_PASSWORD: TEST_PASSWORD, ADMIN_PASSWORD_HINT: '測試提示' },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const creds = await db()<{ loginId: string; passwordHash: string; passwordHint: string | null }[]>`SELECT login_id, password_hash, password_hint FROM admin_credentials ORDER BY login_id`;
    assert.deepEqual(creds.map((c) => c.loginId), ['admin', 'finance-a', 'finance-b', 'ops', 'support']);
    assert.ok(creds.every((c) => c.passwordHash.startsWith('scrypt$') && !c.passwordHash.includes(TEST_PASSWORD) && c.passwordHint === '測試提示'));
    const ok = await j<{ token: string; roles: string[]; mfaEnabled: boolean; csrfToken: string }>(await login({ loginId: 'admin', password: TEST_PASSWORD }));
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.roles, ['SUPER_ADMIN']);
    const hint = await j<{ hint: string | null }>(await hintRoute(apiRequest('GET', '/api/auth/admin/hint?loginId=admin'), none));
    assert.equal(hint.body.hint, '測試提示');
    const unknown = await j<{ hint: string | null }>(await hintRoute(apiRequest('GET', '/api/auth/admin/hint?loginId=nobody'), none));
    assert.equal(unknown.body.hint, null);
    // 再跑一次種子不會覆寫既有密碼
    const r2 = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/seed.ts'], { env: { ...process.env, ADMIN_INITIAL_PASSWORD: 'Another-Passw0rd' }, encoding: 'utf8' });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal((await login({ loginId: 'admin', password: TEST_PASSWORD })).status, 200);
  });
});

describe('admin password login', () => {
  it('generic errors, staff only, cookies + CSRF token, lockout with backoff, logout', async () => {
    const staff = await makeUser({ roles: ['CS'] });
    await setAdminCredentials(db(), { userId: staff.id, loginId: 'cs-login-test', password: TEST_PASSWORD });
    const member = await makeUser();
    await setAdminCredentials(db(), { userId: member.id, loginId: 'member-login', password: TEST_PASSWORD });
    const wrong = await j<{ error: { code: string; message: string } }>(await login({ loginId: 'cs-login-test', password: 'nope' }));
    const missing = await j<{ error: { code: string; message: string } }>(await login({ loginId: 'no-such-user', password: 'nope' }));
    assert.deepEqual([wrong.status, wrong.body.error], [401, { code: 'INVALID_CREDENTIALS', message: '帳號或密碼錯誤' }]);
    assert.deepEqual(missing.body.error, wrong.body.error, 'unknown account indistinguishable');
    assert.equal((await login({ loginId: 'member-login', password: TEST_PASSWORD })).status, 401, 'members cannot log into the back office');

    const res = await login({ loginId: 'CS-Login-Test', password: TEST_PASSWORD });
    assert.equal(res.status, 200);
    const cookies = res.headers.getSetCookie();
    assert.ok(cookies.some((c) => /^chiaki_session=.*HttpOnly.*SameSite=Lax/.test(c)));
    assert.ok(cookies.some((c) => /^chiaki_csrf=/.test(c)));
    const b = (await res.json()) as { token: string; csrfToken: string };
    assert.equal((await dashboardRoute(apiRequest('GET', '/api/admin/cs/dashboard', { token: b.token }), none)).status, 200);
    const out = await logoutRoute(apiRequest('POST', '/api/auth/logout', { token: b.token }), none);
    assert.equal(out.status, 200);
    assert.equal((await dashboardRoute(apiRequest('GET', '/api/admin/cs/dashboard', { token: b.token }), none)).status, 401);

    // 成功登入已清除失敗次數；連續 3 次失敗 → 鎖定（指數退避），正確密碼也被拒
    for (let i = 0; i < 3; i++) await login({ loginId: 'cs-login-test', password: 'nope' });
    const locked = await j<{ error: { code: string; details: { retryAfterSec: number } } }>(await login({ loginId: 'cs-login-test', password: TEST_PASSWORD }));
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error.code, 'ACCOUNT_LOCKED');
    const [ev] = await db()`SELECT count(*)::int AS n FROM risk_events WHERE type = 'LOGIN_LOCKOUT'`;
    assert.ok(ev!.n >= 1);
    await db()`UPDATE auth_lockouts SET failures = 9, locked_until = NULL WHERE key = 'admin:cs-login-test'`;
    await login({ loginId: 'cs-login-test', password: 'nope' });
    const [hard] = await db()`SELECT extract(epoch FROM locked_until - now())::int AS secs FROM auth_lockouts WHERE key = 'admin:cs-login-test'`;
    assert.ok((hard!.secs as number) > 29 * 60, '10 failures → long lock (30 min)');
  });
});

describe('re-auth and TOTP MFA', () => {
  it('stale session needs /reauth; MFA enroll/verify; login then requires TOTP; codes cannot be replayed', async () => {
    const ops = await makeUser({ roles: ['OPS'] });
    await setAdminCredentials(db(), { userId: ops.id, loginId: 'ops-mfa', password: TEST_PASSWORD });
    const first = await j<{ token: string; mfaEnabled: boolean }>(await login({ loginId: 'ops-mfa', password: TEST_PASSWORD }));
    const token = first.body.token;
    const dash = () => dashboardRoute(apiRequest('GET', '/api/admin/cs/dashboard', { token }), none);
    assert.equal((await dash()).status, 200);
    await db()`UPDATE auth_sessions SET reauth_at = now() - interval '31 minutes' WHERE user_id = ${ops.id}`;
    assert.equal((await dash()).status, 401);
    assert.equal((await reauthRoute(apiRequest('POST', '/api/admin/auth/reauth', { token, body: { password: 'bad' } }), none)).status, 401);
    assert.equal((await reauthRoute(apiRequest('POST', '/api/admin/auth/reauth', { token, body: { password: TEST_PASSWORD } }), none)).status, 200);
    assert.equal((await dash()).status, 200);

    const en = await j<{ secret: string; otpauthUrl: string }>(await enrollRoute(apiRequest('POST', '/api/admin/auth/mfa/enroll', { token }), none));
    assert.equal(en.status, 201);
    assert.match(en.body.otpauthUrl, /^otpauth:\/\/totp\/CHIAKI%20Admin%3Aops-mfa\?secret=[A-Z2-7]+/);
    assert.equal((await verifyRoute(apiRequest('POST', '/api/admin/auth/mfa/verify', { token, body: { code: '000000' } }), none)).status, 401);
    assert.equal((await verifyRoute(apiRequest('POST', '/api/admin/auth/mfa/verify', { token, body: { code: totp(en.body.secret) } }), none)).status, 200);
    const [c] = await db()`SELECT mfa_secret_enc, mfa_enabled_at IS NOT NULL AS on FROM admin_credentials WHERE user_id = ${ops.id}`;
    assert.equal(c!.on, true);
    assert.ok(!(c!.mfaSecretEnc as string).includes(en.body.secret), 'TOTP secret stored encrypted');

    const noCode = await j<{ error: { code: string } }>(await login({ loginId: 'ops-mfa', password: TEST_PASSWORD }));
    assert.equal(noCode.body.error.code, 'MFA_REQUIRED');
    // 下一個時間步的碼（容許時鐘誤差 +1）→ 成功；同一碼重放 → 拒絕
    const code = hotp(en.body.secret, totpStep() + 1);
    assert.equal((await login({ loginId: 'ops-mfa', password: TEST_PASSWORD, totp: code })).status, 200);
    assert.equal((await login({ loginId: 'ops-mfa', password: TEST_PASSWORD, totp: code })).status, 401);
  });

  it('ADMIN_MFA_REQUIRED=true: un-enrolled admins can only reach the MFA endpoints until enrolled', async () => {
    process.env.ADMIN_MFA_REQUIRED = 'true';
    resetConfig();
    try {
      const fin = await makeUser({ roles: ['FINANCE'] });
      await setAdminCredentials(db(), { userId: fin.id, loginId: 'fin-mfa', password: TEST_PASSWORD });
      const l = await j<{ token: string; mfaEnrollmentRequired: boolean }>(await login({ loginId: 'fin-mfa', password: TEST_PASSWORD }));
      assert.equal(l.body.mfaEnrollmentRequired, true);
      const token = l.body.token;
      const dash = await j<{ error: { code: string } }>(await dashboardRoute(apiRequest('GET', '/api/admin/cs/dashboard', { token }), none));
      assert.equal(dash.body.error.code, 'MFA_REQUIRED');
      const en = await j<{ secret: string }>(await enrollRoute(apiRequest('POST', '/api/admin/auth/mfa/enroll', { token }), none));
      assert.equal((await verifyRoute(apiRequest('POST', '/api/admin/auth/mfa/verify', { token, body: { code: totp(en.body.secret) } }), none)).status, 200);
      // FINANCE 沒有 cs.ticket.manage → 通過 MFA 後是權限 403（不是 401 MFA）
      assert.equal((await dashboardRoute(apiRequest('GET', '/api/admin/cs/dashboard', { token }), none)).status, 403);
    } finally {
      delete process.env.ADMIN_MFA_REQUIRED;
      resetConfig();
    }
  });
});
