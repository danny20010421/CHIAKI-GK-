import { z } from 'zod';
import { json, optionalBody, requirePrincipal, route, type RouteContext } from '@/server/http';
import { payoutCashRefund, PayoutSchema } from '@/server/modules/shipping/shipping-refunds';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/shipping-refunds/:id/payout — 撥款（第二人，不可與核准者相同）{ bankTransferRef? }；冪等 */
export const POST = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  const b = await optionalBody(req, PayoutSchema);
  return json(await payoutCashRefund(p, z.string().uuid().parse(id), b));
});
