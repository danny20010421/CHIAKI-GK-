import { z } from 'zod';
import { body, json, requirePrincipal, route } from '@/server/http';
import { confirmPhoneChange } from '@/server/modules/member/profile';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/me/phone/confirm — 換手機：以新號碼收到的驗證碼確認 { phone, code }（錯誤多次會暫時鎖定） */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json(await confirmPhoneChange(p.userId, await body(req, z.object({ phone: z.string(), code: z.string() }))));
});
