import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/server/db';
import { addDays, taipeiDay, taipeiWeekStart } from '../src/server/lib/taipei';
import { CHECKIN_REWARDS, checkIn, getCheckinStatus } from '../src/server/modules/checkin/checkin';
import { getCoinBreakdown, reconcileWallets } from '../src/server/modules/wallet/wallet';
import { GET as statusRoute, POST as checkinRoute } from '../src/app/api/me/checkin/route';
import { apiRequest, ledgerOf, makeUser, setupTestDb, walletOf } from './helpers';

const none = undefined as never;
/** 台灣時間 YYYY-MM-DD HH:mm → Date */
const tw = (day: string, hm = '12:00') => new Date(`${day}T${hm}:00+08:00`);

describe('Asia/Taipei week (pure)', () => {
  it('weeks start Monday 00:00 Taipei time', () => {
    assert.equal(taipeiDay(new Date('2026-10-25T15:59:00Z')), '2026-10-25'); // 台灣週日 23:59
    assert.equal(taipeiDay(new Date('2026-10-25T16:00:00Z')), '2026-10-26'); // 台灣週一 00:00
    assert.equal(taipeiWeekStart(new Date('2026-10-25T15:59:00Z')), '2026-10-19');
    assert.equal(taipeiWeekStart(new Date('2026-10-25T16:00:00Z')), '2026-10-26');
    assert.equal(taipeiWeekStart(tw('2026-10-19', '00:00')), '2026-10-19');
    assert.equal(taipeiWeekStart(tw('2026-11-01')), '2026-10-26'); // 週日
    assert.equal(taipeiWeekStart(tw('2027-01-01')), '2026-12-28'); // 跨年
    assert.equal(addDays('2026-12-28', 6), '2027-01-03');
    assert.deepEqual([...CHECKIN_REWARDS], [2, 2, 2, 2, 2, 2, 10]);
  });
});

describe('daily check-in', () => {
  let env: Awaited<ReturnType<typeof setupTestDb>>;
  before(async () => {
    env = await setupTestDb();
  });
  after(async () => {
    await env.teardown();
  });

  it('Nth check-in of the week: 1–6 → 2 CC幣, 7th → 10; once per day; resets every Monday 00:00 Taipei', async () => {
    const u = await makeUser();
    const monday = '2026-10-19';
    const got: number[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await checkIn(u.id, tw(addDays(monday, i), '09:30'));
      assert.deepEqual([r.alreadyCheckedIn, r.seq, r.day], [false, i + 1, addDays(monday, i)]);
      got.push(r.coins);
      const again = await checkIn(u.id, tw(addDays(monday, i), '23:59'));
      assert.deepEqual([again.alreadyCheckedIn, again.seq, again.coins], [true, i + 1, r.coins], 'idempotent per day');
    }
    assert.deepEqual(got, [2, 2, 2, 2, 2, 2, 10]);
    const sun = await getCheckinStatus(db(), u.id, tw('2026-10-25', '23:00'));
    assert.deepEqual([sun.weekStart, sun.weekEnd, sun.count, sun.todayDone, sun.nextReward], ['2026-10-19', '2026-10-25', 7, true, null]);
    assert.ok(sun.slots.every((s) => s.done));
    // 週日 23:59 → 週一 00:00（台灣）：新的一週，計數歸零
    const mon = await getCheckinStatus(db(), u.id, new Date('2026-10-25T16:00:00Z'));
    assert.deepEqual([mon.weekStart, mon.count, mon.todayDone, mon.nextReward], ['2026-10-26', 0, false, { seq: 1, coins: 2, availableToday: true }]);
    const next = await checkIn(u.id, new Date('2026-10-25T16:00:30Z'));
    assert.deepEqual([next.seq, next.coins, next.day], [1, 2, '2026-10-26']);
    const led = (await ledgerOf(u.id)).filter((l) => l.entryType === 'CHECKIN');
    assert.deepEqual(led.map((l) => l.amount), [2, 2, 2, 2, 2, 2, 10, 2]);
    assert.ok(led.every((l) => l.refundable === false), 'check-in coins are non-refundable');
    assert.deepEqual(await walletOf(u.id), { coins: 24, nonRefundableCoins: 24 });
    assert.equal((await getCoinBreakdown(db(), u.id)).nonRefundableCredited.CHECKIN, 24);
    assert.ok((await reconcileWallets(db(), u.id)).every((r) => r.ok));
  });

  it('skipped days do not break the count (the Nth check-in this week); a new week starts over even if unfinished', async () => {
    const u = await makeUser();
    const r1 = await checkIn(u.id, tw('2026-11-02')); // 週一
    const r2 = await checkIn(u.id, tw('2026-11-04')); // 週三
    const r3 = await checkIn(u.id, tw('2026-11-08', '23:59')); // 週日
    assert.deepEqual([r1.seq, r2.seq, r3.seq], [1, 2, 3]);
    const st = await getCheckinStatus(db(), u.id, tw('2026-11-08', '23:59'));
    assert.deepEqual(st.slots.map((s) => [s.seq, s.coins, s.done, s.day]), [
      [1, 2, true, '2026-11-02'], [2, 2, true, '2026-11-04'], [3, 2, true, '2026-11-08'],
      [4, 2, false, null], [5, 2, false, null], [6, 2, false, null], [7, 10, false, null],
    ]);
    assert.deepEqual(st.nextReward, { seq: 4, coins: 2, availableToday: false });
    const r4 = await checkIn(u.id, tw('2026-11-09', '00:00')); // 下週一
    assert.deepEqual([r4.seq, r4.coins], [1, 2]);
  });

  it('concurrent POSTs on the same day grant once', async () => {
    const u = await makeUser();
    const now = tw('2026-11-10', '08:00');
    const rs = await Promise.all(Array.from({ length: 12 }, () => checkIn(u.id, now)));
    assert.equal(rs.filter((r) => !r.alreadyCheckedIn).length, 1);
    assert.ok(rs.every((r) => r.seq === 1 && r.coins === 2));
    assert.equal((await ledgerOf(u.id)).filter((l) => l.entryType === 'CHECKIN').length, 1);
    assert.equal((await db()`SELECT 1 FROM member_checkins WHERE user_id = ${u.id}`).length, 1);
    assert.equal((await walletOf(u.id)).coins, 2);
    // 資料庫防線：同一天的帳本列與簽到列都是唯一的
    await assert.rejects(db()`INSERT INTO member_checkins (user_id, day, week_start, seq, coins, ledger_id) VALUES (${u.id}, '2026-11-10', '2026-11-09', 2, 2, 1)`);
    await assert.rejects(db()`UPDATE member_checkins SET coins = 100 WHERE user_id = ${u.id}`, /append-only|forbid|not allowed|immutable/i);
  });

  it('API: GET status and POST check-in (201 first, 200 repeat with the same reward)', async () => {
    const u = await makeUser();
    const s0 = (await (await statusRoute(apiRequest('GET', '/api/me/checkin', { token: u.token }), none)).json()) as { count: number; todayDone: boolean; slots: unknown[]; nextReward: { seq: number; coins: number } };
    assert.deepEqual([s0.count, s0.todayDone, s0.slots.length, s0.nextReward.coins], [0, false, 7, 2]);
    const p1 = await checkinRoute(apiRequest('POST', '/api/me/checkin', { token: u.token }), none);
    assert.equal(p1.status, 201);
    const b1 = (await p1.json()) as { coins: number; seq: number; refundable: boolean; status: { todayDone: boolean; count: number } };
    assert.deepEqual([b1.coins, b1.seq, b1.refundable, b1.status.todayDone, b1.status.count], [2, 1, false, true, 1]);
    const p2 = await checkinRoute(apiRequest('POST', '/api/me/checkin', { token: u.token }), none);
    assert.equal(p2.status, 200);
    assert.equal(((await p2.json()) as { alreadyCheckedIn: boolean }).alreadyCheckedIn, true);
    assert.equal((await walletOf(u.id)).coins, 2);
    assert.equal((await checkinRoute(apiRequest('POST', '/api/me/checkin'), none)).status, 401);
  });
});
