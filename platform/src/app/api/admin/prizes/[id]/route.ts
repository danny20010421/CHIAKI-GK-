import { z } from 'zod';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { PrizeAttributesSchema, updatePrizeAttributes } from '@/server/modules/pool/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** PATCH /api/admin/prizes/:id — 獎項分類與大件・限宅配 { category?, bulky? }（不影響籤表承諾） */
export const PATCH = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  const b = await body(req, PrizeAttributesSchema);
  return json(await updatePrizeAttributes(p, z.string().uuid().parse(id), b));
});
