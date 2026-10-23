import { z } from 'zod';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { CouponUpdateSchema, deleteCoupon, updateCoupon } from '@/server/modules/marketing/marketing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** PATCH /api/admin/coupons/:id — 修改（已使用過的代碼不可改） */
export const PATCH = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await updateCoupon(p, z.string().uuid().parse(id), await body(req, CouponUpdateSchema)));
});

/** DELETE /api/admin/coupons/:id — 軟刪除 */
export const DELETE = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await deleteCoupon(p, z.string().uuid().parse(id)));
});
