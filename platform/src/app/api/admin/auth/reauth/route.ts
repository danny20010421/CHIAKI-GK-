import { body, json, requestIp, requirePrincipal, route } from '@/server/http';
import { adminReauth, ReauthSchema } from '@/server/modules/auth/admin-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/auth/reauth — 重新驗證 { password, totp? }（後台操作需在 ADMIN_REAUTH_MAX_AGE_MIN 分鐘內驗證過） */
export const POST = route(
  async (req: Request) => {
    const p = await requirePrincipal(req);
    const b = await body(req, ReauthSchema);
    return json(await adminReauth(p, b, { ip: requestIp(req) }));
  },
  { adminAuthOnly: true },
);
