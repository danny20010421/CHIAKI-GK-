import { db } from '@/server/db';
import { body, json, requirePrincipal, route } from '@/server/http';
import { getProfile, ProfileSchema, updateProfile } from '@/server/modules/member/profile';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/me/profile — 我的會員資料 */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json(await getProfile(db(), p.userId));
});

/**
 * PATCH /api/me/profile — { nickname? (2–16 字), realName?, email?, birthDate? (年齡驗證後鎖定),
 *   avatar?: { dataBase64, copyrightConfirmed: true } | null }（頭像 400×400；伺服器重新封裝、去除 EXIF/GPS）
 */
export const PATCH = route(
  async (req: Request) => {
    const p = await requirePrincipal(req);
    return json(await updateProfile(p.userId, await body(req, ProfileSchema)));
  },
  { maxBodyBytes: 300_000 },
);
