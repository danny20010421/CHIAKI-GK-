import { z } from 'zod';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { correctShipment, CorrectionSchema } from '@/server/modules/shipping/fulfilment';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PATCH /api/admin/shipments/:id — 更正出貨單 { method?, carrier?, trackingNo?, recipientName?, recipientPhone?, address?, cvsStoreId?, cvsStoreName?,
 *   status?（可回退；例外：EXCEPTION 配送異常 / RETURNED 退件 / LOST 遺失 / DAMAGED 破損）, reason?, notifyMember? }
 * 回退、例外、修改既有追蹤編號、改出貨方式需填 reason；大件不可改超商。每次更正寫入出貨事件紀錄（會員可見）與稽核鏈。
 */
export const PATCH = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await correctShipment(p, z.string().uuid().parse(id), await body(req, CorrectionSchema)));
});
