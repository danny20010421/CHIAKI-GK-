import { body, json, query, requirePrincipal, route } from '@/server/http';
import { CouponSchema, createCoupon, listCouponsAdmin } from '@/server/modules/marketing/marketing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/admin/coupons?includeDeleted=1 — 優惠券列表 */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json(await listCouponsAdmin(p, { includeDeleted: query(req).get('includeDeleted') === '1' }));
});

/** POST /api/admin/coupons — { code (A–Z0–9 4–16), kind: pct（1–90%）| amt（折抵 UC幣），value, minSpend?, issueLimit?, expiresAt?, enabled? } */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json(await createCoupon(p, await body(req, CouponSchema)), 201);
});
