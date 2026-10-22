import { randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config';

/**
 * Cookie session 與 CSRF（double-submit）：
 *  - chiaki_session：HttpOnly、Secure（production）、SameSite=Lax，內容與 Bearer token 相同。
 *  - chiaki_csrf：前端可讀；以 cookie 驗證身分的「非安全方法」請求必須帶 x-csrf-token header 且與 cookie 相同，
 *    並且 Origin（若有）必須等於 APP_BASE_URL 的 origin。Bearer token 不受 CSRF 影響（瀏覽器不會自動附帶）。
 */
export const SESSION_COOKIE = 'chiaki_session';
export const CSRF_COOKIE = 'chiaki_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function newCsrfToken(): string {
  return randomBytes(24).toString('base64url');
}

function secure(): string {
  return config().NODE_ENV === 'production' ? '; Secure' : '';
}

export function sessionCookies(token: string, csrf: string, maxAgeSec: number): string[] {
  return [
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure()}`,
    `${CSRF_COOKIE}=${csrf}; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}${secure()}`,
  ];
}

export function clearSessionCookies(): string[] {
  return [`${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure()}`, `${CSRF_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0${secure()}`];
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 回傳 null = 通過；否則為拒絕原因 */
export function csrfViolation(req: Request): string | null {
  if (SAFE.has(req.method)) return null;
  const cookies = parseCookies(req);
  const c = cookies[CSRF_COOKIE];
  const h = req.headers.get(CSRF_HEADER);
  if (!c || !h) return 'missing csrf token';
  const a = Buffer.from(c);
  const b = Buffer.from(h);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return 'csrf token mismatch';
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(config().APP_BASE_URL).origin) return 'cross-origin request';
  return null;
}
