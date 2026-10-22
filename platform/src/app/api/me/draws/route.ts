import { z } from 'zod';
import { db } from '@/server/db';
import { json, query, requirePrincipal, route } from '@/server/http';
import { listMemberDraws } from '@/server/modules/draw/history';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Q = z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), before: z.coerce.date().optional() });

/** GET /api/me/draws?limit=&before= — 我的抽賞紀錄（只顯示近 3 個月；更早的已封存，不對會員顯示） */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const q = query(req);
  const f = Q.parse({ limit: q.get('limit') ?? undefined, before: q.get('before') ?? undefined });
  return json(await listMemberDraws(db(), p.userId, f));
});
