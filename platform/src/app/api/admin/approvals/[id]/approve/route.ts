import { z } from 'zod';
import { json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { approve } from '@/server/modules/admin/approvals';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const B = z.object({ note: z.string().max(500).optional() });

/** POST /api/admin/approvals/:id/approve — 覆核（不可處理自己提出的申請） */
export const POST = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  const text = await req.text();
  const b = text ? B.parse(JSON.parse(text)) : {};
  return json(await approve(p, id, b.note));
});
