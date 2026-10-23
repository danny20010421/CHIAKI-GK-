import { z } from 'zod';

/**
 * 標籤（業主規則，2026-10 第四批）：獎項與商城商品各可有一個標籤；賞池的標籤＝其獎項標籤的集合，
 * 官方（OFFICIAL）賞池另外一律帶「一番賞」。另有「大件・限宅配」旗標：預設 GK 標籤或等級 1 的獎項為大件。
 */
export const TAGS = ['GK', 'PVC', '一番賞', '景品盲盒', '卡牌', '娃娃', '其他'] as const;
export type Tag = (typeof TAGS)[number];
export const TagSchema = z.enum(TAGS, { errorMap: () => ({ message: `標籤須為：${TAGS.join('、')}` }) });

export const BULKY_LABEL = '大件・限宅配';

/** 未明確指定 bulky 時的預設值：GK 標籤或等級 1 的獎項 */
export function defaultBulky(tag: Tag | null | undefined, levelNo?: number | null): boolean {
  return tag === 'GK' || levelNo === 1;
}

export function resolveBulky(tag: Tag | null | undefined, bulky: boolean | undefined, levelNo?: number | null): boolean {
  return bulky ?? defaultBulky(tag, levelNo);
}

/** 依固定順序輸出不重複的標籤；官方賞池加上「一番賞」 */
export function distinctTags(list: (string | null)[], source?: string | null): Tag[] {
  const set = new Set(list.filter((c): c is Tag => c !== null));
  if (source === 'OFFICIAL') set.add('一番賞');
  return TAGS.filter((c) => set.has(c));
}
