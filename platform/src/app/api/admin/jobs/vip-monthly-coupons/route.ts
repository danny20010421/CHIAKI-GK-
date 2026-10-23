import { json, requirePrincipal, route } from '@/server/http';
import { requirePermission } from '@/server/modules/auth/rbac';
import { runVipMonthlyCoupons } from '@/server/modules/vip/vip';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/jobs/vip-monthly-coupons — 手動觸發：每月 VIP 優惠券（排程：每月 1 日 00:05 台灣時間；每人每月一次）；冪等 */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  requirePermission(p, 'jobs.run');
  return json(await runVipMonthlyCoupons());
});
