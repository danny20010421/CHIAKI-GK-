import { body, json, query, requirePrincipal, route } from '@/server/http';
import { ClaimCouponSchema, claimCoupon, listMyCoupons } from '@/server/modules/marketing/coupons';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/me/coupons?usable_for=<poolId|slug>&qty=<n>&all=1 — 我的優惠券（預設只列未使用且未過期；all=1 含已使用/已過期）。
 * 帶 usable_for 時以「單價 × qty（預設 1）」為小計試算每張券：
 * { coupons: [{ id, source: 'VIP'|'CODE', code, kind: 'pct'|'amt', value, label, minSpend, status, validFrom, expiresAt, createdAt, usedAt, usedDrawId, usedDiscountCoins,
 *               usable, reason: null|'USED'|'EXPIRED'|'NOT_YET_VALID'|'DISABLED'|'MIN_SPEND', discountCoins, payCoins }],
 *   usableFor: { poolId, qty, unitPrice, subtotal }, best: <折抵最多的可用券 id>|null }
 */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const q = query(req);
  return json(
    await listMyCoupons(p.userId, {
      usableFor: q.get('usable_for') ?? q.get('usableFor') ?? undefined,
      qty: q.has('qty') ? Number(q.get('qty')) : undefined,
      all: q.get('all') === '1' || q.get('all') === 'true',
    }),
  );
});

/** POST /api/me/coupons — 以優惠碼領取 { code } → 201 + 優惠券；已領過 409 ALREADY_CLAIMED */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json(await claimCoupon(p.userId, await body(req, ClaimCouponSchema)), 201);
});
