import { z } from 'zod';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { BannerUpdateSchema, deleteBanner, updateBanner } from '@/server/modules/marketing/marketing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** PATCH /api/admin/banners/:id — 修改橫幅 */
export const PATCH = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await updateBanner(p, z.string().uuid().parse(id), await body(req, BannerUpdateSchema)));
});

/** DELETE /api/admin/banners/:id — 刪除橫幅 */
export const DELETE = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await deleteBanner(p, z.string().uuid().parse(id)));
});
