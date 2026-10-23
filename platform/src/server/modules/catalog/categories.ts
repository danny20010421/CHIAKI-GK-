import { z } from 'zod';

/**
 * 商品分類（獎項與商城商品共用；賞池的分類＝其獎項分類的集合）與「大件・限宅配」旗標。
 * 大件預設：GK 為大件；其他分類（含 3C）預設否，大型 3C 等由後台逐項勾選 bulky=true。
 */
export const PRODUCT_CATEGORIES = ['GK', 'PVC', '景品', '精品', '模型', '盒玩扭蛋', '絨毛', '周邊', '卡牌', '戰鬥陀螺', '3C'] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];
export const ProductCategorySchema = z.enum(PRODUCT_CATEGORIES);

export const BULKY_LABEL = '大件・限宅配';

/** 未明確指定 bulky 時的預設值 */
export function defaultBulky(category: ProductCategory | null | undefined): boolean {
  return category === 'GK';
}

export function resolveBulky(category: ProductCategory | null | undefined, bulky: boolean | undefined): boolean {
  return bulky ?? defaultBulky(category);
}

/** 依固定順序輸出不重複的分類 */
export function distinctCategories(list: (string | null)[]): ProductCategory[] {
  const set = new Set(list.filter((c): c is ProductCategory => c !== null));
  return PRODUCT_CATEGORIES.filter((c) => set.has(c));
}
