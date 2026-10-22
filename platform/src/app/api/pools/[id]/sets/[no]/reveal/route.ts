import { db } from '@/server/db';
import { intParam, json, route, type RouteContext } from '@/server/http';
import { revealSet } from '@/server/modules/pool/queries';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/pools/:id/sets/:no/reveal — 完售後公開籤表與 salt（未完售回 409 NOT_SOLD_OUT） */
export const GET = route(async (_req: Request, ctx: RouteContext<{ id: string; no: string }>) => {
  const { id, no } = await ctx.params;
  return json(await revealSet(db(), id, intParam(no, 'setNo')));
});
