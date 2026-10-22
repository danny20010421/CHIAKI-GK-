import { z } from 'zod';
import { body, intParam, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { holdTickets, releaseHolds, TicketNosSchema } from '@/server/modules/draw/holds';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const HoldBody = z.object({ ticketNos: TicketNosSchema });
const ReleaseBody = z.object({ ticketNos: TicketNosSchema.optional() });

/** POST /api/pools/:id/sets/:no/holds — 鎖籤（預設 180 秒） */
export const POST = route(async (req: Request, ctx: RouteContext<{ id: string; no: string }>) => {
  const p = await requirePrincipal(req);
  const { id, no } = await ctx.params;
  const b = await body(req, HoldBody);
  return json(await holdTickets(p.userId, id, intParam(no, 'setNo'), b.ticketNos), 201);
}, { bot: 'HOLD' });

/** DELETE /api/pools/:id/sets/:no/holds — 釋出自己的鎖籤（body 可省略＝全部） */
export const DELETE = route(async (req: Request, ctx: RouteContext<{ id: string; no: string }>) => {
  const p = await requirePrincipal(req);
  const { id, no } = await ctx.params;
  const text = await req.text();
  const b = text ? ReleaseBody.parse(JSON.parse(text)) : {};
  return json(await releaseHolds(p.userId, id, intParam(no, 'setNo'), b.ticketNos));
});
