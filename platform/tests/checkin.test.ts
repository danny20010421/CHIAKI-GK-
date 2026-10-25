import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/server/db';
import { addDays, taipeiDay } from '../src/server/lib/taipei';
import { CHECKIN_REWARDS, checkIn, checkinReward, cyclePosition, getCheckinStatus } from '../src/server/modules/checkin/checkin';
import { getCoinBreakdown, reconcileWallets } from '../src/server/modules/wallet/wallet';
import { GET as statusRoute, POST as checkinRoute } from '../src/app/api/me/checkin/route';
import { apiRequest, ledgerOf, makeUser, setupTestDb, walletOf } from './helpers';

const none = undefined as never;
/** 台灣時間 YYYY-MM-DD HH:mm → Date */
const tw = (day: string, hm = '12:00') => new Date(`${day}T${hm}:00+08:00`);

describe('consecutive check-in rules (pure)', () => {
  it('Asia/Taipei calendar days; 7-day reward cycle by streak position', () => {
    assert.equal(taipeiDay(new Date('2026-10-25T15:59:00Z')), '2026-10-25'); // 台灣 23:59
    assert.equal(taipeiDay(new Date('2026-10-25T16:00:00Z')), '2026-10-26'); // 台灣 00:00
    assert.equal(addDays('2026-10-31', 1), '2026-11-01');
    assert.deepEqual([...CHECKIN_REWARDS], [2, 2, 2, 2, 2, 2, 10]);
    assert.deepEqual([1, 6, 7, 8, 13, 14, 15, 21].map(cyclePosition), [1, 6, 7, 1, 6, 7, 1, 7]);
    assert.deepEqual([1, 2, 6, 7, 8, 14, 15].map(checkinReward), [2, 2, 2, 10, 2, 10, 2]);
    assert.throws(() => cyclePosition(0));
  });
});

describe('daily check-in (consecutive streak)', () => {
  let env: Awaited<ReturnType<typeof setupTestDb>>;
  before(async () => {
    env = await setupTestDb();
  });
  after(async () => {
    await env.teardown();
  });

  it('days 1–6 → 2 UC幣, day 7 → 10, day 8 restarts the cycle at 2; once per day; consecutive across a month boundary', async () => {
    const u = await makeUser();
    const start = '2026-10-27'; // 10/27 … 11/05：跨月仍連續
    const got: number[] = [];
    for (let i = 0; i < 10; i++) {
      const day = addDays(start, i);
      const r = await checkIn(u.id, tw(day, '09:30'));
      assert.deepEqual([r.alreadyCheckedIn, r.streak, r.seq, r.day], [false, i + 1, (i % 7) + 1, day]);
      got.push(r.coins);
      const again = await checkIn(u.id, tw(day, '23:59'));
      assert.deepEqual([again.alreadyCheckedIn, again.streak, again.seq, again.coins], [true, i + 1, (i % 7) + 1, r.coins], 'idempotent per day');
    }
    assert.deepEqual(got, [2, 2, 2, 2, 2, 2, 10, 2, 2, 2]);
    const days = await db()<{ day: string; streak: number }[]>`SELECT to_char(day, 'YYYY-MM-DD') AS day, streak FROM member_checkins WHERE user_id = ${u.id} ORDER BY day`;
    assert.deepEqual(days.slice(4, 6), [{ day: '2026-10-31', streak: 5 }, { day: '2026-11-01', streak: 6 }], '10/31 → 11/01 stays consecutive');
    const led = (await ledgerOf(u.id)).filter((l) => l.entryType === 'CHECKIN');
    assert.deepEqual(led.map((l) => l.amount), got);
    assert.ok(led.every((l) => l.refundable === false), 'check-in coins are non-refundable');
    assert.deepEqual(await walletOf(u.id), { coins: 28, nonRefundableCoins: 28 });
    assert.equal((await getCoinBreakdown(db(), u.id)).nonRefundableCredited.CHECKIN, 28);
    assert.ok((await reconcileWallets(db(), u.id)).every((r) => r.ok));
  });

  it('status: completed day 7 shows a full cycle; the next day starts a fresh cycle at slot 1', async () => {
    const u = await makeUser();
    for (let i = 0; i < 7; i++) await checkIn(u.id, tw(addDays('2026-11-10', i)));
    const d7 = await getCheckinStatus(db(), u.id, tw('2026-11-16', '23:00'));
    assert.deepEqual([d7.streak, d7.position, d7.todayDone, d7.streakBroken], [7, 7, true, false]);
    assert.ok(d7.slots.every((s) => s.done));
    assert.deepEqual(d7.slots.map((s) => s.day), Array.from({ length: 7 }, (_, i) => addDays('2026-11-10', i)));
    assert.deepEqual(d7.nextReward, { seq: 1, streak: 8, coins: 2, day: '2026-11-17', availableToday: false });
    const d8 = await getCheckinStatus(db(), u.id, tw('2026-11-17', '08:00'));
    assert.deepEqual([d8.streak, d8.position, d8.todayDone], [7, 7, false]);
    assert.ok(d8.slots.every((s) => !s.done), 'new cycle shown empty');
    assert.deepEqual(d8.nextReward, { seq: 1, streak: 8, coins: 2, day: '2026-11-17', availableToday: true });
    const r8 = await checkIn(u.id, tw('2026-11-17', '08:00'));
    assert.deepEqual([r8.streak, r8.seq, r8.coins], [8, 1, 2]);
    assert.deepEqual(r8.status.slots.map((s) => s.done), [true, false, false, false, false, false, false]);
  });

  it('missing any day resets the streak to day 1 (status reports the break)', async () => {
    const u = await makeUser();
    for (let i = 0; i < 5; i++) await checkIn(u.id, tw(addDays('2026-12-01', i))); // 12/01–12/05：第 1–5 天
    const mid = await getCheckinStatus(db(), u.id, tw('2026-12-06'));
    assert.deepEqual([mid.streak, mid.position, mid.streakBroken, mid.nextReward.seq], [5, 5, false, 6], 'yesterday checked → streak alive');
    assert.deepEqual(mid.slots.map((s) => s.done), [true, true, true, true, true, false, false]);
    // 漏簽 12/06 → 12/07 狀態：已中斷，下一次為第 1 天
    const broken = await getCheckinStatus(db(), u.id, tw('2026-12-07'));
    assert.deepEqual([broken.streak, broken.position, broken.streakBroken, broken.lastCheckinDay], [0, 0, true, '2026-12-05']);
    assert.ok(broken.slots.every((s) => !s.done));
    assert.deepEqual(broken.nextReward, { seq: 1, streak: 1, coins: 2, day: '2026-12-07', availableToday: true });
    const r = await checkIn(u.id, tw('2026-12-07'));
    assert.deepEqual([r.streak, r.seq, r.coins], [1, 1, 2]);
    // 第 7 天前中斷：從未拿到 10 UC幣
    for (let i = 1; i < 6; i++) await checkIn(u.id, tw(addDays('2026-12-07', i))); // 12/08–12/12：第 2–6 天
    const r2 = await checkIn(u.id, tw('2026-12-14')); // 漏簽 12/13
    assert.deepEqual([r2.streak, r2.coins], [1, 2]);
    const coins = (await ledgerOf(u.id)).filter((l) => l.entryType === 'CHECKIN').map((l) => l.amount);
    assert.ok(!coins.includes(10));
    // 台灣日界：23:59 與隔天 00:00 為連續兩天
    const v = await makeUser();
    await checkIn(v.id, new Date('2026-12-20T15:59:00Z')); // 台灣 12/20 23:59
    const n = await checkIn(v.id, new Date('2026-12-20T16:00:00Z')); // 台灣 12/21 00:00
    assert.deepEqual([n.day, n.streak], ['2026-12-21', 2]);
  });

  it('concurrent POSTs on the same day grant once', async () => {
    const u = await makeUser();
    const now = tw('2026-11-10', '08:00');
    const rs = await Promise.all(Array.from({ length: 12 }, () => checkIn(u.id, now)));
    assert.equal(rs.filter((r) => !r.alreadyCheckedIn).length, 1);
    assert.ok(rs.every((r) => r.seq === 1 && r.streak === 1 && r.coins === 2));
    assert.equal((await ledgerOf(u.id)).filter((l) => l.entryType === 'CHECKIN').length, 1);
    assert.equal((await db()`SELECT 1 FROM member_checkins WHERE user_id = ${u.id}`).length, 1);
    assert.equal((await walletOf(u.id)).coins, 2);
    // 資料庫防線：同一天唯一、循環位置須與連續天數一致、append-only
    await assert.rejects(db()`INSERT INTO member_checkins (user_id, day, streak, seq, coins, ledger_id) VALUES (${u.id}, '2026-11-10', 2, 2, 2, 1)`);
    await assert.rejects(db()`INSERT INTO member_checkins (user_id, day, streak, seq, coins, ledger_id) VALUES (${u.id}, '2026-11-11', 8, 8, 2, 1)`);
    await assert.rejects(db()`UPDATE member_checkins SET coins = 100 WHERE user_id = ${u.id}`, /append-only|forbid|not allowed|immutable/i);
  });

  it('API: GET status and POST check-in (201 first, 200 repeat with the same reward)', async () => {
    const u = await makeUser();
    const s0 = (await (await statusRoute(apiRequest('GET', '/api/me/checkin', { token: u.token }), none)).json()) as { streak: number; todayDone: boolean; streakBroken: boolean; slots: unknown[]; nextReward: { seq: number; coins: number } };
    assert.deepEqual([s0.streak, s0.todayDone, s0.streakBroken, s0.slots.length, s0.nextReward.seq, s0.nextReward.coins], [0, false, false, 7, 1, 2]);
    const p1 = await checkinRoute(apiRequest('POST', '/api/me/checkin', { token: u.token }), none);
    assert.equal(p1.status, 201);
    const b1 = (await p1.json()) as { coins: number; seq: number; streak: number; refundable: boolean; status: { todayDone: boolean; streak: number } };
    assert.deepEqual([b1.coins, b1.seq, b1.streak, b1.refundable, b1.status.todayDone, b1.status.streak], [2, 1, 1, false, true, 1]);
    const p2 = await checkinRoute(apiRequest('POST', '/api/me/checkin', { token: u.token }), none);
    assert.equal(p2.status, 200);
    assert.equal(((await p2.json()) as { alreadyCheckedIn: boolean }).alreadyCheckedIn, true);
    assert.equal((await walletOf(u.id)).coins, 2);
    assert.equal((await checkinRoute(apiRequest('POST', '/api/me/checkin'), none)).status, 401);
  });
});
