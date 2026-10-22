import { z } from 'zod';
import { db } from '@/server/db';
import { json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { getMemberDraw } from '@/server/modules/draw/history';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/me/draws/:id — 單筆抽賞紀錄（超過 3 個月 → 404） */
export const GET = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await getMemberDraw(db(), p.userId, z.string().uuid().parse(id)));
});
