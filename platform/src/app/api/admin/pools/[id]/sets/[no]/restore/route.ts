import { body, intParam, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { ReasonOnlySchema, restoreSet } from '@/server/modules/pool/manage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/pools/:id/sets/:no/restore — 還原已刪除的套（30 天內）{ reason } */
export const POST = route(async (req: Request, ctx: RouteContext<{ id: string; no: string }>) => {
  const p = await requirePrincipal(req);
  const { id, no } = await ctx.params;
  return json(await restoreSet(p, id, intParam(no, 'setNo'), await body(req, ReasonOnlySchema)));
});
