import { z } from 'zod';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { deletePrize, updatePrize, UpdatePrizeSchema } from '@/server/modules/pool/structure';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PATCH /api/admin/prizes/:id — 修改獎項
 *   隨時可改（留稽核）：{ name?, recycleValue?, recyclable?, tag?, bulky?, imageUrl? }
 *   只在草稿：{ qtyPerSet?, levelNo? }
 */
export const PATCH = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  const b = await body(req, UpdatePrizeSchema);
  return json(await updatePrize(p, z.string().uuid().parse(id), b));
});

/** DELETE /api/admin/prizes/:id — 刪除獎項（只在草稿；保底獎項由保底設定管理） */
export const DELETE = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await deletePrize(p, z.string().uuid().parse(id)));
});
