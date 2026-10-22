/**
 * 多商家（P4）預留模組。目前所有資料皆歸屬 DEFAULT_MERCHANT_ID（'chiaki'）。
 * 未來：商家入駐審核、商家後台權限（MERCHANT 角色）、抽成/分潤/代收付結算。
 */
export const DEFAULT_MERCHANT_ID = 'chiaki';

export function currentMerchantId(): string {
  return DEFAULT_MERCHANT_ID;
}
