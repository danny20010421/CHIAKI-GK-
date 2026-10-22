import { z } from 'zod';
import { body, json, requirePrincipal, route } from '@/server/http';
import { verifyAge } from '@/server/modules/auth/users';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const B = z.object({ birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

/** POST /api/me/age-verification — 年齡驗證（替身；正式驗證方式待法務） */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, B);
  return json(await verifyAge(p.userId, b.birthDate));
});
