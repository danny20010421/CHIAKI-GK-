import { z } from 'zod';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { ReplySchema, userReply } from '@/server/modules/cs/tickets';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/me/cs-tickets/:id/messages — 會員回覆 { body }（「待用戶回覆」→「處理中」） */
export const POST = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  const b = await body(req, ReplySchema);
  return json(await userReply(p.userId, z.string().uuid().parse(id), b), 201);
});
