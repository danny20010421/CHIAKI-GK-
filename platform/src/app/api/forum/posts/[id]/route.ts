import { z } from 'zod';
import { db } from '@/server/db';
import { json, optionalPrincipal, route, type RouteContext } from '@/server/http';
import { getPost } from '@/server/modules/forum/forum';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/forum/posts/:id — 貼文與留言（只含已公開者＋自己的） */
export const GET = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const viewer = await optionalPrincipal(req);
  const { id } = await ctx.params;
  return json(await getPost(db(), viewer?.userId ?? null, z.string().uuid().parse(id)));
});
