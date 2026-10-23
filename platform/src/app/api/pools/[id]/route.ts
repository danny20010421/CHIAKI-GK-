import { db } from '@/server/db';
import { json, optionalPrincipal, route, type RouteContext } from '@/server/http';
import { getPoolDetail } from '@/server/modules/pool/queries';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/pools/:id — 賞池詳情：獎項、規則版本與雜湊、保底狀態、各套承諾雜湊與剩餘數。
 * 不含回收值；oddsLocked / oddsUnlockLevel 表示目前觀看者是否可看即時機率（VIP 等級解鎖）。
 */
export const GET = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const { id } = await ctx.params;
  const viewer = await optionalPrincipal(req);
  return json(await getPoolDetail(db(), id, viewer?.userId));
});
