import { z } from 'zod';

/**
 * 獎項等級 1–12（所有賞池：官方、自製、混合；等級 1 為最高）。原本上限 8，官方賞常見 A–I（九級）以上，
 * 於 2026-10 第七批放寬為 12（資料庫 CHECK 同步）。
 * 每個等級：顯示名稱（後台自訂，例如「A賞」「大獎」）、是否小獎（等級屬性，預設等級 4 以上為小獎；
 * 運費改為到付後不再影響任何收費）、1..N 個獎項。最後賞（LAST）是等級之外的獨立獎項。
 * 保底門檻以等級號表示：抽中等級號 ≤ minLevel 視為命中。
 */
export const LEVEL_MIN = 1;
export const LEVEL_MAX = 12;
const LEVEL_RANGE_MSG = `等級須為 ${LEVEL_MIN}–${LEVEL_MAX}`;
export const LevelNoSchema = z.number().int().min(LEVEL_MIN, LEVEL_RANGE_MSG).max(LEVEL_MAX, LEVEL_RANGE_MSG);
export const LAST_PRIZE_LABEL = '最後賞';

export function defaultIsSmall(levelNo: number): boolean {
  return levelNo >= 4;
}

/** 對外顯示名稱：「等級名稱 獎項名稱」（名稱相同時只顯示一次）；最後賞為「最後賞 名稱」 */
export function displayName(levelName: string | null | undefined, name: string): string {
  if (!levelName || levelName === name) return name;
  return `${levelName} ${name}`;
}

/** 排序權重：最後賞視為最高（0），其次等級 1..12 */
export function levelRank(levelNo: number | null | undefined): number {
  return levelNo ?? 0;
}
