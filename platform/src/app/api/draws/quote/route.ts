import { body, json, requirePrincipal, route } from '@/server/http';
import { DrawRequestSchema, quoteDraw } from '@/server/modules/draw/draw';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/draws/quote — 付款前試算（不扣款、不鎖籤）。
 * body 與 POST /api/draws 相同：{ poolId, setNo, ticketNos | count, shippingMethod? }
 * 回傳籤價、按套預收運費明細（本次需收幾份、各物流方式金額、目前持有小獎數與涵蓋額度）、總額與餘額是否足夠。
 */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, DrawRequestSchema);
  return json(await quoteDraw(p.userId, b));
});
