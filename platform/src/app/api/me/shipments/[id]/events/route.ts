import { z } from 'zod';
import { db } from '@/server/db';
import { json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { memberShipmentEvents } from '@/server/modules/shipping/fulfilment';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/me/shipments/:id/events — 出貨事件紀錄（狀態、時間、操作者、備註/更正原因） */
export const GET = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await memberShipmentEvents(db(), p.userId, z.string().uuid().parse(id)));
});
