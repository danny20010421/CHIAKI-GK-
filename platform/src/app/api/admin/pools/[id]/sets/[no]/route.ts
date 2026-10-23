import { body, intParam, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { SetConfigSchema, updateSetConfig } from '@/server/modules/pool/admin';
import { deleteSet, ReasonOnlySchema } from '@/server/modules/pool/manage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PATCH /api/admin/pools/:id/sets/:no — 逐套設定：{ prizes: [{ prizeId, recycleValue?, recyclable? }] }
 * （運費到付：已無每套運費設定）
 */
export const PATCH = route(async (req: Request, ctx: RouteContext<{ id: string; no: string }>) => {
  const p = await requirePrincipal(req);
  const { id, no } = await ctx.params;
  const b = await body(req, SetConfigSchema);
  return json(await updateSetConfig(p, id, intParam(no, 'setNo'), b));
});

/**
 * DELETE /api/admin/pools/:id/sets/:no — 刪除套 { reason }（只限 0 銷售，否則 409「已有銷售紀錄，只能下架」；
 * 軟刪除，30 天內可還原；刪除最後一套＝刪除整個賞池，需 SUPER_ADMIN）
 */
export const DELETE = route(async (req: Request, ctx: RouteContext<{ id: string; no: string }>) => {
  const p = await requirePrincipal(req);
  const { id, no } = await ctx.params;
  return json(await deleteSet(p, id, intParam(no, 'setNo'), await body(req, ReasonOnlySchema)));
});
