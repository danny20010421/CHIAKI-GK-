import { json, route } from '@/server/http';
import { logoutSession } from '@/server/modules/auth/admin-auth';
import { clearSessionCookies, parseCookies, SESSION_COOKIE } from '@/server/security/cookies';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/auth/logout — 撤銷目前 session（Bearer 或 cookie）並清除 cookie */
export const POST = route(async (req: Request) => {
  const bearer = req.headers.get('authorization')?.match(/^Bearer\s+([A-Za-z0-9_-]{20,})$/)?.[1];
  const token = bearer ?? parseCookies(req)[SESSION_COOKIE];
  if (token) await logoutSession(token);
  const res = json({ loggedOut: true });
  for (const c of clearSessionCookies()) res.headers.append('set-cookie', c);
  return res;
});
