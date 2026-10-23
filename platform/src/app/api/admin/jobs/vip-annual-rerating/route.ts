import { json, requirePrincipal, route } from '@/server/http';
import { requirePermission } from '@/server/modules/auth/rbac';
import { runVipAnnualRerating } from '@/server/modules/vip/vip';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/jobs/vip-annual-rerating — 手動觸發：VIP 年度重新評等（排程：1/1 00:05 台灣時間；每人每年一次、每年最多降一級）；冪等 */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  requirePermission(p, 'jobs.run');
  return json(await runVipAnnualRerating());
});
