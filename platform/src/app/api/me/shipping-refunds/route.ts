import { db } from '@/server/db';
import { json, requirePrincipal, route } from '@/server/http';
import { listMyShippingItemRefunds } from '@/server/modules/shipping/prepaid';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/me/shipping-refunds — 回收小獎的逐件運費退還（每件 運費 ÷ N，不可退款代幣）：各套累計件數/金額與明細。
 * 運費退還一律為代幣，不提供新台幣退款（新台幣退款僅限未使用的儲值代幣：/api/me/refund-requests）。
 */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json(await listMyShippingItemRefunds(db(), p.userId));
});
