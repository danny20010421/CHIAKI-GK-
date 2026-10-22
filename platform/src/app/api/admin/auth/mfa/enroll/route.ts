import { json, requirePrincipal, route } from '@/server/http';
import { enrollMfa } from '@/server/modules/auth/admin-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/auth/mfa/enroll — 產生 TOTP 金鑰（回傳 otpauth URL 供驗證器 App 掃描） */
export const POST = route(
  async (req: Request) => {
    const p = await requirePrincipal(req);
    return json(await enrollMfa(p), 201);
  },
  { adminAuthOnly: true },
);
