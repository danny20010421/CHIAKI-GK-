import { json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { markDelivered } from '@/server/modules/shipping/shipping';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await markDelivered(p, id));
});
