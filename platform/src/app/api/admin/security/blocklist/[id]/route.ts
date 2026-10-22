import { intParam, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { removeBlock } from '@/server/security/blocklist';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** DELETE /api/admin/security/blocklist/:id — 解除封鎖 */
export const DELETE = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await removeBlock(p, intParam(id, 'id')));
});
