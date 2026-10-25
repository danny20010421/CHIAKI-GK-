import { db } from '@/server/db';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { requirePermission } from '@/server/modules/auth/rbac';
import { PoolSettingsSchema, updatePoolSettings } from '@/server/modules/pool/admin';
import { getAdminPool } from '@/server/modules/pool/structure';
import { deletePool, ReasonOnlySchema } from '@/server/modules/pool/manage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/admin/pools/:id — 後台檢視（含草稿）：等級、獎項、最後賞、保底、快速抽包、是否可改結構 */
export const GET = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  requirePermission(p, 'pool.config.manage');
  const { id } = await ctx.params;
  return json(await getAdminPool(db(), id));
});

/**
 * PATCH /api/admin/pools/:id — 營運設定：
 *   shippingNote（出貨時程說明，無固定 SLA）、ipId（連結 IP）、drawPacks（快速抽包：1、3、5、10、20、'all' 的子集合）；
 *   lastPrize（最後賞 { name, recycleValue?, recyclable?, tag?, bulky?, imageUrl? } 或 null；只在草稿）
 *   coverUrl（封面路徑或 https://；null＝移除）、videos（抽賞演出影片整份取代：[{ url, behavior?, enabled? }]）
 */
export const PATCH = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  const b = await body(req, PoolSettingsSchema);
  return json(await updatePoolSettings(p, id, b));
});

/** DELETE /api/admin/pools/:id — 刪除整個賞池 { reason }（需 SUPER_ADMIN；只限 0 銷售；軟刪除，30 天內可還原） */
export const DELETE = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await deletePool(p, id, await body(req, ReasonOnlySchema)));
});
