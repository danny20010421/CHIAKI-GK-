import { json, requirePrincipal, route } from '@/server/http';
import { requirePermission } from '@/server/modules/auth/rbac';
import { dispatchOutbox } from '@/server/modules/notifications/outbox';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/jobs/notifications-dispatch — 派送外送通知佇列（建議每分鐘排程 `npm run job:notify`） */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  requirePermission(p, 'jobs.run');
  return json(await dispatchOutbox());
});
