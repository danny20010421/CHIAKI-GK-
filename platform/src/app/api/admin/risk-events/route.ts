import { db } from '@/server/db';
import { json, requirePrincipal, route } from '@/server/http';
import { requirePermission } from '@/server/modules/auth/rbac';
import { listRiskEvents } from '@/server/modules/risk/risk';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  requirePermission(p, 'risk.read');
  return json({ events: await listRiskEvents(db()) });
});
