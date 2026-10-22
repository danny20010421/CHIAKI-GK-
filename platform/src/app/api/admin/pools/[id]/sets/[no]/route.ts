import { body, intParam, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { SetConfigSchema, updateSetConfig } from '@/server/modules/pool/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PATCH /api/admin/pools/:id/sets/:no — 逐套設定：
 * { shippingFeeHome? (150–300), shippingFeeCvs? (60–150), prizes?: [{ prizeId, recycleValue?, recyclable? }] }
 */
export const PATCH = route(async (req: Request, ctx: RouteContext<{ id: string; no: string }>) => {
  const p = await requirePrincipal(req);
  const { id, no } = await ctx.params;
  const b = await body(req, SetConfigSchema);
  return json(await updateSetConfig(p, id, intParam(no, 'setNo'), b));
});
