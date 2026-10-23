/**
 * 台灣時間（Asia/Taipei，UTC+8，無日光節約）日期工具。業務日（簽到、生日月、每月 1 日、年度評等）一律以台灣日期計。
 */
const OFFSET_MS = 8 * 3600_000;
const DAY_MS = 86_400_000;

export interface TaipeiDate {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  /** ISO 星期：1 = 週一 … 7 = 週日 */
  isoDow: number;
}

export function taipeiDate(now: Date): TaipeiDate {
  const t = new Date(now.getTime() + OFFSET_MS);
  const dow = t.getUTCDay();
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate(), isoDow: dow === 0 ? 7 : dow };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** YYYY-MM-DD（台灣日期） */
export function taipeiDay(now: Date): string {
  const d = taipeiDate(now);
  return `${d.year}-${pad(d.month)}-${pad(d.day)}`;
}

/** YYYY-MM（台灣月份） */
export function taipeiMonth(now: Date): string {
  const d = taipeiDate(now);
  return `${d.year}-${pad(d.month)}`;
}

/** 以台灣日期（YYYY-MM-DD）加減天數 */
export function addDays(day: string, n: number): string {
  const t = new Date(`${day}T00:00:00Z`).getTime() + n * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

/** 本週週一（台灣日期；每週一 00:00 起算） */
export function taipeiWeekStart(now: Date): string {
  return addDays(taipeiDay(now), -(taipeiDate(now).isoDow - 1));
}

/** 台灣時間 year-month-day 00:00 對應的 UTC 時刻（month 可超出 1–12，自動進位） */
export function taipeiMidnight(year: number, month: number, day = 1): Date {
  return new Date(Date.UTC(year, month - 1, day) - OFFSET_MS);
}
