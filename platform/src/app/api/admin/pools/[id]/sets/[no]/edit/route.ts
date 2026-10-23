import { body, intParam, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { EditSetSchema, editSet } from '@/server/modules/pool/manage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PATCH /api/admin/pools/:id/sets/:no/edit — { displayName?, internalNote?, regenerate?, reason }
 * regenerate: true 重新產生籤表與承諾雜湊（只限 0 銷售；否則 409「已有銷售紀錄，只能下架」）
 */
export const PATCH = route(async (req: Request, ctx: RouteContext<{ id: string; no: string }>) => {
  const p = await requirePrincipal(req);
  const { id, no } = await ctx.params;
  return json(await editSet(p, id, intParam(no, 'setNo'), await body(req, EditSetSchema)));
});
