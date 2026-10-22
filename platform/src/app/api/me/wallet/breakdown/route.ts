import { db } from '@/server/db';
import { json, requirePrincipal, route } from '@/server/http';
import { getCoinBreakdown } from '@/server/modules/wallet/wallet';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/me/wallet/breakdown — 代幣明細：可退款 vs 不可退款（含「不可退款・無法轉換，如有疑問請聯絡官方小編」標示） */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json(await getCoinBreakdown(db(), p.userId));
});
