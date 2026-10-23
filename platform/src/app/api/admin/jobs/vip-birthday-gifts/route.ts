import { json, requirePrincipal, route } from '@/server/http';
import { requirePermission } from '@/server/modules/auth/rbac';
import { runVipBirthdayGifts } from '@/server/modules/vip/vip';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/jobs/vip-birthday-gifts — 手動觸發：VIP 生日禮（排程：每日；生日當月每人每年一次）；冪等 */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  requirePermission(p, 'jobs.run');
  return json(await runVipBirthdayGifts());
});
