import { z } from 'zod';
import { json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { setLike } from '@/server/modules/forum/forum';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/forum/posts/:id/like — 按讚（每人一次，重複按不會加計） */
export const POST = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await setLike(p.userId, z.string().uuid().parse(id), true));
});

/** DELETE /api/forum/posts/:id/like — 收回讚 */
export const DELETE = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await setLike(p.userId, z.string().uuid().parse(id), false));
});
