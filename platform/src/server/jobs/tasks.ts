import type { ScheduleSpec } from './schedule';
import { dispatchOutbox } from '../modules/notifications/outbox';
import { runStorageSweep } from '../modules/warehouse/storage';
import { runDrawArchive } from '../modules/draw/history';
import { purgeDeleted } from '../modules/pool/manage';
import { runVipAnnualRerating, runVipBirthdayGifts, runVipMonthlyCoupons } from '../modules/vip/vip';

export interface JobTask {
  name: string;
  spec: ScheduleSpec;
  run: (now: Date) => Promise<unknown>;
}

/**
 * 背景工作清單（scripts/worker.ts）。時刻皆為台灣時間；與 /api/admin/jobs/* 手動觸發的是同一批函式（皆冪等）。
 * 通知外送間隔可由 WORKER_NOTIFY_INTERVAL_SEC 調整。
 * 同一個 tick 內依清單順序執行：1/1 先年度重新評等，再發每月優惠券（依新等級）與生日禮。
 */
export function jobTasks(): JobTask[] {
  const notifyEvery = Number(process.env.WORKER_NOTIFY_INTERVAL_SEC ?? 60) || 60;
  return [
    { name: 'notifications-dispatch', spec: { kind: 'interval', everySec: notifyEvery }, run: (now) => dispatchOutbox({ now, limit: 500 }) },
    { name: 'storage-sweep', spec: { kind: 'interval', everySec: 3600 }, run: (now) => runStorageSweep(now) },
    {
      name: 'draw-archive',
      spec: { kind: 'calendar', hour: 3, minute: 30 },
      run: async (now) => {
        let archived = 0;
        for (;;) {
          const r = await runDrawArchive(now);
          archived += r.archived;
          if (r.archived === 0) return { archived };
        }
      },
    },
    { name: 'purge-deleted', spec: { kind: 'calendar', hour: 4, minute: 0 }, run: (now) => purgeDeleted(now) },
    { name: 'vip-annual-rerating', spec: { kind: 'calendar', hour: 0, minute: 1, dayOfMonth: 1, month: 1 }, run: (now) => runVipAnnualRerating(now) },
    { name: 'vip-monthly-coupons', spec: { kind: 'calendar', hour: 0, minute: 5, dayOfMonth: 1 }, run: (now) => runVipMonthlyCoupons(now) },
    { name: 'vip-birthday-gifts', spec: { kind: 'calendar', hour: 0, minute: 10 }, run: (now) => runVipBirthdayGifts(now) },
  ];
}
