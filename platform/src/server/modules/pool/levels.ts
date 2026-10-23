import { z } from 'zod';

/**
 * 獎項等級 1–8（所有賞池：官方、自製、混合；等級 1 為最高）。
 * 每個等級：顯示名稱（後台自訂，例如「A賞」「大獎」）、是否小獎（計入「滿 20 件再收一份運費」與逐件運費退還；
 * 預設等級 4–8 為小獎）、1..N 個獎項。最後賞（LAST）是等級之外的獨立獎項。
 * 保底門檻以等級號表示：抽中等級號 ≤ minLevel 視為命中。
 */
export const LEVEL_MIN = 1;
export const LEVEL_MAX = 8;
export const LevelNoSchema = z.number().int().min(LEVEL_MIN, '等級須為 1–8').max(LEVEL_MAX, '等級須為 1–8');
export const LAST_PRIZE_LABEL = '最後賞';

export function defaultIsSmall(levelNo: number): boolean {
  return levelNo >= 4;
}

/** 對外顯示名稱：「等級名稱 獎項名稱」（名稱相同時只顯示一次）；最後賞為「最後賞 名稱」 */
export function displayName(levelName: string | null | undefined, name: string): string {
  if (!levelName || levelName === name) return name;
  return `${levelName} ${name}`;
}

/** 排序權重：最後賞視為最高（0），其次等級 1..8 */
export function levelRank(levelNo: number | null | undefined): number {
  return levelNo ?? 0;
}
