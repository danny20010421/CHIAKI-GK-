import { json, requirePrincipal, route } from '@/server/http';
import { requirePermission } from '@/server/modules/auth/rbac';
import { runDrawArchive } from '@/server/modules/draw/history';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/jobs/draw-archive — 封存 90 天以前的抽賞紀錄（只標記，不刪除；冪等；建議每日排程 `npm run job:draw-archive`） */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  requirePermission(p, 'jobs.run');
  return json(await runDrawArchive());
});
