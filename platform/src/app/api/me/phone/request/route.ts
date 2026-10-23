import { z } from 'zod';
import { body, json, requirePrincipal, route } from '@/server/http';
import { requestPhoneChange } from '@/server/modules/member/profile';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/me/phone/request — 換手機：發送 OTP 到「新號碼」{ phone }（每小時限次） */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json(await requestPhoneChange(p.userId, await body(req, z.object({ phone: z.string() }))), 201);
});
