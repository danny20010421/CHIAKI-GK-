import { body, json, requirePrincipal, route } from '@/server/http';
import { DrawRequestSchema, quoteDraw } from '@/server/modules/draw/draw';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/draws/quote — 付款前試算（不扣款、不鎖籤）。
 * body 與 POST /api/draws 相同：{ poolId, setNo, ticketNos | count, shippingMethod? }
 * 回傳籤價、總額與 CC幣餘額是否足夠（運費到付，不含運費）。
 */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, DrawRequestSchema);
  return json(await quoteDraw(p.userId, b));
});
