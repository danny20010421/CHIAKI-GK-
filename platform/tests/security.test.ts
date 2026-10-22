/** 應用層防火牆：安全標頭、全部路由皆受保護、本文大小/格式、IP 與會員限流、封鎖清單、CSRF、機器人偵測、後台存取、綠界通知防護、通用錯誤、登入鎖定 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../src/server/db';
import { resetConfig } from '../src/server/config';
import { route } from '../src/server/http';
import { nextHeaderList, securityHeaders } from '../src/server/security/headers';
import { resetSecurityEventThrottle } from '../src/server/security/events';
import { createSession, loginWithOtp } from '../src/server/modules/auth/users';
import { computeCheckMacValue } from '../src/server/modules/payment/ecpay';
import { createEcpayCheckout } from '../src/server/modules/payment/payments';
import { GET as poolsRoute } from '../src/app/api/pools/route';
import { GET as walletRoute } from '../src/app/api/me/wallet/route';
import { GET as rewardsList, POST as rewardsClaim } from '../src/app/api/me/rewards/route';
import { POST as holdRoute } from '../src/app/api/pools/[id]/sets/[no]/holds/route';
import { GET as blockList, POST as blockAdd } from '../src/app/api/admin/security/blocklist/route';
import { DELETE as blockDelete } from '../src/app/api/admin/security/blocklist/[id]/route';
import { GET as auditVerify } from '../src/app/api/admin/audit/verify/route';
import { POST as notifyRoute } from '../src/app/api/payments/ecpay/notify/route';
import { apiRequest, ctx, expectAppError, makeUser, publishPool, setupTestDb, smallPool } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
before(async () => {
  env = await setupTestDb({
    RATE_LIMIT_IP_CAPACITY: '20',
    RATE_LIMIT_IP_REFILL_PER_SEC: '0.001',
    RATE_LIMIT_USER_CAPACITY: '15',
    RATE_LIMIT_USER_REFILL_PER_SEC: '0.001',
    BOT_MAX_REQUESTS: '3',
    BOT_WINDOW_MS: '60000',
    MAX_BODY_BYTES: '2048',
  });
});
after(async () => {
  await env.teardown();
});

const none = undefined as never;
let ipSeq = 0;
const freshIp = () => `10.${(++ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`;
type Opts = Parameters<typeof apiRequest>[2];
/** 每個請求預設使用不同的來源 IP（避免互相影響 IP 限流） */
const req = (method: string, path: string, opts: Opts = {}, ip = freshIp()) => apiRequest(method, path, { ...opts, headers: { 'x-forwarded-for': ip, ...(opts?.headers ?? {}) } });
const errCode = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;
const riskCount = async (type: string, extra = db()``) =>
  ((await db()`SELECT count(*)::int AS n FROM risk_events WHERE type = ${type} ${extra}`) as unknown as [{ n: number }])[0].n;

describe('security headers', () => {
  it('every API response carries CSP, HSTS, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy (also on errors)', async () => {
    for (const res of [await poolsRoute(req('GET', '/api/pools'), none), await walletRoute(req('GET', '/api/me/wallet'), none)]) {
      for (const [k, v] of Object.entries(securityHeaders('api'))) assert.equal(res.headers.get(k), v, k);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
    assert.match(securityHeaders('api')['content-security-policy']!, /frame-ancestors 'none'/);
    assert.equal(securityHeaders('page')['x-frame-options'], 'DENY');
  });

  it('next.config.mjs headers() are identical to the helper', async () => {
    const configPath = '../next.config.mjs'; // 非字面路徑：.mjs 無型別宣告
    const mod = (await import(configPath)) as { default: { headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> } };
    const routes = await mod.default.headers();
    const sort = (l: { key: string; value: string }[]) => [...l].sort((a, b) => a.key.localeCompare(b.key));
    assert.deepEqual(sort(routes.find((r) => r.source === '/api/:path*')!.headers), sort(nextHeaderList('api')));
    assert.deepEqual(sort(routes.find((r) => r.source !== '/api/:path*')!.headers), sort(nextHeaderList('page')));
  });
});

describe('all route handlers go through the firewall', () => {
  it('every exported HTTP method in src/app/api/**/route.ts is wrapped with route()', () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : n === 'route.ts' ? [join(d, n)] : []));
    const files = walk('src/app/api');
    assert.ok(files.length > 60);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      assert.ok(!/export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)/.test(src), `${f}: unwrapped function export`);
      const exports = [...src.matchAll(/export const (GET|POST|PUT|PATCH|DELETE) = ([^\n]*)/g)];
      assert.ok(exports.length > 0, `${f}: no handlers`);
      for (const m of exports) assert.match(m[2]!, /^route\(/, `${f}: ${m[1]} must be route(...)`);
    }
  });
});

describe('request body limits and content-type', () => {
  it('rejects oversized bodies (413) and non-JSON bodies (415); records risk events', async () => {
    const u = await makeUser();
    const big = { taskCode: 'BIND_PHONE', evidence: 'x'.repeat(5000) };
    const r1 = await rewardsClaim(req('POST', '/api/me/rewards', { token: u.token, body: big }), none);
    assert.equal(r1.status, 413);
    assert.equal(await errCode(r1), 'PAYLOAD_TOO_LARGE');
    const r2 = await rewardsClaim(req('POST', '/api/me/rewards', { token: u.token, rawBody: '{"taskCode":"BIND_PHONE"}', headers: { 'content-type': 'text/plain' } }), none);
    assert.equal(r2.status, 415);
    const r3 = await rewardsClaim(req('POST', '/api/me/rewards', { token: u.token, rawBody: 'taskCode=BIND_PHONE', headers: { 'content-type': 'application/x-www-form-urlencoded' } }), none);
    assert.equal(r3.status, 415, 'form bodies only allowed on the ECPay notify route');
    const r4 = await rewardsClaim(req('POST', '/api/me/rewards', { token: u.token, rawBody: '{bad json', headers: { 'content-type': 'application/json' } }), none);
    assert.equal(r4.status, 400);
    assert.ok((await riskCount('PAYLOAD_REJECTED')) >= 2);
  });
});

describe('rate limiting (token bucket)', () => {
  it('per-IP: bucket exhausts → 429 with Retry-After and a RATE_LIMIT_IP risk event; other IPs unaffected', async () => {
    const ip = '203.0.113.7';
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await poolsRoute(req('GET', '/api/pools', {}, ip), none)).status);
    assert.deepEqual(statuses.slice(0, 20), Array(20).fill(200));
    const limited = await poolsRoute(req('GET', '/api/pools', {}, ip), none);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal((await poolsRoute(req('GET', '/api/pools'), none)).status, 200);
    assert.equal(await riskCount('RATE_LIMIT_IP', db()`AND ip = ${ip}`), 1, 'throttled: one event per source per minute');
  });

  it('per-user: the same account from many IPs is limited too', async () => {
    const u = await makeUser();
    const s: number[] = [];
    for (let i = 0; i < 16; i++) s.push((await walletRoute(req('GET', '/api/me/wallet', { token: u.token }), none)).status);
    assert.deepEqual(s.slice(0, 15), Array(15).fill(200));
    assert.equal(s[15], 429);
    assert.equal(await riskCount('RATE_LIMIT_USER', db()`AND user_id = ${u.id}`), 1);
  });
});

describe('IP / device blocklist with admin endpoints', () => {
  it('OPS blocks an IP and a device; blocked requests get 403 and are logged; unblock restores access', async () => {
    const ops = await makeUser({ roles: ['OPS'] });
    const member = await makeUser();
    const bad = '198.51.100.9';
    assert.equal((await blockAdd(req('POST', '/api/admin/security/blocklist', { token: member.token, body: { kind: 'IP', value: bad } }), none)).status, 403);
    const add = await blockAdd(req('POST', '/api/admin/security/blocklist', { token: ops.token, body: { kind: 'IP', value: bad, reason: 'scraper' } }), none);
    assert.equal(add.status, 201);
    const { id } = (await add.json()) as { id: number };
    const blocked = await poolsRoute(req('GET', '/api/pools', {}, bad), none);
    assert.equal(blocked.status, 403);
    assert.equal(await errCode(blocked), 'BLOCKED');
    assert.equal(await riskCount('BLOCKED_REQUEST', db()`AND ip = ${bad}`), 1);
    await blockAdd(req('POST', '/api/admin/security/blocklist', { token: ops.token, body: { kind: 'DEVICE', value: 'evil-device-fp-0001' } }), none);
    assert.equal((await poolsRoute(req('GET', '/api/pools', { headers: { 'x-device-fingerprint': 'evil-device-fp-0001' } }), none)).status, 403);
    const listed = (await (await blockList(req('GET', '/api/admin/security/blocklist', { token: ops.token }), none)).json()) as { entries: { value: string }[] };
    assert.ok(listed.entries.some((e) => e.value === bad));
    assert.equal((await blockDelete(req('DELETE', `/api/admin/security/blocklist/${id}`, { token: ops.token }), ctx({ id: String(id) }))).status, 200);
    assert.equal((await poolsRoute(req('GET', '/api/pools', {}, bad), none)).status, 200);
    const [a] = await db()`SELECT count(*)::int AS n FROM audit_log WHERE action IN ('BLOCKLIST_ADDED', 'BLOCKLIST_REMOVED')`;
    assert.equal(a!.n, 3);
  });
});

describe('CSRF for cookie sessions', () => {
  it('cookie-authenticated unsafe requests need a matching x-csrf-token and same-origin; Bearer requests do not', async () => {
    const u = await makeUser();
    const cookie = `chiaki_session=${u.token}; chiaki_csrf=csrf-token-abcdef123456`;
    assert.equal((await rewardsList(req('GET', '/api/me/rewards', { headers: { cookie } }), none)).status, 200, 'safe method OK');
    const noToken = await rewardsClaim(req('POST', '/api/me/rewards', { headers: { cookie }, body: { taskCode: 'BIND_PHONE' } }), none);
    assert.equal(noToken.status, 403);
    assert.equal(await errCode(noToken), 'CSRF_REJECTED');
    const wrong = await rewardsClaim(req('POST', '/api/me/rewards', { headers: { cookie, 'x-csrf-token': 'csrf-token-XXXXXX123456' }, body: { taskCode: 'BIND_PHONE' } }), none);
    assert.equal(wrong.status, 403);
    const cross = await rewardsClaim(req('POST', '/api/me/rewards', { headers: { cookie, 'x-csrf-token': 'csrf-token-abcdef123456', origin: 'https://evil.example' }, body: { taskCode: 'BIND_PHONE' } }), none);
    assert.equal(cross.status, 403);
    const ok = await rewardsClaim(req('POST', '/api/me/rewards', { headers: { cookie, 'x-csrf-token': 'csrf-token-abcdef123456', origin: 'http://localhost:3000' }, body: { taskCode: 'BIND_PHONE' } }), none);
    assert.equal(ok.status, 201);
    assert.ok((await riskCount('CSRF_REJECTED', db()`AND user_id = ${u.id}`)) >= 1);
    const bearer = await rewardsClaim(req('POST', '/api/me/rewards', { token: u.token, body: { taskCode: 'BIND_LINE_OA' } }), none);
    assert.equal(bearer.status, 201);
  });
});

describe('bot heuristics on hold/draw endpoints', () => {
  it('too-fast hold sequence → 429 BOT_SUSPECTED + HIGH risk event', async () => {
    resetSecurityEventThrottle();
    const poolId = await publishPool(smallPool());
    const u = await makeUser();
    const codes: number[] = [];
    for (let i = 1; i <= 4; i++) codes.push((await holdRoute(req('POST', `/api/pools/${poolId}/sets/1/holds`, { token: u.token, body: { ticketNos: [i] } }), ctx({ id: poolId, no: '1' }))).status);
    assert.deepEqual(codes, [201, 201, 201, 429]);
    const [e] = await db()`SELECT severity, details_json FROM risk_events WHERE type = 'BOT_SUSPECTED' AND user_id = ${u.id}`;
    assert.equal(e!.severity, 'HIGH');
    const other = await makeUser();
    assert.equal((await holdRoute(req('POST', `/api/pools/${poolId}/sets/1/holds`, { token: other.token, body: { ticketNos: [9] } }), ctx({ id: poolId, no: '1' }))).status, 201);
  });
});

describe('admin routes: staff role + password session + recent re-auth + optional MFA / IP allowlist', () => {
  it('enforces each requirement', async () => {
    const fin = await makeUser({ roles: ['FINANCE'] });
    assert.equal((await auditVerify(req('GET', '/api/admin/audit/verify', { token: fin.token }), none)).status, 200);
    // OTP session（非密碼登入）的員工 → 403
    const otpToken = await createSession(db(), fin.id);
    const r1 = await auditVerify(req('GET', '/api/admin/audit/verify', { token: otpToken }), none);
    assert.equal(r1.status, 403);
    // 重新驗證過期 → 401 REAUTH_REQUIRED
    await db()`UPDATE auth_sessions SET reauth_at = now() - interval '2 hours' WHERE user_id = ${fin.id} AND auth_method = 'PASSWORD'`;
    const r2 = await auditVerify(req('GET', '/api/admin/audit/verify', { token: fin.token }), none);
    assert.equal(r2.status, 401);
    assert.equal(await errCode(r2), 'REAUTH_REQUIRED');
    await db()`UPDATE auth_sessions SET reauth_at = now() WHERE user_id = ${fin.id}`;
    // IP 允許清單
    process.env.ADMIN_IP_ALLOWLIST = '192.0.2.0/24, 2001:db8::1';
    resetConfig();
    try {
      assert.equal((await auditVerify(req('GET', '/api/admin/audit/verify', { token: fin.token }, '198.51.100.20'), none)).status, 403);
      assert.equal((await auditVerify(req('GET', '/api/admin/audit/verify', { token: fin.token }, '192.0.2.44'), none)).status, 200);
      assert.equal((await auditVerify(req('GET', '/api/admin/audit/verify', { token: fin.token }, '2001:db8::1'), none)).status, 200);
    } finally {
      delete process.env.ADMIN_IP_ALLOWLIST;
      resetConfig();
    }
    // MFA 必須
    process.env.ADMIN_MFA_REQUIRED = 'true';
    resetConfig();
    try {
      await db()`UPDATE auth_sessions SET mfa_verified_at = NULL WHERE user_id = ${fin.id}`;
      const r3 = await auditVerify(req('GET', '/api/admin/audit/verify', { token: fin.token }), none);
      assert.equal(await errCode(r3), 'MFA_REQUIRED');
    } finally {
      delete process.env.ADMIN_MFA_REQUIRED;
      resetConfig();
    }
    assert.ok((await riskCount('ADMIN_ACCESS_DENIED')) >= 2);
  });
});

describe('ECPay notify hardening', () => {
  function body(tradeNo: string, amount: number, extra: Record<string, string> = {}) {
    const p: Record<string, string> = { MerchantID: '3002607', MerchantTradeNo: tradeNo, RtnCode: '1', RtnMsg: 'OK', TradeNo: '2310239999000001', TradeAmt: String(amount), PaymentDate: '2026/10/23 12:00:00', PaymentType: 'Credit_CreditCard', TradeDate: '2026/10/23 11:59:00', SimulatePaid: '0', ...extra };
    p.CheckMacValue = computeCheckMacValue(p, 'pwFHCqoQZGmho4w6', 'EkRm7iFT261dpevs');
    return new URLSearchParams(p).toString();
  }
  const post = (raw: string, ip?: string) => notifyRoute(req('POST', '/api/payments/ecpay/notify', { rawBody: raw, headers: { 'content-type': 'application/x-www-form-urlencoded' } }, ip));

  it('source IP allowlist, replay of a paid order with a different TradeNo, stale notifications', async () => {
    const u = await makeUser();
    const co = await createEcpayCheckout(u.id, { packageCode: 'P1000' });
    process.env.ECPAY_NOTIFY_IP_ALLOWLIST = '175.99.72.0/24';
    resetConfig();
    try {
      const denied = await post(body(co.merchantTradeNo, 1000), '203.0.113.50');
      assert.equal(denied.status, 403);
      assert.equal(await denied.text(), '0|Forbidden');
      assert.equal(await (await post(body(co.merchantTradeNo, 1000), '175.99.72.11')).text(), '1|OK');
    } finally {
      delete process.env.ECPAY_NOTIFY_IP_ALLOWLIST;
      resetConfig();
    }
    assert.equal(await (await post(body(co.merchantTradeNo, 1000))).text(), '1|OK', 'identical retry is idempotent');
    assert.equal(await (await post(body(co.merchantTradeNo, 1000, { TradeNo: '2310230000000666' }))).text(), '0|TradeNo Mismatch');
    const [{ coins }] = (await db()`SELECT coins FROM wallets WHERE user_id = ${u.id}`) as unknown as [{ coins: number }];
    assert.equal(coins, 1000, 'credited exactly once');
    process.env.ECPAY_NOTIFY_MAX_AGE_HOURS = '72';
    resetConfig();
    try {
      const co2 = await createEcpayCheckout(u.id, { packageCode: 'P500' });
      assert.equal(await (await post(body(co2.merchantTradeNo, 500, { PaymentDate: '2020/01/01 00:00:00' }))).text(), '0|Stale Notification');
    } finally {
      delete process.env.ECPAY_NOTIFY_MAX_AGE_HOURS;
      resetConfig();
    }
    assert.ok((await riskCount('ECPAY_NOTIFY_REJECTED')) >= 2);
    const outcomes = await db()`SELECT outcome FROM payment_notifications WHERE merchant_trade_no = ${co.merchantTradeNo} ORDER BY id`;
    assert.deepEqual(outcomes.map((o) => o.outcome), ['IP_NOT_ALLOWED', 'CREDITED', 'DUPLICATE', 'REPLAY_MISMATCH']);
  });
});

describe('generic error messages', () => {
  it('unexpected errors return a generic 500 without internals or stack traces', async () => {
    const boom = route(async () => {
      throw new Error('connection to db at 10.0.0.5 failed: password=hunter2');
    });
    const orig = console.error;
    console.error = () => undefined;
    try {
      const res = await boom(req('GET', '/api/x'));
      const text = await res.text();
      assert.equal(res.status, 500);
      assert.deepEqual(JSON.parse(text), { error: { code: 'INTERNAL', message: 'internal error' } });
      assert.ok(!/hunter2|10\.0\.0\.5|at /.test(text));
    } finally {
      console.error = orig;
    }
  });
});

describe('login brute-force lockout', () => {
  it('OTP: exponential backoff after 3 failures → ACCOUNT_LOCKED even with the right code; logged', async () => {
    const phone = '0977000111';
    for (let i = 0; i < 3; i++) await expectAppError(loginWithOtp(phone, '999999', undefined, { ip: '203.0.113.99' }), 'UNAUTHENTICATED');
    await expectAppError(loginWithOtp(phone, '000000'), 'ACCOUNT_LOCKED');
    const [l] = await db()`SELECT failures, locked_until > now() AS locked FROM auth_lockouts WHERE key = ${`otp:${phone}`}`;
    assert.deepEqual(l, { failures: 3, locked: true });
    assert.equal(await riskCount('LOGIN_LOCKOUT', db()`AND ip = '203.0.113.99'`), 1);
    await db()`UPDATE auth_lockouts SET locked_until = now() - interval '1 second' WHERE key = ${`otp:${phone}`}`;
    await expectAppError(loginWithOtp(phone, '999999'), 'UNAUTHENTICATED');
    const [l2] = await db()`SELECT failures, extract(epoch FROM locked_until - now())::int AS secs FROM auth_lockouts WHERE key = ${`otp:${phone}`}`;
    assert.equal(l2!.failures, 4);
    assert.ok((l2!.secs as number) >= 3 && (l2!.secs as number) <= 4, 'backoff doubles (2s → 4s)');
    await db()`UPDATE auth_lockouts SET locked_until = NULL WHERE key = ${`otp:${phone}`}`;
    const ok = await loginWithOtp(phone, '000000');
    assert.ok(ok.token);
    assert.equal((await db()`SELECT 1 FROM auth_lockouts WHERE key = ${`otp:${phone}`}`).length, 0, 'success clears the counter');
  });
});
