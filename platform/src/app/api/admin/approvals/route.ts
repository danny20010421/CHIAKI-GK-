import { z } from 'zod';
import { json, query, requirePrincipal, route } from '@/server/http';
import { listApprovals } from '@/server/modules/admin/approvals';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Status = z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional();

/** GET /api/admin/approvals?status=PENDING — 覆核清單 */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json({ approvals: await listApprovals(p, Status.parse(query(req).get('status') ?? undefined)) });
});
