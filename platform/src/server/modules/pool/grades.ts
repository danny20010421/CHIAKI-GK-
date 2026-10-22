import { z } from 'zod';

/**
 * 獎項等級（業主規則）：所有獎項（含自製賞池）都必須有等級，等級決定
 *   - 保底資格（min_grade 以上視為命中）
 *   - 開獎特效（前台依 grade 決定）
 *   - 運費預收計數（只有 SMALL 計入「一份運費 20 件」）
 * 自製（CUSTOM）賞池沒有 A–H 賞級，獎項以名稱識別；官方/混合賞池保留賞級（A、B…、LAST）。
 */
export const GRADES = ['GRAND', 'MID', 'SMALL'] as const;
export type Grade = (typeof GRADES)[number];
export const GradeSchema = z.enum(GRADES);

export const GRADE_LABEL: Record<Grade, string> = { GRAND: '大獎', MID: '中獎', SMALL: '小獎' };

const ORDER: Record<Grade, number> = { GRAND: 3, MID: 2, SMALL: 1 };

/** a 是否達到（≥）門檻等級 min */
export function gradeAtLeast(a: Grade, min: Grade): boolean {
  return ORDER[a] >= ORDER[min];
}

/** 官方/混合賞池的預設對應：LAST/A → GRAND、B/C → MID、其他 → SMALL（後台可覆寫）。 */
export function defaultGradeForRank(rank: string): Grade {
  if (rank === 'LAST' || rank === 'A') return 'GRAND';
  if (rank === 'B' || rank === 'C') return 'MID';
  return 'SMALL';
}

export function rankLabel(rank: string): string {
  return rank === 'LAST' ? 'LAST賞' : `${rank}賞`;
}

/**
 * 對外顯示名稱：自製賞池＝獎項名稱；官方/混合＝「賞級標籤 + 名稱」（無賞級者僅名稱）。
 */
export function displayName(source: string | null | undefined, rank: string | null | undefined, name: string): string {
  if (source === 'CUSTOM' || !rank) return name;
  return `${rankLabel(rank)} ${name}`;
}
