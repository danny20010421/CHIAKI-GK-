/** 邀請碼：20 位完成註冊＋手機驗證 → 邀請人 1000 不可退款代幣（一次、並發安全）；同裝置 / 連號門號 / 同 IP 爆量 → 標記不計入 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/server/db';
import { loginWithOtp } from '../src/server/modules/auth/users';
import { recordDevice } from '../src/server/modules/risk/risk';
import { getOrCreateReferralCode, getReferralSummary } from '../src/server/modules/referral/referral';
import { getWallet } from '../src/server/modules/wallet/wallet';
import { createRefundRequest } from '../src/server/modules/wallet/refunds';
import { verifyAuditChain } from '../src/server/modules/audit/audit';
import { POST as otpVerify } from '../src/app/api/auth/otp/verify/route';
import { GET as referralRoute } from '../src/app/api/me/referral/route';
import { apiRequest, expectAppError, ledgerOf, makeUser, setupTestDb } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
before(async () => {
  env = await setupTestDb();
});
after(async () => {
  await env.teardown();
});

let n = 0;
/** 前 8 碼各不相同的手機號碼 */
const distinctPhone = () => {
  n++;
  return `098${String(n).padStart(3, '0')}${String((n * 7919) % 10000).padStart(4, '0')}`;
};
let ipN = 0;
const distinctIp = () => `100.64.${(++ipN >> 8) & 255}.${ipN & 255}`;
const invite = (code: string, o: { phone?: string; ip?: string | null; fp?: string } = {}) =>
  loginWithOtp(o.phone ?? distinctPhone(), '000000', o.fp, { inviteCode: code, ip: o.ip === undefined ? distinctIp() : o.ip });

describe('referral reward', () => {
  it('20 qualified invitees → 1000 non-refundable coins once; 21st does not pay again', async () => {
    const inviter = await makeUser();
    const code = await getOrCreateReferralCode(db(), inviter.id);
    assert.match(code, /^[A-Z0-9]{8}$/);
    assert.equal(await getOrCreateReferralCode(db(), inviter.id), code, 'stable per user');
    for (let i = 0; i < 19; i++) assert.equal((await invite(code)).referral?.status, 'QUALIFIED');
    assert.equal((await getWallet(db(), inviter.id)).coins, 0);
    await invite(code.toLowerCase()); // 大小寫不敏感
    const w = await getWallet(db(), inviter.id);
    assert.deepEqual([w.coins, w.nonRefundableCoins, w.refundableCoins], [1000, 1000, 0]);
    const led = (await ledgerOf(inviter.id)).filter((l) => l.entryType === 'REFERRAL_REWARD');
    assert.deepEqual(led.map((l) => [l.amount, l.refundable]), [[1000, false]]);
    await expectAppError(createRefundRequest(inviter.id, 1, 'cash out'), 'INSUFFICIENT_FUNDS');
    await invite(code);
    assert.equal((await getWallet(db(), inviter.id)).coins, 1000, 'reward granted only once');
    const s = await getReferralSummary(inviter.id);
    assert.deepEqual([s.qualified, s.remaining, s.reward?.coins], [21, 0, 1000]);
    const [note] = await db()`SELECT title FROM notifications WHERE user_id = ${inviter.id} AND type = 'REFERRAL_REWARD'`;
    assert.equal(note!.title, '邀請獎勵已入帳');
  });

  it('concurrent registrations crossing the threshold grant exactly once', async () => {
    const inviter = await makeUser();
    const code = await getOrCreateReferralCode(db(), inviter.id);
    for (let i = 0; i < 18; i++) await invite(code);
    await Promise.all(Array.from({ length: 6 }, () => invite(code)));
    assert.equal((await getWallet(db(), inviter.id)).coins, 1000);
    const [r] = await db()`SELECT count(*)::int AS n FROM referral_rewards WHERE inviter_id = ${inviter.id}`;
    assert.equal(r!.n, 1);
    assert.equal((await getReferralSummary(inviter.id)).qualified, 24);
    assert.equal((await verifyAuditChain(db())).ok, true);
  });
});

describe('referral anti-abuse', () => {
  it('same device as inviter, reused device, sequential phone prefix and IP bursts are flagged and not counted', async () => {
    const inviter = await makeUser();
    const code = await getOrCreateReferralCode(db(), inviter.id);
    await recordDevice(db(), inviter.id, 'inviter-device-0001');
    const same = await invite(code, { fp: 'inviter-device-0001' });
    assert.equal(same.referral?.status, 'FLAGGED');
    assert.deepEqual(same.referral?.reasons, ['SAME_DEVICE_AS_INVITER']);
    assert.equal((await invite(code, { fp: 'farm-device-0001' })).referral?.status, 'QUALIFIED');
    assert.equal((await invite(code, { fp: 'farm-device-0001' })).referral?.status, 'FLAGGED', 'second account on the same device');
    // 連號門號：前 8 碼相同已有 3 個 → 第 4 個標記
    const prefixStatuses = [];
    for (const tail of ['01', '02', '03', '04']) prefixStatuses.push((await invite(code, { phone: `09887766${tail}` })).referral?.status);
    assert.deepEqual(prefixStatuses, ['QUALIFIED', 'QUALIFIED', 'QUALIFIED', 'FLAGGED']);
    // 同一 IP 短時間大量註冊：已有 3 筆 → 第 4 筆標記
    const ipStatuses = [];
    for (let i = 0; i < 4; i++) ipStatuses.push((await invite(code, { ip: '198.18.0.77' })).referral?.status);
    assert.deepEqual(ipStatuses, ['QUALIFIED', 'QUALIFIED', 'QUALIFIED', 'FLAGGED']);
    const s = await getReferralSummary(inviter.id);
    assert.deepEqual([s.qualified, s.flagged], [7, 4]);
    const ev = await db()`SELECT count(*)::int AS n FROM risk_events WHERE type = 'REFERRAL_ABUSE'`;
    assert.equal(ev[0]!.n, 4);
  });

  it('invalid code and existing members are ignored; self-referral impossible', async () => {
    const r = await invite('ZZZZZZZZ');
    assert.equal(r.referral?.status, 'INVALID_CODE');
    assert.equal((await db()`SELECT 1 FROM referrals WHERE invitee_id = ${r.userId}`).length, 0);
    const inviter = await makeUser();
    const code = await getOrCreateReferralCode(db(), inviter.id);
    const [{ phone }] = (await db()`SELECT phone FROM users WHERE id = ${inviter.id}`) as unknown as [{ phone: string }];
    const again = await loginWithOtp(phone, '000000', undefined, { inviteCode: code });
    assert.equal(again.isNew, false);
    assert.equal(again.referral, null);
  });

  it('HTTP: register with inviteCode, then GET /api/me/referral', async () => {
    const inviter = await makeUser();
    const code = (await getReferralSummary(inviter.id)).code;
    const res = await otpVerify(apiRequest('POST', '/api/auth/otp/verify', { body: { phone: distinctPhone(), code: '000000', inviteCode: code }, headers: { 'x-forwarded-for': distinctIp() } }), undefined as never);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { referral: { status: string } }).referral.status, 'QUALIFIED');
    const me = (await (await referralRoute(apiRequest('GET', '/api/me/referral', { token: inviter.token }), undefined as never)).json()) as { code: string; qualified: number; threshold: number; rewardCoins: number; rule: string };
    assert.deepEqual([me.code, me.qualified, me.threshold, me.rewardCoins], [code, 1, 20, 1000]);
    assert.match(me.rule, /不可退款/);
  });
});
