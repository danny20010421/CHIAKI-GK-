import { body, intParam, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { OfflineSchema, setSetOffline } from '@/server/modules/pool/manage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/pools/:id/sets/:no/offline — 下架 / 重新上架單一套 { offline: boolean, reason } */
export const POST = route(async (req: Request, ctx: RouteContext<{ id: string; no: string }>) => {
  const p = await requirePrincipal(req);
  const { id, no } = await ctx.params;
  return json(await setSetOffline(p, id, intParam(no, 'setNo'), await body(req, OfflineSchema)));
});
