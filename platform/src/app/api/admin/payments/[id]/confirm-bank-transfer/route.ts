import { json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { requestBankTransferConfirm } from '@/server/modules/admin/approvals';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/payments/:id/confirm-bank-transfer — 申請確認銀行轉帳入帳（雙人覆核） */
export const POST = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await requestBankTransferConfirm(p, id), 201);
});
