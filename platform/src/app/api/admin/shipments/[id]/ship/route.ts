import { z } from 'zod';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { markShipped } from '@/server/modules/shipping/shipping';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const B = z.object({ trackingNo: z.string().min(3).max(50) });

export const POST = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  const b = await body(req, B);
  return json(await markShipped(p, id, b.trackingNo));
});
