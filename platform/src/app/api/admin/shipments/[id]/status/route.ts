import { z } from 'zod';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { advanceShipment, AdvanceSchema } from '@/server/modules/shipping/fulfilment';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/admin/shipments/:id/status — 推進出貨流程 { to, carrier?, trackingNo?, note? }
 * 申請 → 揀貨 → 包裝 → 已出貨（必填物流商＋追蹤編號）→ 已送達；已出貨 → 退件；任一處理中狀態 → 異常
 */
export const POST = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  const b = await body(req, AdvanceSchema);
  return json(await advanceShipment(p, z.string().uuid().parse(id), b));
});
