/** 背景工作排程邏輯（純函式；不連資料庫）：interval / 台灣時間 calendar、補跑範圍、重試、工作清單 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CATCH_UP_MS, describeSpec, dueTasks, isDue, latestSlot, validateSpec, type ScheduleSpec } from '../src/server/jobs/schedule';
import { jobTasks } from '../src/server/jobs/tasks';

const at = (iso: string) => new Date(iso);
const daily: ScheduleSpec = { kind: 'calendar', hour: 0, minute: 10 };
const monthly: ScheduleSpec = { kind: 'calendar', hour: 0, minute: 5, dayOfMonth: 1 };
const yearly: ScheduleSpec = { kind: 'calendar', hour: 0, minute: 1, dayOfMonth: 1, month: 1 };

describe('worker schedule — latestSlot (Asia/Taipei)', () => {
  it('daily: today 00:10 Taipei once passed, otherwise yesterday', () => {
    // 台灣 2026-11-01 00:30 = UTC 2026-10-31 16:30
    assert.equal(latestSlot(daily, at('2026-10-31T16:30:00Z'))!.toISOString(), '2026-10-31T16:10:00.000Z');
    // 台灣 2026-11-01 00:05（尚未到 00:10）→ 前一天
    assert.equal(latestSlot(daily, at('2026-10-31T16:05:00Z'))!.toISOString(), '2026-10-30T16:10:00.000Z');
    // 剛好在排定時刻
    assert.equal(latestSlot(daily, at('2026-10-31T16:10:00Z'))!.toISOString(), '2026-10-31T16:10:00.000Z');
  });

  it('monthly: the 1st 00:05 Taipei of this month, or of last month (handles January → December)', () => {
    assert.equal(latestSlot(monthly, at('2026-11-15T04:00:00Z'))!.toISOString(), '2026-10-31T16:05:00.000Z');
    // 台灣 2027-01-01 00:03 → 上一個是 2026-12-01 00:05
    assert.equal(latestSlot(monthly, at('2026-12-31T16:03:00Z'))!.toISOString(), '2026-11-30T16:05:00.000Z');
  });

  it('yearly: Jan 1 00:01 Taipei of this year or last year; interval has no slot', () => {
    assert.equal(latestSlot(yearly, at('2027-06-01T00:00:00Z'))!.toISOString(), '2026-12-31T16:01:00.000Z');
    assert.equal(latestSlot(yearly, at('2026-12-31T15:59:00Z'))!.toISOString(), '2025-12-31T16:01:00.000Z');
    assert.equal(latestSlot({ kind: 'interval', everySec: 60 }, new Date()), null);
  });
});

describe('worker schedule — isDue', () => {
  it('interval: due at start, then every N seconds', () => {
    const spec: ScheduleSpec = { kind: 'interval', everySec: 60 };
    const t0 = at('2026-11-01T00:00:00Z');
    assert.equal(isDue(spec, {}, t0, t0), true);
    assert.equal(isDue(spec, { lastRunAt: t0 }, at('2026-11-01T00:00:59Z'), t0), false);
    assert.equal(isDue(spec, { lastRunAt: t0 }, at('2026-11-01T00:01:00Z'), t0), true);
  });

  it('calendar: runs once per slot; next slot makes it due again', () => {
    const start = at('2026-10-31T12:00:00Z'); // 台灣 10/31 20:00
    const run = at('2026-10-31T16:10:20Z'); // 台灣 11/1 00:10:20
    assert.equal(isDue(daily, {}, at('2026-10-31T16:09:00Z'), start), false, 'before the slot; the previous slot is outside the catch-up window');
    assert.equal(isDue(daily, {}, run, start), true);
    assert.equal(isDue(daily, { lastRunAt: run }, at('2026-10-31T20:00:00Z'), start), false, 'same slot already ran');
    assert.equal(isDue(daily, { lastRunAt: run }, at('2026-11-01T16:10:00Z'), start), true, 'next day');
  });

  it('calendar catch-up on worker start: only a slot within the catch-up window (default 6h) is run', () => {
    // 台灣 11/1 02:00 啟動（每月 1 日 00:05 的排程在 2 小時前）→ 補跑
    const startSoon = at('2026-10-31T18:00:00Z');
    assert.equal(isDue(monthly, {}, startSoon, startSoon), true);
    // 台灣 11/15 啟動 → 不補跑本月的優惠券（避免月中重啟補發）
    const startLate = at('2026-11-15T04:00:00Z');
    assert.equal(isDue(monthly, {}, startLate, startLate), false);
    // 之後到下個月 1 日照常執行
    assert.equal(isDue(monthly, {}, at('2026-11-30T16:05:00Z'), startLate), true);
    // 補跑範圍可調
    assert.equal(isDue(monthly, {}, startLate, startLate, 15 * 86_400_000), true);
    assert.equal(DEFAULT_CATCH_UP_MS, 6 * 3600_000);
  });

  it('dueTasks keeps list order and honours retryAt after a failure', () => {
    const tasks = [
      { name: 'a', spec: { kind: 'interval', everySec: 60 } as ScheduleSpec },
      { name: 'b', spec: { kind: 'interval', everySec: 60 } as ScheduleSpec },
    ];
    const now = at('2026-11-01T00:00:00Z');
    const states = new Map([['a', { retryAt: at('2026-11-01T00:05:00Z') }]]);
    assert.deepEqual(dueTasks(tasks, states, now, now).map((t) => t.name), ['b']);
    assert.deepEqual(dueTasks(tasks, states, at('2026-11-01T00:05:00Z'), now).map((t) => t.name), ['a', 'b']);
  });
});

describe('worker schedule — job list', () => {
  it('covers outbox dispatch and the VIP monthly / birthday / re-rating jobs; specs valid; re-rating runs before coupons', () => {
    const tasks = jobTasks();
    const names = tasks.map((t) => t.name);
    for (const n of ['notifications-dispatch', 'vip-monthly-coupons', 'vip-birthday-gifts', 'vip-annual-rerating', 'storage-sweep', 'draw-archive', 'purge-deleted']) assert.ok(names.includes(n), n);
    for (const t of tasks) validateSpec(t.spec);
    assert.ok(names.indexOf('vip-annual-rerating') < names.indexOf('vip-monthly-coupons'));
    assert.equal(describeSpec(tasks.find((t) => t.name === 'vip-monthly-coupons')!.spec), 'monthly day 1 00:05 Asia/Taipei');
    assert.equal(describeSpec(tasks.find((t) => t.name === 'notifications-dispatch')!.spec), 'every 60s');
  });

  it('validateSpec rejects bad values', () => {
    assert.throws(() => validateSpec({ kind: 'interval', everySec: 0 }));
    assert.throws(() => validateSpec({ kind: 'calendar', hour: 24, minute: 0 }));
    assert.throws(() => validateSpec({ kind: 'calendar', hour: 0, minute: 0, dayOfMonth: 31 }));
    assert.throws(() => validateSpec({ kind: 'calendar', hour: 0, minute: 0, month: 13 }));
  });
});
