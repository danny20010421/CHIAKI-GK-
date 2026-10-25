import { z } from 'zod';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { BannerUpdateSchema, deleteBanner, getBannerAdmin, updateBanner } from '@/server/modules/marketing/marketing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/admin/banners/:id — 單一橫幅 */
export const GET = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await getBannerAdmin(p, z.string().uuid().parse(id)));
});

/** PATCH /api/admin/banners/:id — 修改橫幅（欄位同 POST，皆選填；圖片給素材 id 或網址會互相取代；稽核含 before/after） */
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
