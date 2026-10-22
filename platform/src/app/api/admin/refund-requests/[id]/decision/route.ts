import { z } from 'zod';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { decideRefundRequest } from '@/server/modules/admin/approvals';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const B = z.object({ decision: z.enum(['APPROVE', 'REJECT']), note: z.string().max(500).optional() });

/** POST /api/admin/refund-requests/:id/decision — 駁回，或提出核准（→ 需第二人覆核後才扣款） */
export const POST = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  const b = await body(req, B);
  return json(await decideRefundRequest(p, id, b.decision, b.note));
});
