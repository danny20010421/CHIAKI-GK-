import { z } from 'zod';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { staffReply, StaffReplySchema } from '@/server/modules/cs/tickets';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/cs/tickets/:id/messages — 回覆 { body?, cannedCode?, internal? }（公開回覆 → 待用戶回覆＋通知會員） */
export const POST = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  const b = await body(req, StaffReplySchema);
  return json(await staffReply(p, z.string().uuid().parse(id), b), 201);
});
