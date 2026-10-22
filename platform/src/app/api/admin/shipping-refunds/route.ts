import { z } from 'zod';
import { json, query, requirePrincipal, route } from '@/server/http';
import { listCashRefundsForAdmin } from '@/server/modules/shipping/shipping-refunds';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Status = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'PAID']).optional();

/** GET /api/admin/shipping-refunds?status= — 運費新台幣退款申請 */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json({ requests: await listCashRefundsForAdmin(p, Status.parse(query(req).get('status') ?? undefined)) });
});
