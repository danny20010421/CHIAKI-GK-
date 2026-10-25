import { db } from '@/server/db';
import { body, json, requirePrincipal, route } from '@/server/http';
import { z } from 'zod';
import { listShipments, requestShipment } from '@/server/modules/shipping/shipping';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/me/shipments — 我的出貨單 */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json({ shipments: await listShipments(db(), p.userId) });
});

/**
 * POST /api/me/shipments — 申請出貨（可合併多件；運費到付，不扣 UC幣）
 * { itemIds, destinations?: { home?: {addressId}|{recipientName, recipientPhone, address}, c711?: {...cvsStoreId}, fami?: {...cvsStoreId} } }
 * 寄送方式由獎項預設（不可自選）；不同寄送方式的物品會拆成多張出貨單（回應 shipments[]）。
 */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, z.unknown());
  return json(await requestShipment(p.userId, b), 201);
});
