import { z } from 'zod';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { resolveReport } from '@/server/modules/forum/forum';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/forum/reports/:id — 結案 { status: RESOLVED|DISMISSED } */
export const POST = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await resolveReport(p, z.string().uuid().parse(id), await body(req, z.object({ status: z.enum(['RESOLVED', 'DISMISSED']) }))));
});
