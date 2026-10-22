import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 綠界 ECPay AIO（全方位金流）CheckMacValue。
 *
 * 規則（依綠界文件「檢查碼機制」與官方 SDK）：
 *  1. 移除 CheckMacValue，參數依鍵名「不分大小寫」A→Z 排序
 *  2. 組成 HashKey=...&k1=v1&k2=v2...&HashIV=...
 *  3. 以 .NET HttpUtility.UrlEncode 規則 URL encode（空白→'+'；不編碼 - _ . ! * ( )；其餘含 ' 與 ~ 皆 %XX）
 *  4. 全部轉小寫
 *  5. SHA256 → 十六進位大寫
 *
 * 已以綠界文件範例（MerchantID 3002607）驗證輸出 6C51C9E6…5B840（見 tests/ecpay.test.ts），
 * 並與官方 Python SDK（github.com/ECPay/ECPayAIO_Python，quote_plus safe='-_.!*()'）演算法一致。
 * 備註：Python SDK 的 quote_plus 不會編碼 '~'，.NET/PHP 會；本實作依 .NET（綠界伺服器端）規則。
 */
export function ecpayUrlEncode(s: string): string {
  return encodeURIComponent(s)
    .replace(/%20/g, '+')
    .replace(/'/g, '%27')
    .replace(/~/g, '%7E');
}

export type EcpayParams = Record<string, string | number>;

function sortKeysCaseInsensitive(keys: string[]): string[] {
  return keys.sort((a, b) => {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

export function computeCheckMacValue(params: EcpayParams, hashKey: string, hashIV: string): string {
  const keys = sortKeysCaseInsensitive(Object.keys(params).filter((k) => k !== 'CheckMacValue'));
  const raw = `HashKey=${hashKey}&${keys.map((k) => `${k}=${params[k]}`).join('&')}&HashIV=${hashIV}`;
  const encoded = ecpayUrlEncode(raw).toLowerCase();
  return createHash('sha256').update(encoded, 'utf8').digest('hex').toUpperCase();
}

export function verifyCheckMacValue(params: Record<string, string>, hashKey: string, hashIV: string): boolean {
  const given = params.CheckMacValue;
  if (!given) return false;
  const expected = computeCheckMacValue(params, hashKey, hashIV);
  const a = Buffer.from(given.toUpperCase());
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** MerchantTradeNo：英數字、最長 20 碼、不可重複。格式 CK + yyMMddHHmmss + 6 碼隨機（共 20 碼）。 */
export function generateMerchantTradeNo(now = new Date()): string {
  const t = taipeiParts(now);
  const stamp = `${t.yyyy.slice(2)}${t.MM}${t.dd}${t.HH}${t.mm}${t.ss}`;
  const rand = randomBytes(6).toString('base64url').replace(/[^A-Za-z0-9]/g, '0').slice(0, 6).toUpperCase();
  return `CK${stamp}${rand}`;
}

function taipeiParts(d: Date) {
  const t = new Date(d.getTime() + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return {
    yyyy: String(t.getUTCFullYear()),
    MM: p(t.getUTCMonth() + 1),
    dd: p(t.getUTCDate()),
    HH: p(t.getUTCHours()),
    mm: p(t.getUTCMinutes()),
    ss: p(t.getUTCSeconds()),
  };
}

/** MerchantTradeDate：yyyy/MM/dd HH:mm:ss（台灣時間）。 */
export function formatTradeDate(d = new Date()): string {
  const t = taipeiParts(d);
  return `${t.yyyy}/${t.MM}/${t.dd} ${t.HH}:${t.mm}:${t.ss}`;
}

export interface AioCheckoutInput {
  merchantId: string;
  hashKey: string;
  hashIV: string;
  merchantTradeNo: string;
  tradeDate: Date;
  totalAmount: number;
  itemName: string;
  tradeDesc: string;
  returnUrl: string;
  clientBackUrl?: string;
  choosePayment: 'ALL' | 'Credit' | 'ATM' | 'CVS' | 'WebATM';
}

export function buildAioCheckoutParams(i: AioCheckoutInput): Record<string, string> {
  const params: Record<string, string> = {
    MerchantID: i.merchantId,
    MerchantTradeNo: i.merchantTradeNo,
    MerchantTradeDate: formatTradeDate(i.tradeDate),
    PaymentType: 'aio',
    TotalAmount: String(i.totalAmount),
    TradeDesc: i.tradeDesc,
    ItemName: i.itemName,
    ReturnURL: i.returnUrl,
    ChoosePayment: i.choosePayment,
    EncryptType: '1',
    NeedExtraPaidInfo: 'N',
  };
  if (i.clientBackUrl) params.ClientBackURL = i.clientBackUrl;
  params.CheckMacValue = computeCheckMacValue(params, i.hashKey, i.hashIV);
  return params;
}
