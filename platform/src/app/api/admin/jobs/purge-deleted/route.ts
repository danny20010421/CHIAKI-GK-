import { json, requirePrincipal, route } from '@/server/http';
import { requirePermission } from '@/server/modules/auth/rbac';
import { purgeDeleted } from '@/server/modules/pool/manage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/jobs/purge-deleted — 硬刪除超過 30 天的軟刪除賞池/套（正式環境請每日排程 `npm run job:purge-deleted`；冪等） */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  requirePermission(p, 'jobs.run');
  return json(await purgeDeleted());
});
