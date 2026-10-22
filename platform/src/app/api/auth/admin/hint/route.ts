import { z } from 'zod';
import { json, query, route } from '@/server/http';
import { getPasswordHint } from '@/server/modules/auth/admin-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/auth/admin/hint?loginId= — 後台登入頁的密碼提示（業主要求）。
 * ⚠ 密碼提示會降低安全性：建議正式環境移除或限制於 ADMIN_IP_ALLOWLIST 內使用（見 admin-auth.ts 註解）。
 */
export const GET = route(async (req: Request) => {
  const loginId = z.string().min(3).max(64).parse(query(req).get('loginId') ?? '');
  return json({ hint: await getPasswordHint(loginId) });
});
