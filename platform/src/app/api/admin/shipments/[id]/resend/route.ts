import { z } from 'zod';
import { json, optionalBody, requirePrincipal, route, type RouteContext } from '@/server/http';
import { resendShipment } from '@/server/modules/shipping/fulfilment';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/shipments/:id/resend — 退件/異常 → 重新揀貨出貨 { note? } */
export const POST = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  const b = await optionalBody(req, z.object({ note: z.string().max(500).optional() }));
  return json(await resendShipment(p, z.string().uuid().parse(id), b.note));
});
