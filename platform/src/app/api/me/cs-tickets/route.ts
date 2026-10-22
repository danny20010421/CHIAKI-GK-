import { db } from '@/server/db';
import { body, json, requirePrincipal, route } from '@/server/http';
import { createTicket, CreateTicketSchema, listMyTickets } from '@/server/modules/cs/tickets';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/me/cs-tickets — 我的客服工單 */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json({ tickets: await listMyTickets(db(), p.userId) });
});

/** POST /api/me/cs-tickets — 建立工單 { category, subject, body, drawId?, paymentOrderId?, shipmentId? }（未指定時自動連結最近 30 天的紀錄） */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, CreateTicketSchema);
  return json(await createTicket(p.userId, b), 201);
});
