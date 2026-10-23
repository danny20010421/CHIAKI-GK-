import { json, requirePrincipal, route } from '@/server/http';
import { listTiersAdmin } from '@/server/modules/vip/vip';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/admin/vip/tiers — VIP 等級設定（含各等級會員數、即時機率解鎖等級） */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json(await listTiersAdmin(p));
});
