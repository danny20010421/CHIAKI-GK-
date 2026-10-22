import { db } from '@/server/db';
import { json, route, type RouteContext } from '@/server/http';
import { getPoolDetail } from '@/server/modules/pool/queries';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/pools/:id — 賞池詳情：獎項、規則版本與雜湊、保底狀態、各套承諾雜湊與剩餘數 */
export const GET = route(async (_req: Request, ctx: RouteContext<{ id: string }>) => {
  const { id } = await ctx.params;
  return json(await getPoolDetail(db(), id));
});
