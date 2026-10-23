import { z } from 'zod';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { ActionSchema, runTicketAction } from '@/server/modules/cs/tickets';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/admin/cs/tickets/:id/actions — 一鍵動作：
 *   { action: RESEND_SHIPMENT, shipmentId? } | { action: EXTEND_STORAGE, days, itemIds? }
 *   | { action: APPROVE_REFUND, refundId }（未使用儲值代幣的退款申請） | { action: GRANT_COMPENSATION, points, memo }
 */
export const POST = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  const b = await body(req, ActionSchema);
  return json(await runTicketAction(p, z.string().uuid().parse(id), b), 201);
});
