import { db } from '@/server/db';
import { intParam, json, optionalPrincipal, route, type RouteContext } from '@/server/http';
import { getSetBoard } from '@/server/modules/pool/queries';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/pools/:id/sets/:no — 剩餘數、即時機率、籤板（未抽出的籤不揭露獎項） */
export const GET = route(async (req: Request, ctx: RouteContext<{ id: string; no: string }>) => {
  const { id, no } = await ctx.params;
  const viewer = await optionalPrincipal(req);
  return json(await getSetBoard(db(), id, intParam(no, 'setNo'), viewer?.userId));
});
