import { z } from 'zod';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { getTicket, updateTicket, UpdateTicketSchema } from '@/server/modules/cs/tickets';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/admin/cs/tickets/:id — 工單詳情：會員、連結的抽賞/訂單/出貨、對話（含內部備註）、一鍵動作紀錄 */
export const GET = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await getTicket(p, z.string().uuid().parse(id)));
});

/** PATCH /api/admin/cs/tickets/:id — { status?, assigneeId? } */
export const PATCH = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  const b = await body(req, UpdateTicketSchema);
  return json(await updateTicket(p, z.string().uuid().parse(id), b));
});
