/**
 * 安全標頭。API（JSON）回應使用最嚴格的 CSP；頁面使用可運作的 CSP（同時寫在 next.config.mjs 的 headers()，
 * tests/security.test.ts 會比對兩者一致）。
 *
 * 頁面 CSP 說明：Next.js App Router 的內嵌 script 目前需要 'unsafe-inline'；上線前建議改為 middleware 產生 nonce
 * （script-src 'self' 'nonce-…' 'strict-dynamic'）。form-action 允許綠界付款頁（儲值表單會 POST 過去）。
 */
const COMMON: Record<string, string> = {
  'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'cross-origin-opener-policy': 'same-origin',
};

export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self' https://payment.ecpay.com.tw https://payment-stage.ecpay.com.tw",
  'upgrade-insecure-requests',
].join('; ');

export function securityHeaders(kind: 'api' | 'page' = 'api'): Record<string, string> {
  return { ...COMMON, 'content-security-policy': kind === 'api' ? API_CSP : PAGE_CSP };
}

/** next.config.mjs headers() 格式 */
export function nextHeaderList(kind: 'api' | 'page'): { key: string; value: string }[] {
  return Object.entries(securityHeaders(kind)).map(([key, value]) => ({ key, value }));
}
