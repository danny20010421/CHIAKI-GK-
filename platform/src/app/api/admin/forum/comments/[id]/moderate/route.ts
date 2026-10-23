import { z } from 'zod';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { moderate, ModerateSchema } from '@/server/modules/forum/forum';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/forum/comments/:id/moderate — { action: approve|reject|remove, reason }（退回/下架必填原因，會顯示給作者） */
export const POST = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await moderate(p, 'comment', z.string().uuid().parse(id), await body(req, ModerateSchema)));
});
