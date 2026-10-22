import { json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { requestRuleVersionPublish } from '@/server/modules/admin/approvals';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/rule-versions/:id/publish-request — 申請發布新規則版本（雙人覆核） */
export const POST = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await requestRuleVersionPublish(p, id), 201);
});
