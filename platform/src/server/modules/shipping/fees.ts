import { z } from 'zod';

/**
 * 物流方式與運費範圍（業主規則）。目前只開放：宅配、7-ELEVEN 交貨便、全家 店到店（萊爾富/OK 停用）。
 * 每套運費由後台設定：宅配 150–300 代幣、超商 C2C 60–150 代幣（資料庫 CHECK 同步強制）。
 */
export const SHIPPING_METHODS = ['HOME_DELIVERY', 'CVS_711_C2C', 'CVS_FAMI_C2C'] as const;
export type ShippingMethod = (typeof SHIPPING_METHODS)[number];
export const ShippingMethodSchema = z.enum(SHIPPING_METHODS);

export const HOME_FEE_RANGE: [number, number] = [150, 300];
export const CVS_FEE_RANGE: [number, number] = [60, 150];

export const HomeFeeSchema = z.number().int().min(HOME_FEE_RANGE[0], `宅配運費須介於 ${HOME_FEE_RANGE[0]}–${HOME_FEE_RANGE[1]} 代幣`).max(HOME_FEE_RANGE[1], `宅配運費須介於 ${HOME_FEE_RANGE[0]}–${HOME_FEE_RANGE[1]} 代幣`);
export const CvsFeeSchema = z.number().int().min(CVS_FEE_RANGE[0], `超商運費須介於 ${CVS_FEE_RANGE[0]}–${CVS_FEE_RANGE[1]} 代幣`).max(CVS_FEE_RANGE[1], `超商運費須介於 ${CVS_FEE_RANGE[0]}–${CVS_FEE_RANGE[1]} 代幣`);

export type MethodCategory = 'HOME' | 'CVS';
export function methodCategory(m: ShippingMethod | string): MethodCategory {
  return m === 'HOME_DELIVERY' ? 'HOME' : 'CVS';
}

/** 某套對某物流方式的單份運費 */
export function setFeeFor(set: { shipFeeHome: number; shipFeeCvs: number }, m: ShippingMethod | string): number {
  return methodCategory(m) === 'HOME' ? set.shipFeeHome : set.shipFeeCvs;
}

export const DEFAULT_SHIPPING_NOTE: Record<'OFFICIAL' | 'CUSTOM' | 'MIXED', string> = {
  OFFICIAL: '官方商品依官方出貨時程',
  CUSTOM: '平台商品依平台公告時程',
  MIXED: '官方商品依官方出貨時程；平台商品依平台公告時程',
};
