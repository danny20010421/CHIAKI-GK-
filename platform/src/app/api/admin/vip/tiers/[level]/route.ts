import { z } from 'zod';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { TierUpdateSchema, updateTier } from '@/server/modules/vip/vip';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PATCH /api/admin/vip/tiers/:level — 修改等級設定（寫入稽核）：
 * { name?, spendThreshold?, upgradeGiftCoins?, birthdayGiftCoins?, monthlyCoupons?: [{ discountPct, qty }], extraStorageDays?, perks?: [{ code, label }] }
 * 門檻須隨等級嚴格遞增；VIP0 門檻固定 0；權益代碼 LIVE_ODDS 決定即時機率的解鎖等級。
 */
export const PATCH = route(async (req: Request, ctx: RouteContext<{ level: string }>) => {
  const p = await requirePrincipal(req);
  const { level } = await ctx.params;
  return json(await updateTier(p, z.coerce.number().int().min(0).max(20).parse(level), await body(req, TierUpdateSchema)));
});
