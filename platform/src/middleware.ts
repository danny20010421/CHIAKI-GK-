import { preflightResponse } from './server/security/hosts';

/**
 * Next.js middleware：只處理 /api/* 的 CORS 預檢（OPTIONS）。其他請求不經過這裡處理（回傳 undefined ＝ 繼續）。
 * 一般回應的 CORS 標頭與後台網域分離由 route()（src/server/http.ts）處理。
 * 只使用 Web 標準 Request/Response，不依賴 next/server。
 */
export function middleware(req: Request): Response | undefined {
  if (req.method === 'OPTIONS') return preflightResponse(req);
  return undefined;
}

// Node.js runtime（Next 15.5+）：與 route handler 讀取相同的 process.env 設定
export const config = { matcher: '/api/:path*', runtime: 'nodejs' };
