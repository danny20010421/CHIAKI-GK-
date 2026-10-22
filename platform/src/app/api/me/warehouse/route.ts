import { z } from 'zod';
import { db } from '@/server/db';
import { json, query, requirePrincipal, route } from '@/server/http';
import { listWarehouse } from '@/server/modules/warehouse/warehouse';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Status = z.enum(['STORED', 'SHIP_REQUESTED', 'SHIPPED', 'DELIVERED', 'RECYCLED']).optional();

/** GET /api/me/warehouse?status= — 我的中獎倉庫 */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const status = Status.parse(query(req).get('status') ?? undefined);
  return json({ items: await listWarehouse(db(), p.userId, status) });
});
