import { body, json, requirePrincipal, route } from '@/server/http';
import { batchAdvance, BatchAdvanceSchema } from '@/server/modules/shipping/fulfilment';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/shipments/batch-status — 批次推進揀貨/包裝 { shipmentIds, to: PICKING|PACKING }（全有或全無） */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, BatchAdvanceSchema);
  return json(await batchAdvance(p, b));
});
