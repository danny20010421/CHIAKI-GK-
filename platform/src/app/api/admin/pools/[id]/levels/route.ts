import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { createLevel, CreateLevelSchema } from '@/server/modules/pool/structure';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/pools/:id/levels — 新增等級 { levelNo 1–8, name, isSmall?, items: [{ name, qtyPerSet, recycleValue?, recyclable?, tag?, bulky?, imageUrl? }] }（只在草稿） */
export const POST = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  const b = await body(req, CreateLevelSchema);
  return json(await createLevel(p, id, b), 201);
});
