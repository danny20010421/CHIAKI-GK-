import { json, requirePrincipal, route } from '@/server/http';
import { getReferralSummary } from '@/server/modules/referral/referral';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/me/referral — 我的邀請碼、有效邀請人數與獎勵狀態 */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json(await getReferralSummary(p.userId));
});
