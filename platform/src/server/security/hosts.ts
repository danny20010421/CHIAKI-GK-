import { config, type AppConfig } from '../config';

/**
 * 後台網域分離與 CORS。
 *  - ADMIN_HOST（例如 admin.chiaki.tw）設定後，後台 API（/api/admin/*、/api/auth/admin/*）只在該主機名稱提供，
 *    其他主機一律回 404（不透露後台存在）。未設定＝不限制（單一網域部署）。
 *  - CORS：只有允許清單內的 origin 會收到 Access-Control-Allow-Origin（附 credentials）。
 *    公開 API 允許：APP_BASE_URL 的 origin ＋ CORS_ALLOWED_ORIGINS；後台 API 只允許後台 origin。
 */
export const ADMIN_PATH_PREFIXES = ['/api/admin/', '/api/auth/admin/'] as const;

export function isAdminPath(path: string): boolean {
  return ADMIN_PATH_PREFIXES.some((p) => path.startsWith(p));
}

/** 請求的主機名稱（小寫、不含連接埠） */
export function requestHost(req: Request, c: AppConfig = config()): string {
  const raw = req.headers.get(c.HOST_HEADER) ?? req.headers.get('host') ?? new URL(req.url).host;
  const first = raw.split(',')[0]!.trim().toLowerCase();
  return first.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
}

/** 後台 API 是否可在此請求的主機上提供 */
export function adminHostAllowed(req: Request, c: AppConfig = config()): boolean {
  if (!c.ADMIN_HOST) return true;
  return requestHost(req, c) === c.ADMIN_HOST.replace(/:\d+$/, '');
}

const originOf = (u: string): string | null => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

export function adminOrigin(c: AppConfig = config()): string | null {
  if (c.ADMIN_BASE_URL) return originOf(c.ADMIN_BASE_URL);
  return c.ADMIN_HOST ? `https://${c.ADMIN_HOST}` : null;
}

/** 公開前台允許的 origin */
export function siteOrigins(c: AppConfig = config()): string[] {
  const extra = c.CORS_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean).map(originOf);
  return [...new Set([originOf(c.APP_BASE_URL), ...extra].filter((x): x is string => Boolean(x)))];
}

/** 此路徑允許的跨網域 origin */
export function allowedOrigins(path: string, c: AppConfig = config()): string[] {
  const admin = adminOrigin(c);
  if (isAdminPath(path)) return admin ? [admin] : siteOrigins(c);
  return siteOrigins(c);
}

/** 以 cookie 驗證身分的寫入請求可接受的 Origin（CSRF）：前台＋後台 */
export function csrfOrigins(c: AppConfig = config()): string[] {
  const admin = adminOrigin(c);
  return [...new Set([...siteOrigins(c), ...(admin ? [admin] : [])])];
}

const ALLOW_HEADERS = 'content-type, authorization, x-csrf-token, x-device-fingerprint, idempotency-key';
const ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';

/** 一般回應的 CORS 標頭（origin 不在允許清單 → 不加，瀏覽器會擋下） */
export function corsHeaders(req: Request, c: AppConfig = config()): Record<string, string> {
  const origin = req.headers.get('origin');
  if (!origin) return {};
  const path = new URL(req.url).pathname;
  if (!allowedOrigins(path, c).includes(origin)) return {};
  return { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin' };
}

/** 預檢請求（OPTIONS）回應；由 src/middleware.ts 呼叫 */
export function preflightResponse(req: Request, c: AppConfig = config()): Response {
  const path = new URL(req.url).pathname;
  if (isAdminPath(path) && !adminHostAllowed(req, c)) return new Response(null, { status: 404 });
  const h = corsHeaders(req, c);
  if (!h['access-control-allow-origin']) return new Response(null, { status: 403, headers: { vary: 'Origin' } });
  return new Response(null, {
    status: 204,
    headers: { ...h, 'access-control-allow-methods': ALLOW_METHODS, 'access-control-allow-headers': ALLOW_HEADERS, 'access-control-max-age': '600' },
  });
}
