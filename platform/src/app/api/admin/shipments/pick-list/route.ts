import { z } from 'zod';
import { json, query, requirePrincipal, route } from '@/server/http';
import { pickList } from '@/server/modules/shipping/fulfilment';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Q = z.object({
  status: z.enum(['REQUESTED', 'PICKING', 'PACKING']).optional(),
  ids: z.array(z.string().uuid()).max(200).optional(),
});

/** GET /api/admin/shipments/pick-list?status=REQUESTED 或 ?ids=a,b — 批次列印揀貨單資料 */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const q = query(req);
  const ids = q.get('ids');
  return json(await pickList(p, Q.parse({ status: q.get('status') ?? undefined, ids: ids ? ids.split(',') : undefined })));
});
