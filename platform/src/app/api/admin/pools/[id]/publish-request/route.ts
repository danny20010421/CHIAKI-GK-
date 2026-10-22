import { json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { requestPoolPublish } from '@/server/modules/admin/approvals';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/pools/:id/publish-request — 申請發布（需另一位管理者核准） */
export const POST = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await requestPoolPublish(p, id), 201);
});
