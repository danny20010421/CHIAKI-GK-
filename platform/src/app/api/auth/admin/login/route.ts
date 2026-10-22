import { config } from '@/server/config';
import { body, json, requestIp, route } from '@/server/http';
import { adminLogin, AdminLoginSchema } from '@/server/modules/auth/admin-auth';
import { newCsrfToken, sessionCookies } from '@/server/security/cookies';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/auth/admin/login — 後台帳號密碼登入 { loginId, password, totp? }
 * 回傳 Bearer token，並同時設定 HttpOnly session cookie 與 CSRF cookie（以 cookie 呼叫時須帶 x-csrf-token）。
 * 連續失敗會指數退避並鎖定；錯誤訊息不區分帳號不存在或密碼錯誤。
 */
export const POST = route(async (req: Request) => {
  const b = await body(req, AdminLoginSchema);
  const r = await adminLogin(b, { ip: requestIp(req) });
  const csrf = newCsrfToken();
  const res = json({ ...r, csrfToken: csrf, reauthValidMinutes: config().ADMIN_REAUTH_MAX_AGE_MIN });
  for (const c of sessionCookies(r.token, csrf, 12 * 3600)) res.headers.append('set-cookie', c);
  return res;
});
