import { z } from 'zod';
import { db } from '@/server/db';
import { json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { requirePermission } from '@/server/modules/auth/rbac';
import { shipmentEvents } from '@/server/modules/shipping/fulfilment';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/admin/shipments/:id/events — 出貨事件紀錄 */
export const GET = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  requirePermission(p, 'shipment.manage');
  const { id } = await ctx.params;
  return json({ events: await shipmentEvents(db(), z.string().uuid().parse(id)) });
});
