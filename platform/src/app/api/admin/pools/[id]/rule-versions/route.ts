import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { createRuleVersionDraft, RuleAmendmentSchema } from '@/server/modules/pool/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/pools/:id/rule-versions — 修改條款＝建立新規則版本草稿（已發布版本不可變） */
export const POST = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  const b = await body(req, RuleAmendmentSchema);
  return json(await createRuleVersionDraft(p, id, b), 201);
});
