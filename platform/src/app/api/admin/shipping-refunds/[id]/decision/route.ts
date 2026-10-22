import { z } from 'zod';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { decideCashRefund } from '@/server/modules/shipping/shipping-refunds';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const B = z.object({ decision: z.enum(['APPROVE', 'REJECT']), note: z.string().max(500).optional() });

/** POST /api/admin/shipping-refunds/:id/decision — 核准或駁回（第一人） */
export const POST = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  const b = await body(req, B);
  return json(await decideCashRefund(p, z.string().uuid().parse(id), b.decision, b.note));
});
