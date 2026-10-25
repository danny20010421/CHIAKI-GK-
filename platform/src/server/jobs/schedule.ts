import { taipeiDate, taipeiMidnight } from '../lib/taipei';

/**
 * 背景工作排程（純邏輯，供 scripts/worker.ts 使用；有單元測試）。
 *  - interval：每 N 秒（例如通知外送每 60 秒）。
 *  - calendar：台灣時間固定時刻；可限定每月幾日（dayOfMonth）與月份（month），例如每月 1 日 00:05、1/1 00:05。
 * 所有工作本身皆為冪等（重跑不會重複發放），排程只決定「何時該跑」：
 *  - calendar 工作在 worker 啟動時，只補跑「最近一次排定時刻在 catchUpMs 之內」的那次（預設 6 小時），
 *    避免重新部署時把很久以前的排程補跑（例如月中重啟不會重發本月優惠券給月中才升級的會員）。
 */
export type ScheduleSpec =
  | { kind: 'interval'; everySec: number }
  | { kind: 'calendar'; hour: number; minute: number; dayOfMonth?: number; month?: number };

export interface TaskState {
  lastRunAt?: Date | null;
}

export const DEFAULT_CATCH_UP_MS = 6 * 3600_000;

function slotAt(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(taipeiMidnight(year, month, day).getTime() + hour * 3600_000 + minute * 60_000);
}

/** calendar：不晚於 now 的最近一次排定時刻（UTC 時刻）。interval → null */
export function latestSlot(spec: ScheduleSpec, now: Date): Date | null {
  if (spec.kind === 'interval') return null;
  const t = taipeiDate(now);
  const { hour, minute, dayOfMonth, month } = spec;
  if (month !== undefined) {
    const day = dayOfMonth ?? 1;
    const s = slotAt(t.year, month, day, hour, minute);
    return s.getTime() <= now.getTime() ? s : slotAt(t.year - 1, month, day, hour, minute);
  }
  if (dayOfMonth !== undefined) {
    const s = slotAt(t.year, t.month, dayOfMonth, hour, minute);
    return s.getTime() <= now.getTime() ? s : slotAt(t.year, t.month - 1, dayOfMonth, hour, minute);
  }
  const s = slotAt(t.year, t.month, t.day, hour, minute);
  return s.getTime() <= now.getTime() ? s : new Date(s.getTime() - 86_400_000);
}

/** 是否該執行。startedAt：worker 啟動時刻（沒有上次執行紀錄時，用來決定補跑範圍） */
export function isDue(spec: ScheduleSpec, state: TaskState, now: Date, startedAt: Date, catchUpMs = DEFAULT_CATCH_UP_MS): boolean {
  if (spec.kind === 'interval') {
    return !state.lastRunAt || now.getTime() - state.lastRunAt.getTime() >= spec.everySec * 1000;
  }
  const slot = latestSlot(spec, now)!;
  const reference = state.lastRunAt ?? new Date(startedAt.getTime() - catchUpMs);
  return slot.getTime() > reference.getTime();
}

export function validateSpec(spec: ScheduleSpec): void {
  if (spec.kind === 'interval') {
    if (!(spec.everySec >= 1)) throw new Error('interval everySec must be >= 1');
    return;
  }
  if (!Number.isInteger(spec.hour) || spec.hour < 0 || spec.hour > 23) throw new Error('hour must be 0-23');
  if (!Number.isInteger(spec.minute) || spec.minute < 0 || spec.minute > 59) throw new Error('minute must be 0-59');
  if (spec.dayOfMonth !== undefined && (!Number.isInteger(spec.dayOfMonth) || spec.dayOfMonth < 1 || spec.dayOfMonth > 28)) throw new Error('dayOfMonth must be 1-28');
  if (spec.month !== undefined && (!Number.isInteger(spec.month) || spec.month < 1 || spec.month > 12)) throw new Error('month must be 1-12');
}

export function describeSpec(spec: ScheduleSpec): string {
  if (spec.kind === 'interval') return `every ${spec.everySec}s`;
  const hm = `${String(spec.hour).padStart(2, '0')}:${String(spec.minute).padStart(2, '0')} Asia/Taipei`;
  if (spec.month !== undefined) return `yearly ${spec.month}/${spec.dayOfMonth ?? 1} ${hm}`;
  if (spec.dayOfMonth !== undefined) return `monthly day ${spec.dayOfMonth} ${hm}`;
  return `daily ${hm}`;
}

/** 本次 tick 該執行的工作（依清單順序）；retryAt 未到的工作略過 */
export function dueTasks<T extends { name: string; spec: ScheduleSpec }>(
  tasks: T[],
  states: Map<string, TaskState & { retryAt?: Date | null }>,
  now: Date,
  startedAt: Date,
  catchUpMs = DEFAULT_CATCH_UP_MS,
): T[] {
  return tasks.filter((t) => {
    const st = states.get(t.name) ?? {};
    if (st.retryAt && now.getTime() < st.retryAt.getTime()) return false;
    return isDue(t.spec, st, now, startedAt, catchUpMs);
  });
}
