import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { PoolSettingsSchema, updatePoolSettings } from '@/server/modules/pool/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** PATCH /api/admin/pools/:id — 營運設定：出貨時程說明 shippingNote（無固定 SLA） */
export const PATCH = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  const b = await body(req, PoolSettingsSchema);
  return json(await updatePoolSettings(p, id, b));
});
