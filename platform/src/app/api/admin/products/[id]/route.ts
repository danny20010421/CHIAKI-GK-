import { z } from 'zod';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { ProductAttributesSchema, updateProductAttributes } from '@/server/modules/catalog/catalog';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** PATCH /api/admin/products/:id — 商品標籤與大件・限宅配 { tag?, bulky? }（標籤：GK、PVC、一番賞、景品盲盒、卡牌、娃娃、其他） */
export const PATCH = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  const b = await body(req, ProductAttributesSchema);
  return json(await updateProductAttributes(p, z.string().uuid().parse(id), b));
});
