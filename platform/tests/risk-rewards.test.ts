import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/server/db';
import { resetConfig } from '../src/server/config';
import { holdTickets } from '../src/server/modules/draw/holds';
import { loginWithOtp } from '../src/server/modules/auth/users';
import { claimReward, listRewardTasks } from '../src/server/modules/rewards/rewards';
import { expectAppError, makeUser, publishPool, setupTestDb, smallPool, walletOf } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
before(async () => {
  env = await setupTestDb({ RISK_HOLD_LIMIT_PER_MIN: '5' });
});
after(async () => {
  await env.teardown();
});

describe('risk hooks', () => {
  it('rate-limits holds per user and records a single risk event', async () => {
    const poolId = await publishPool(smallPool());
    const u = await makeUser();
    for (let i = 1; i <= 5; i++) await holdTickets(u.id, poolId, 1, [i]);
    await expectAppError(holdTickets(u.id, poolId, 1, [6]), 'RATE_LIMITED');
    await expectAppError(holdTickets(u.id, poolId, 1, [7]), 'RATE_LIMITED');
    const ev = await db()`SELECT type FROM risk_events WHERE user_id = ${u.id}`;
    assert.deepEqual(ev.map((e) => e.type), ['RATE_LIMIT_HOLD']);
    const other = await makeUser();
    await holdTickets(other.id, poolId, 1, [8]);
  });

  it('flags many accounts on one device fingerprint', async () => {
    const fp = 'device-fp-abcdef123456';
    for (const phone of ['0911000001', '0911000002']) await loginWithOtp(phone, '000000', fp);
    let ev = await db()`SELECT type FROM risk_events WHERE type = 'MULTI_ACCOUNT_DEVICE'`;
    assert.equal(ev.length, 0);
    const third = await loginWithOtp('0911000003', '000000', fp);
    ev = await db()`SELECT user_id, details_json FROM risk_events WHERE type = 'MULTI_ACCOUNT_DEVICE'`;
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!.userId, third.userId);
    await loginWithOtp('0911000003', '000000', fp); // 同帳號再登入不重複標記
    assert.equal((await db()`SELECT 1 FROM risk_events WHERE type = 'MULTI_ACCOUNT_DEVICE'`).length, 1);
    await expectAppError(loginWithOtp('0911000004', '123456', fp), 'UNAUTHENTICATED');
  });
});

describe('binding rewards (綁定獎勵)', () => {
  it('each task grants once per user, even under concurrent claims', async () => {
    const u = await makeUser();
    const rs = await Promise.allSettled(Array.from({ length: 8 }, () => claimReward(u.id, 'BIND_LINE_OA')));
    assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
    assert.ok(rs.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.code === 'ALREADY_CLAIMED'));
    assert.deepEqual(await walletOf(u.id), { coins: 50, nonRefundableCoins: 50 }, 'binding rewards are non-refundable CC幣');
    const coupons = await db()`SELECT code FROM user_coupons WHERE user_id = ${u.id}`;
    assert.deepEqual(coupons.map((c) => c.code), ['LINE-WELCOME']);
    await claimReward(u.id, 'BIND_PHONE');
    const tasks = await listRewardTasks(db(), u.id);
    assert.deepEqual(tasks.filter((t) => t.claimed).map((t) => t.code).sort(), ['BIND_LINE_OA', 'BIND_PHONE']);
    assert.deepEqual(await walletOf(u.id), { coins: 70, nonRefundableCoins: 70 });
  });

  it('BIND_PHONE requires a phone; social tasks need real verification when the stub is off', async () => {
    const u = await makeUser({ phone: null });
    await expectAppError(claimReward(u.id, 'BIND_PHONE'), 'INVALID_STATE');
    process.env.REWARD_VERIFY_STUB = '0';
    resetConfig();
    try {
      await expectAppError(claimReward(u.id, 'FOLLOW_IG'), 'NOT_IMPLEMENTED');
    } finally {
      process.env.REWARD_VERIFY_STUB = '1';
      resetConfig();
    }
  });
});
