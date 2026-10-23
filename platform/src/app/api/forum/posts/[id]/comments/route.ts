import { z } from 'zod';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { CommentSchema, createComment } from '@/server/modules/forum/forum';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/forum/posts/:id/comments — 留言 { body (2–300) }；一律先待審 */
export const POST = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await createComment(p.userId, z.string().uuid().parse(id), await body(req, CommentSchema)), 201);
});
