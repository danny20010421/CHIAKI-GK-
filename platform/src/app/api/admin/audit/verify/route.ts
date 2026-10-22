import { db } from '@/server/db';
import { json, requirePrincipal, route } from '@/server/http';
import { requirePermission } from '@/server/modules/auth/rbac';
import { verifyAuditChain } from '@/server/modules/audit/audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/admin/audit/verify — 重算稽核雜湊鏈 */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  requirePermission(p, 'audit.read');
  return json(await verifyAuditChain(db()));
});
