import { z } from 'zod';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { linkAsset, LinkSchema, unlinkAsset } from '@/server/modules/assets/assets';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/assets/:id/links — 連結素材 { targetType: POOL|PRIZE|BANNER|IP|PARTNER|PRODUCT, targetId, role? } */
export const POST = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  const b = await body(req, LinkSchema);
  return json(await linkAsset(p, z.string().uuid().parse(id), b), 201);
});

/** DELETE /api/admin/assets/:id/links — 取消連結 { targetType, targetId, role? } */
export const DELETE = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  const b = await body(req, LinkSchema);
  return json(await unlinkAsset(p, z.string().uuid().parse(id), b));
});
