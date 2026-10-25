/**
 * 部署準備：健康檢查（/api/health、/api/ready）、後台網域分離（ADMIN_HOST）、CORS、CSRF 後台 origin、
 * 測試模式（金流/簡訊停用）與上線前檢查、媒體 CDN 網址、抽賞演出影片、資料 migration、第一個超級管理員、結構化日誌。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, deploymentMode, liveModeProblems, resetConfig } from '../src/server/config';
import { db } from '../src/server/db';
import { migrationStatus } from '../src/server/lib/migrations';
import { mediaUrl } from '../src/server/lib/media';
import { formatLog } from '../src/server/lib/log';
import { csrfViolation, CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '../src/server/security/cookies';
import { adminHostAllowed, corsHeaders, preflightResponse, requestHost } from '../src/server/security/hosts';
import { requestOtp } from '../src/server/modules/auth/users';
import { adminLogin } from '../src/server/modules/auth/admin-auth';
import { updatePoolSettings } from '../src/server/modules/pool/admin';
import { createSuperAdmin } from '../src/server/ops/bootstrap';
import { loadTiers } from '../src/server/modules/vip/vip';
import { seedHomeBanners, VIP_TIER_DEFAULTS, WK_POOL } from '../src/server/seed/reference';
import { middleware } from '../src/middleware';
import { GET as healthRoute } from '../src/app/api/health/route';
import { GET as readyRoute } from '../src/app/api/ready/route';
import { GET as poolsRoute } from '../src/app/api/pools/route';
import { GET as poolRoute } from '../src/app/api/pools/[id]/route';
import { GET as auditVerify } from '../src/app/api/admin/audit/verify/route';
import { GET as hintRoute } from '../src/app/api/auth/admin/hint/route';
import { GET as adminPoolRoute } from '../src/app/api/admin/pools/[id]/route';
import { liveBanners } from '../src/server/modules/marketing/marketing';
import { apiRequest, ctx, customPool, expectAppError, makeUser, publishPool, setupTestDb } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
before(async () => {
  env = await setupTestDb();
});
after(async () => {
  await env.teardown();
});

const none = undefined as never;
const j = async <T = Record<string, unknown>>(r: Response) => ({ status: r.status, body: (await r.json()) as T });

/** 暫時改環境變數（結束後還原並重新讀取設定） */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfig();
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetConfig();
  }
}

describe('health & readiness', () => {
  it('GET /api/health: 200 liveness with deployment mode (no secrets), security headers, no-store', async () => {
    const r = await healthRoute(apiRequest('GET', '/api/health'), none);
    const { status, body } = await j<{ status: string; uptimeSec: number; mode: Record<string, unknown> }>(r);
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.uptimeSec, 'number');
    assert.deepEqual(Object.keys(body.mode).sort(), ['adminHost', 'mediaCdn', 'payments', 'sms', 'testMode']);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.ok(!/HASH|KEY|PASSWORD/i.test(JSON.stringify(body)));
  });

  it('health is a probe: not rate limited (platforms poll it every few seconds)', async () => {
    await withEnv({ RATE_LIMIT_IP_CAPACITY: '2', RATE_LIMIT_IP_REFILL_PER_SEC: '0.001' }, async () => {
      for (let i = 0; i < 6; i++) {
        const r = await healthRoute(apiRequest('GET', '/api/health', { headers: { 'x-forwarded-for': '10.250.0.1' } }), none);
        assert.equal(r.status, 200);
      }
    });
  });

  it('GET /api/ready: 200 when the database is reachable and every migration is applied', async () => {
    const { status, body } = await j<{ status: string; database: string; migrations: { total: number; applied: number; pending: string[]; modified: string[] } }>(
      await readyRoute(apiRequest('GET', '/api/ready'), none),
    );
    assert.equal(status, 200);
    assert.equal(body.status, 'ready');
    assert.equal(body.database, 'ok');
    assert.deepEqual([body.migrations.pending, body.migrations.modified], [[], []]);
    assert.equal(body.migrations.total, body.migrations.applied);
    assert.ok(body.migrations.total >= 15);
  });

  it('GET /api/ready: 503 when the database is unreachable (no internals leaked)', async () => {
    const orig = console.error;
    console.error = () => undefined;
    try {
      // 另開一個指向不存在埠的連線池（db() 單例在 resetConfig 後仍是原連線，因此改用 closeDb + 新 URL）
      const { closeDb } = await import('../src/server/db');
      const saved = process.env.DATABASE_URL!;
      await closeDb();
      await withEnv({ DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' }, async () => {
        const { status, body } = await j<{ status: string; database: string }>(await readyRoute(apiRequest('GET', '/api/ready'), none));
        assert.deepEqual([status, body.status, body.database], [503, 'not_ready', 'unreachable']);
        assert.ok(!JSON.stringify(body).includes('127.0.0.1'));
        await closeDb();
      });
      process.env.DATABASE_URL = saved;
      resetConfig();
    } finally {
      console.error = orig;
    }
  });

  it('migrationStatus reports pending and modified migrations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chiaki-mig-'));
    try {
      const real = join(process.cwd(), 'prisma', 'migrations');
      const first = '20261023000000_init';
      mkdirSync(join(dir, first));
      writeFileSync(join(dir, first, 'migration.sql'), readFileSync(join(real, first, 'migration.sql'), 'utf8') + '\n-- edited');
      mkdirSync(join(dir, '29990101000000_future'));
      writeFileSync(join(dir, '29990101000000_future', 'migration.sql'), 'SELECT 1;');
      const s = await migrationStatus(db(), dir);
      assert.deepEqual(s.pending, ['29990101000000_future']);
      assert.deepEqual(s.modified, [first]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('admin host separation (ADMIN_HOST)', () => {
  it('admin APIs answer 404 on any other host; work on the admin host; unrestricted when unset', async () => {
    const boss = await makeUser({ roles: ['SUPER_ADMIN'] });
    const at = (host: string, path: string) => new Request(`http://${host}${path}`, { headers: { authorization: `Bearer ${boss.token}` } });
    await withEnv({ ADMIN_HOST: 'admin.chiaki.test' }, async () => {
      const pub = await j<{ error: { code: string } }>(await auditVerify(at('www.chiaki.test', '/api/admin/audit/verify'), none));
      assert.deepEqual([pub.status, pub.body.error.code], [404, 'NOT_FOUND']);
      const hint = await hintRoute(new Request('http://www.chiaki.test/api/auth/admin/hint?loginId=admin'), none);
      assert.equal(hint.status, 404, 'admin login helpers are admin-host only too');
      assert.equal((await auditVerify(at('admin.chiaki.test', '/api/admin/audit/verify'), none)).status, 200);
      assert.equal((await auditVerify(at('ADMIN.chiaki.test:443', '/api/admin/audit/verify'), none)).status, 200, 'case and port insensitive');
      // 公開 API 不受影響
      assert.equal((await poolsRoute(new Request('http://www.chiaki.test/api/pools'), none)).status, 200);
      // Host header（反向代理）優先於 URL
      const viaHeader = new Request('http://internal:3000/api/admin/audit/verify', { headers: { host: 'admin.chiaki.test', authorization: `Bearer ${boss.token}` } });
      assert.equal((await auditVerify(viaHeader, none)).status, 200);
    });
    await withEnv({ ADMIN_HOST: 'admin.chiaki.test', HOST_HEADER: 'x-forwarded-host' }, () => {
      const r = new Request('http://internal/api/admin/x', { headers: { host: 'internal', 'x-forwarded-host': 'admin.chiaki.test, proxy' } });
      assert.equal(requestHost(r), 'admin.chiaki.test');
      assert.equal(adminHostAllowed(r), true);
    });
    assert.equal((await auditVerify(at('anything.example', '/api/admin/audit/verify'), none)).status, 200, 'no ADMIN_HOST → single-domain deploy');
  });
});

describe('CORS & CSRF origins', () => {
  const site = 'https://www.chiaki.test';
  const admin = 'https://admin.chiaki.test';
  const cfg = { APP_BASE_URL: site, ADMIN_HOST: 'admin.chiaki.test', CORS_ALLOWED_ORIGINS: 'https://chiaki.test, https://preview.chiaki.test' };

  it('public API: allow-listed origins get Access-Control-Allow-Origin with credentials; others get nothing', async () => {
    await withEnv(cfg, async () => {
      for (const origin of [site, 'https://chiaki.test', 'https://preview.chiaki.test']) {
        const r = await poolsRoute(apiRequest('GET', '/api/pools', { headers: { origin } }), none);
        assert.equal(r.headers.get('access-control-allow-origin'), origin);
        assert.equal(r.headers.get('access-control-allow-credentials'), 'true');
        assert.match(r.headers.get('vary') ?? '', /Origin/);
      }
      const evil = await poolsRoute(apiRequest('GET', '/api/pools', { headers: { origin: 'https://evil.example' } }), none);
      assert.equal(evil.headers.get('access-control-allow-origin'), null);
      const noOrigin = await poolsRoute(apiRequest('GET', '/api/pools'), none);
      assert.equal(noOrigin.headers.get('access-control-allow-origin'), null);
    });
  });

  it('admin API: only the admin origin is allowed cross-origin', async () => {
    await withEnv(cfg, () => {
      const req = (origin: string) => new Request('https://admin.chiaki.test/api/admin/pools', { headers: { origin } });
      assert.equal(corsHeaders(req(admin))['access-control-allow-origin'], admin);
      assert.equal(corsHeaders(req(site))['access-control-allow-origin'], undefined);
    });
  });

  it('preflight (middleware): 204 with methods/headers for allowed origins, 403 otherwise, 404 for admin paths off the admin host', async () => {
    await withEnv(cfg, () => {
      const pre = (url: string, origin: string) => new Request(url, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' } });
      const ok = middleware(pre('https://api.chiaki.test/api/draws', site))!;
      assert.equal(ok.status, 204);
      assert.match(ok.headers.get('access-control-allow-headers')!, /x-csrf-token/);
      assert.match(ok.headers.get('access-control-allow-headers')!, /idempotency-key/);
      assert.match(ok.headers.get('access-control-allow-methods')!, /PATCH/);
      assert.equal(preflightResponse(pre('https://api.chiaki.test/api/draws', 'https://evil.example')).status, 403);
      assert.equal(preflightResponse(pre('https://www.chiaki.test/api/admin/pools', admin)).status, 404);
      assert.equal(preflightResponse(pre('https://admin.chiaki.test/api/admin/pools', admin)).status, 204);
      assert.equal(middleware(new Request('https://www.chiaki.test/api/pools')), undefined, 'non-OPTIONS requests pass through');
    });
  });

  it('cookie CSRF accepts the site, extra and admin origins; rejects others', async () => {
    await withEnv(cfg, () => {
      const post = (origin: string) =>
        new Request('https://admin.chiaki.test/api/admin/pools', {
          method: 'POST',
          headers: { origin, cookie: `${SESSION_COOKIE}=x; ${CSRF_COOKIE}=tok123`, [CSRF_HEADER]: 'tok123' },
        });
      assert.equal(csrfViolation(post(site)), null);
      assert.equal(csrfViolation(post(admin)), null);
      assert.equal(csrfViolation(post('https://chiaki.test')), null);
      assert.equal(csrfViolation(post('https://evil.example')), 'cross-origin request');
    });
  });
});

describe('test mode: payments and SMS disabled with clear errors; live-mode guard', () => {
  it('defaults report test mode with payments DISABLED; health shows it', async () => {
    await withEnv({ SITE_TEST_MODE: undefined, PAYMENT_SANDBOX: undefined, AUTH_DEV_STUB: '0', MITAKE_USERNAME: '', MITAKE_PASSWORD: '' }, async () => {
      assert.deepEqual(deploymentMode(), { testMode: true, payments: 'DISABLED', sms: 'DISABLED', adminHost: null, mediaCdn: false });
      const { body } = await j<{ mode: { testMode: boolean; payments: string } }>(await healthRoute(apiRequest('GET', '/api/health'), none));
      assert.deepEqual([body.mode.testMode, body.mode.payments], [true, 'DISABLED']);
    });
    await withEnv({ SITE_TEST_MODE: 'true', PAYMENT_SANDBOX: '1' }, () => assert.equal(deploymentMode().payments, 'SANDBOX'));
  });

  it('OTP without an SMS provider → 503 SMS_DISABLED with a clear Traditional Chinese message', async () => {
    await withEnv({ AUTH_DEV_STUB: '0', MITAKE_USERNAME: '', MITAKE_PASSWORD: '' }, async () => {
      await assert.rejects(requestOtp('0912345678'), (e: { code?: string; status?: number; message: string }) => {
        assert.deepEqual([e.code, e.status], ['SMS_DISABLED', 503]);
        assert.match(e.message, /簡訊服務尚未啟用（測試模式/);
        return true;
      });
    });
  });

  it('production may start in test mode without ECPay/SMS credentials, but SITE_TEST_MODE=false requires live settings', async () => {
    const prod = { NODE_ENV: 'production', AUTH_DEV_STUB: '0', REWARD_VERIFY_STUB: '0', NOTIFY_STUB_SEND: '0', ECPAY_ACCEPT_SIMULATED: '0', MFA_ENCRYPTION_KEY: 'a'.repeat(64) };
    await withEnv({ ...prod, SITE_TEST_MODE: 'true', MITAKE_USERNAME: '', MITAKE_PASSWORD: '' }, () => {
      assert.equal(config().SITE_TEST_MODE, true);
      assert.equal(deploymentMode().sms, 'DISABLED');
    });
    await withEnv({ ...prod, SITE_TEST_MODE: 'false', MITAKE_USERNAME: '', MITAKE_PASSWORD: '' }, () => {
      assert.throws(() => config(), /SITE_TEST_MODE=false requires live ECPay \/ SMS settings: .*STAGE merchant.*MITAKE/);
    });
    const live = {
      ...prod,
      SITE_TEST_MODE: 'false',
      APP_BASE_URL: 'https://www.chiaki.test',
      ECPAY_MERCHANT_ID: '3999999',
      ECPAY_HASH_KEY: 'k'.repeat(16),
      ECPAY_HASH_IV: 'v'.repeat(16),
      ECPAY_AIO_URL: 'https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5',
      MITAKE_USERNAME: 'u',
      MITAKE_PASSWORD: 'p',
    };
    await withEnv(live, () => {
      assert.deepEqual(liveModeProblems(config()), []);
      assert.deepEqual([deploymentMode().payments, deploymentMode().sms], ['LIVE', 'CONFIGURED']);
    });
  });
});

describe('media base URL (CDN) and draw-animation videos', () => {
  it('mediaUrl: prefixes site media paths only; keeps https:// and /api/ asset URLs', () => {
    assert.equal(mediaUrl('/media/video/gacha1.mp4', 'https://cdn.chiaki.test/'), 'https://cdn.chiaki.test/media/video/gacha1.mp4');
    assert.equal(mediaUrl('/media/x.jpg', ''), '/media/x.jpg');
    assert.equal(mediaUrl('/api/assets/abc', 'https://cdn.chiaki.test'), '/api/assets/abc');
    assert.equal(mediaUrl('https://img.example/x.jpg', 'https://cdn.chiaki.test'), 'https://img.example/x.jpg');
    assert.equal(mediaUrl(null), null);
  });

  it('世界之王 seed has the three draw videos with result-based behaviour', () => {
    assert.deepEqual(WK_POOL.videos, [
      { url: '/media/video/gacha1.mp4', behavior: { kind: 'beam', beamAt: 7.4 } },
      { url: '/media/video/gacha2.mp4', behavior: { kind: 'kills', stop: { low: 13.9, mid: 15.6 } } },
      { url: '/media/video/gacha3.mp4', behavior: { kind: 'plain' } },
    ]);
  });

  it('pool videos & cover: stored as paths, served through MEDIA_BASE_URL; admin can replace; bad behaviour rejected', async () => {
    const poolId = await publishPool(
      customPool({
        animation: 'VIDEO',
        coverUrl: '/media/pools/test-cover.jpg',
        videos: WK_POOL.videos,
        prizes: [
          { rank: 'A', name: '大獎', qtyPerSet: 1, imageUrl: '/media/prizes/a.jpg' },
          { rank: 'B', name: '小獎', qtyPerSet: 9, imageUrl: '/api/assets/00000000-0000-0000-0000-000000000000' },
        ],
      }),
    );
    type Detail = { coverUrl: string | null; videos: { url: string; behavior: Record<string, unknown> }[]; prizes: { imageUrl: string | null }[] };
    const plain = await j<Detail>(await poolRoute(apiRequest('GET', `/api/pools/${poolId}`), ctx({ id: poolId })));
    assert.equal(plain.status, 200);
    assert.equal(plain.body.coverUrl, '/media/pools/test-cover.jpg');
    assert.deepEqual(plain.body.videos.map((v) => v.url), ['/media/video/gacha1.mp4', '/media/video/gacha2.mp4', '/media/video/gacha3.mp4']);
    assert.deepEqual(plain.body.videos[1]!.behavior, { kind: 'kills', stop: { low: 13.9, mid: 15.6 } });
    await withEnv({ MEDIA_BASE_URL: 'https://cdn.chiaki.test' }, async () => {
      const cdn = await j<Detail>(await poolRoute(apiRequest('GET', `/api/pools/${poolId}`), ctx({ id: poolId })));
      assert.equal(cdn.body.coverUrl, 'https://cdn.chiaki.test/media/pools/test-cover.jpg');
      assert.equal(cdn.body.videos[0]!.url, 'https://cdn.chiaki.test/media/video/gacha1.mp4');
      assert.deepEqual(cdn.body.prizes.map((p) => p.imageUrl), ['https://cdn.chiaki.test/media/prizes/a.jpg', '/api/assets/00000000-0000-0000-0000-000000000000']);
      const list = await j<{ pools: { id: string; coverUrl: string | null }[] }>(await poolsRoute(apiRequest('GET', '/api/pools'), none));
      assert.equal(list.body.pools.find((p) => p.id === poolId)!.coverUrl, 'https://cdn.chiaki.test/media/pools/test-cover.jpg');
      await seedHomeBanners(db());
      const banners = await liveBanners(db(), new Date('2026-11-01T00:00:00Z'));
      assert.ok(banners.length > 0);
      for (const b of banners) assert.match(b.desktopImageUrl, /^https:\/\/cdn\.chiaki\.test\/media\/banners\//);
    });

    const ops = await makeUser({ roles: ['OPS'] });
    const r = await updatePoolSettings(ops.principal, poolId, { videos: [{ url: '/media/video/gacha3.mp4' }, { url: 'https://cdn.example/v.mp4', behavior: { kind: 'beam', beamAt: 3 }, enabled: false }], coverUrl: null });
    assert.equal(r.coverUrl, null);
    assert.deepEqual(r.videos.map((v) => [v.path, v.behavior.kind, v.enabled]), [['/media/video/gacha3.mp4', 'plain', true], ['https://cdn.example/v.mp4', 'beam', false]]);
    const after = await j<Detail>(await poolRoute(apiRequest('GET', `/api/pools/${poolId}`), ctx({ id: poolId })));
    assert.deepEqual(after.body.videos, [{ url: '/media/video/gacha3.mp4', behavior: { kind: 'plain' } }], 'disabled videos are hidden publicly');
    const adminView = await j<{ videos: { path: string; enabled: boolean }[] }>(await adminPoolRoute(apiRequest('GET', `/api/admin/pools/${poolId}`, { token: ops.token }), ctx({ id: poolId })));
    assert.deepEqual(adminView.body.videos.map((v) => [v.path, v.enabled]), [['/media/video/gacha3.mp4', true], ['https://cdn.example/v.mp4', false]]);
    const [a] = await db()<{ payloadJson: string }[]>`SELECT payload_json FROM audit_log WHERE action = 'POOL_SETTINGS_UPDATED' AND entity_id = ${poolId} ORDER BY seq DESC LIMIT 1`;
    assert.match(a!.payloadJson, /gacha2\.mp4/, 'audit keeps the previous video list');

    await assert.rejects(updatePoolSettings(ops.principal, poolId, { videos: [{ url: '/media/v.mp4', behavior: { kind: 'beam' } }] }), /beamAt/);
    await assert.rejects(updatePoolSettings(ops.principal, poolId, { videos: [{ url: '/media/v.mp4', behavior: { kind: 'kills', stop: { low: 1 } } }] }), /stop/);
    await assert.rejects(updatePoolSettings(ops.principal, poolId, { videos: [{ url: 'http://insecure/v.mp4' }] }));
    await assert.rejects(updatePoolSettings(ops.principal, poolId, { videos: [{ url: '/media/a.mp4' }, { url: '/media/a.mp4' }] }), /不可重複/);
    await assert.rejects(updatePoolSettings(ops.principal, poolId, { coverUrl: 'javascript:alert(1)' }));
  });
});

describe('data migration 20261106000000', () => {
  const sql = readFileSync('prisma/migrations/20261106000000_vip1_birthday_media_videos/migration.sql', 'utf8');
  const statement = (startsWith: string) => {
    const i = sql.indexOf(startsWith);
    assert.ok(i >= 0, startsWith);
    return sql.slice(i, sql.indexOf(';', i) + 1);
  };

  it('VIP1 銅籤 birthday gift is 0 after migrate + seed; re-running the UPDATE fixes a stale 50 and leaves other tiers alone', async () => {
    assert.deepEqual(await loadTiers(db()), VIP_TIER_DEFAULTS);
    assert.equal(VIP_TIER_DEFAULTS[1]!.birthdayGiftCoins, 0);
    await db()`UPDATE vip_tiers SET birthday_gift_coins = 50 WHERE level = 1`;
    await db().unsafe(statement('UPDATE vip_tiers SET birthday_gift_coins = 0'));
    const tiers = await loadTiers(db());
    assert.deepEqual(tiers.map((t) => t.birthdayGiftCoins), [0, 0, 100, 500, 2000, 5000, 10000]);
  });

  it('backfills the three 世界之王 videos for an existing pool (idempotent)', async () => {
    const poolId = await publishPool(customPool({ slug: 'wk-world-king', animation: 'VIDEO' }));
    const insert = statement('INSERT INTO pool_videos');
    await db().unsafe(insert);
    await db().unsafe(insert);
    const rows = await db()<{ url: string; behaviorJson: string }[]>`SELECT url, behavior_json FROM pool_videos WHERE pool_id = ${poolId} ORDER BY sort_order`;
    assert.deepEqual(rows.map((r) => [r.url, JSON.parse(r.behaviorJson)]), WK_POOL.videos!.map((v) => [v.url, v.behavior]));
  });
});

describe('first super-admin', () => {
  it('creates a SUPER_ADMIN with password login (scrypt), audited; duplicate login and weak password refused', async () => {
    const r = await createSuperAdmin({ loginId: 'Owner.Admin', password: 'correct horse battery', displayName: '業主' });
    assert.equal(r.loginId, 'owner.admin');
    const [role] = await db()<{ role: string }[]>`SELECT role FROM user_roles WHERE user_id = ${r.userId}`;
    assert.equal(role!.role, 'SUPER_ADMIN');
    const [cred] = await db()<{ passwordHash: string }[]>`SELECT password_hash FROM admin_credentials WHERE user_id = ${r.userId}`;
    assert.match(cred!.passwordHash, /^scrypt\$/);
    const login = await adminLogin({ loginId: 'owner.admin', password: 'correct horse battery' });
    assert.equal(login.userId, r.userId);
    assert.ok(login.token.length >= 20, 'password login works');
    assert.equal(login.mfaEnabled, false, 'TOTP is enrolled after first login');
    const [a] = await db()<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log WHERE action = 'ADMIN_ACCOUNT_CREATED' AND entity_id = ${r.userId}`;
    assert.equal(a!.n, 1);
    await expectAppError(createSuperAdmin({ loginId: 'owner.admin', password: 'another long password' }), 'CONFLICT');
    await assert.rejects(createSuperAdmin({ loginId: 'second', password: 'short' }), /12/);
  });
});

describe('structured logging', () => {
  it('one JSON object per line with ts / level / msg and serialized errors', () => {
    const line = formatLog('error', 'boom', { job: 'x', err: Object.assign(new Error('bad'), { code: 'E1' }) }, new Date('2026-10-25T00:00:00Z'));
    const o = JSON.parse(line) as { ts: string; level: string; msg: string; job: string; err: { name: string; message: string; code: string } };
    assert.deepEqual([o.ts, o.level, o.msg, o.job, o.err.name, o.err.message, o.err.code], ['2026-10-25T00:00:00.000Z', 'error', 'boom', 'x', 'Error', 'bad', 'E1']);
    assert.ok(!line.includes('\n'));
  });
});
