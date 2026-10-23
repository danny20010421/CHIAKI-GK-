import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { AddSetSchema, addSet } from '@/server/modules/pool/manage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/pools/:id/sets — 依目前的等級/獎項新增一套（新承諾雜湊）{ reason, displayName? } */
export const POST = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await addSet(p, id, await body(req, AddSetSchema)), 201);
});
