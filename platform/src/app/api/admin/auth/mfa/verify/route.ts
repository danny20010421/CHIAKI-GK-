import { body, json, requirePrincipal, route } from '@/server/http';
import { MfaVerifySchema, verifyMfaEnrollment } from '@/server/modules/auth/admin-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/auth/mfa/verify — 以驗證碼確認並啟用 MFA { code } */
export const POST = route(
  async (req: Request) => {
    const p = await requirePrincipal(req);
    const b = await body(req, MfaVerifySchema);
    return json(await verifyMfaEnrollment(p, b));
  },
  { adminAuthOnly: true },
);
