import { json, requirePrincipal, route } from '@/server/http';
import { getVipStatus } from '@/server/modules/vip/vip';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/me/vip — 我的 VIP 等級、累計花費、下一等級門檻與進度、權益、禮物紀錄與本月優惠券 */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json(await getVipStatus(p.userId));
});
