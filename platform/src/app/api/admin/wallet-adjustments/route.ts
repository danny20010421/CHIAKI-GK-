import { body, json, requirePrincipal, route } from '@/server/http';
import { BalanceAdjustSchema, requestBalanceAdjust } from '@/server/modules/admin/approvals';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/wallet-adjustments — 申請人工調整餘額（雙人覆核後才入帳） */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, BalanceAdjustSchema);
  return json(await requestBalanceAdjust(p, b), 201);
});
