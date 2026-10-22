import { z } from 'zod';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { markShipped } from '@/server/modules/shipping/shipping';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const B = z.object({ carrier: z.string().regex(/^[A-Z0-9_]{2,20}$/), trackingNo: z.string().min(3).max(50) });

/** POST /api/admin/shipments/:id/ship — 標記已出貨（須已包裝；必填物流商 carrier 與追蹤編號）。等同 /status { to: SHIPPED } */
export const POST = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  const b = await body(req, B);
  return json(await markShipped(p, id, b.trackingNo, b.carrier));
});
