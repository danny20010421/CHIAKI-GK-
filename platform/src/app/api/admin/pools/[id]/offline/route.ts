import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { OfflineSchema, setPoolOffline } from '@/server/modules/pool/manage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/pools/:id/offline — 下架 / 重新上架整個賞池 { offline: boolean, reason }（下架時釋出所有保留；既有抽賞與倉庫不受影響） */
export const POST = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await setPoolOffline(p, id, await body(req, OfflineSchema)));
});
