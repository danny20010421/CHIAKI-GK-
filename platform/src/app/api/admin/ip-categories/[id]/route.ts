import { z } from 'zod';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { CategoryUpdateSchema, deleteCategory, updateCategory } from '@/server/modules/catalog/ips';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** PATCH /api/admin/ip-categories/:id — { name?, visible? } */
export const PATCH = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  const b = await body(req, CategoryUpdateSchema);
  return json(await updateCategory(p, z.string().uuid().parse(id), b));
});

/** DELETE /api/admin/ip-categories/:id — 刪除分類（分類下仍有 IP → 409） */
export const DELETE = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await deleteCategory(p, z.string().uuid().parse(id)));
});
