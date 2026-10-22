import { db } from '@/server/db';
import { json, query, requirePrincipal, route } from '@/server/http';
import { requirePermission } from '@/server/modules/auth/rbac';
import { listCarriers } from '@/server/modules/shipping/fulfilment';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/admin/carriers?method= — 物流商（黑貓/新竹/郵局、7-ELEVEN 交貨便、全家店到店）與追蹤網址樣板 */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  requirePermission(p, 'shipment.manage');
  return json({ carriers: await listCarriers(db(), query(req).get('method') ?? undefined) });
});
