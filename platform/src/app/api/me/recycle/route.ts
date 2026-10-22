import { z } from 'zod';
import { body, json, requirePrincipal, route } from '@/server/http';
import { ItemIdsSchema, recycleItems } from '@/server/modules/warehouse/warehouse';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const B = z.object({ itemIds: ItemIdsSchema, shippingRefund: z.enum(['COINS', 'CASH']).default('COINS') });

/**
 * POST /api/me/recycle — 回收獎品換平台點數（不可逆；點數不可提領）。
 * 回收小獎後若預收運費多收：shippingRefund=COINS（預設、建議）自動退還不可退款代幣；
 * CASH → 不自動退，回傳可申請新台幣退款的運費（POST /api/me/shipping-refunds）。
 */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, B);
  return json(await recycleItems(p.userId, b.itemIds, { shippingRefund: b.shippingRefund }));
});
