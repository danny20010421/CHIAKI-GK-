import { z } from 'zod';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { ProductAttributesSchema, updateProductAttributes } from '@/server/modules/catalog/catalog';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** PATCH /api/admin/products/:id — 商品分類與大件・限宅配 { category?, bulky? } */
export const PATCH = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  const b = await body(req, ProductAttributesSchema);
  return json(await updateProductAttributes(p, z.string().uuid().parse(id), b));
});
