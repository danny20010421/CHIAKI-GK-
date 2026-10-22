import { z } from 'zod';
import { db } from '@/server/db';
import { json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { getMyTicket } from '@/server/modules/cs/tickets';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/me/cs-tickets/:id — 工單內容與對話（不含客服內部備註） */
export const GET = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await getMyTicket(db(), p.userId, z.string().uuid().parse(id)));
});
