import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { ReasonOnlySchema, restorePool } from '@/server/modules/pool/manage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/pools/:id/restore — 還原已刪除的賞池（30 天內；需 SUPER_ADMIN）{ reason } */
export const POST = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await restorePool(p, id, await body(req, ReasonOnlySchema)));
});
