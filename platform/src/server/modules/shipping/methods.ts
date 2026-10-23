import { z } from 'zod';
import { resolveBulky, type Tag } from '../catalog/tags';

/**
 * 寄送方式（業主規則 2026-10 第七批）：
 *  - 每個獎項於上架時預設寄送方式（後台建立/編輯賞池時設定；賞池一有銷售即鎖定）。會員不可選擇。
 *      home 宅配到府 / c711 7-11 交貨便 / fami 全家店到店
 *    未設定時：大件（GK 標籤或等級 1，或標記大件）→ home，其餘 → c711。
 *  - 運費到付（貨到付運費）：抽賞與申請出貨時都不收運費，出貨單標記 freight_collect。
 *  - 一次出貨申請若含不同寄送方式的物品，依寄送方式拆成多張出貨單，各自使用該方式的地址/門市。
 *
 * 出貨單沿用物流方式代碼（HOME_DELIVERY / CVS_711_C2C / CVS_FAMI_C2C；對應物流商類別與追蹤網址）。
 */
export const SHIP_METHODS = ['home', 'c711', 'fami'] as const;
export type ShipMethod = (typeof SHIP_METHODS)[number];
export const ShipMethodSchema = z.enum(SHIP_METHODS, { errorMap: () => ({ message: '寄送方式須為 home（宅配到府）、c711（7-11 交貨便）或 fami（全家店到店）' }) });

export const SHIP_METHOD_LABEL: Record<ShipMethod, string> = {
  home: '宅配到府',
  c711: '7-11 交貨便',
  fami: '全家店到店',
};

export const SHIPPING_METHODS = ['HOME_DELIVERY', 'CVS_711_C2C', 'CVS_FAMI_C2C'] as const;
export type ShippingMethod = (typeof SHIPPING_METHODS)[number];

export const SHIP_TO_SHIPPING: Record<ShipMethod, ShippingMethod> = {
  home: 'HOME_DELIVERY',
  c711: 'CVS_711_C2C',
  fami: 'CVS_FAMI_C2C',
};
export const SHIPPING_TO_SHIP: Record<ShippingMethod, ShipMethod> = {
  HOME_DELIVERY: 'home',
  CVS_711_C2C: 'c711',
  CVS_FAMI_C2C: 'fami',
};

/** 未指定寄送方式時的預設：大件 → 宅配，其餘 → 7-11 交貨便 */
export function defaultShipMethod(tag: Tag | null | undefined, bulky: boolean | undefined, levelNo?: number | null): ShipMethod {
  return resolveBulky(tag, bulky, levelNo) ? 'home' : 'c711';
}

export function resolveShipMethod(shipMethod: ShipMethod | undefined | null, tag: Tag | null | undefined, bulky: boolean | undefined, levelNo?: number | null): ShipMethod {
  return shipMethod ?? defaultShipMethod(tag, bulky, levelNo);
}

export type MethodCategory = 'HOME' | 'CVS';
export function methodCategory(m: ShippingMethod | ShipMethod | string): MethodCategory {
  return m === 'HOME_DELIVERY' || m === 'home' ? 'HOME' : 'CVS';
}

/** 運費到付說明（前台照原文顯示） */
export const FREIGHT_COLLECT_NOTE = '運費到付：抽賞與申請出貨時不收運費，由收件人於收貨/取貨時支付';

export const DEFAULT_SHIPPING_NOTE: Record<'OFFICIAL' | 'CUSTOM' | 'MIXED', string> = {
  OFFICIAL: '官方商品依官方出貨時程',
  CUSTOM: '平台商品依平台公告時程',
  MIXED: '官方商品依官方出貨時程；平台商品依平台公告時程',
};
