/**
 * 安全標頭：與 src/server/security/headers.ts 的 securityHeaders() 相同（tests/security.test.ts 比對兩者一致）。
 * API 回應另由 route() 包裝加上（API 使用最嚴格的 CSP）。邊緣層 WAF 規則見 docs/security.md。
 */
const COMMON = [
  { key: 'strict-transport-security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'x-frame-options', value: 'DENY' },
  { key: 'x-content-type-options', value: 'nosniff' },
  { key: 'referrer-policy', value: 'strict-origin-when-cross-origin' },
  { key: 'permissions-policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()' },
  { key: 'cross-origin-opener-policy', value: 'same-origin' },
];

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

export const securityHeaderRoutes = [
  { source: '/api/:path*', headers: [...COMMON, { key: 'content-security-policy', value: API_CSP }] },
  { source: '/((?!api/).*)', headers: [...COMMON, { key: 'content-security-policy', value: PAGE_CSP }] },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Docker 映像：只帶 .next/standalone（server.js ＋ 實際用到的 node_modules）
  output: 'standalone',
  // postgres.js 在伺服器端執行，不打包進前端
  serverExternalPackages: ['postgres'],
  async headers() {
    return securityHeaderRoutes;
  },
};
export default nextConfig;
