import { json, requirePrincipal, route } from '@/server/http';
import { requirePermission } from '@/server/modules/auth/rbac';
import { runStorageSweep } from '@/server/modules/warehouse/storage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/jobs/storage-sweep — 手動觸發寄存到期掃描（正式環境請以排程每小時執行 `npm run job:storage-sweep`；冪等） */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  requirePermission(p, 'jobs.run');
  return json(await runStorageSweep());
});
