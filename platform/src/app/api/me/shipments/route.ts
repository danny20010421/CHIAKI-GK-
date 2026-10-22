import { db } from '@/server/db';
import { body, json, requirePrincipal, route } from '@/server/http';
import { listShipments, requestShipment, ShipmentRequestSchema } from '@/server/modules/shipping/shipping';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/me/shipments — 我的出貨單 */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json({ shipments: await listShipments(db(), p.userId) });
});

/** POST /api/me/shipments — 申請出貨（可合併多件；運費以代幣扣款） */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, ShipmentRequestSchema);
  return json(await requestShipment(p.userId, b), 201);
});
