import { z } from 'zod';
import { AppError } from '../../errors';
import { config } from '../../config';
import { db, transaction, type Db, type Tx } from '../../db';
import { appendAudit } from '../audit/audit';
import { notifyEvent } from '../notifications/outbox';
import { resolvePublicPool } from '../pool/queries';
import { couponLabel } from '../vip/vip';

/**
 * 會員優惠券（抽賞結帳折抵）。
 *
 * 來源：
 *  - VIP：每月 VIP 優惠券（vip_coupons；pct 折扣、無最低消費、當月有效）。
 *  - CODE：會員以代碼領取的優惠券（user_coupons → coupons：pct / amt、最低消費、到期日、啟用；每人每券一張）。
 *    綁定任務贈送的券若代碼對應到優惠券定義，也會連結（coupon_id）而可使用。
 * 類型：pct（折扣 1–90%）：折抵 = floor(小計 × pct / 100)；amt（折抵 UC幣）：折抵 = min(面額, 小計)。實付 = 小計 − 折抵（≥ 0）。
 * 免運券（ship）已停用（運費到付）。
 *
 * 使用規則（executeDraw 交易內）：須為本人持有、未使用（ACTIVE）、在有效期間內、已啟用、小計達最低消費。
 * 以 FOR UPDATE 鎖定會員券列並在同一交易內標記 USED（含抽賞 id 與折抵金額）：並發重複使用時後到者讀到 USED → 失敗；
 * 抽賞失敗 rollback → 券仍為 ACTIVE。draws_coupon_once 唯一索引是第二道防線。
 */
export type CouponSource = 'VIP' | 'CODE';
export type CouponKind = 'pct' | 'amt';
export type CouponUnusableReason = 'USED' | 'EXPIRED' | 'NOT_YET_VALID' | 'DISABLED' | 'MIN_SPEND';

export interface MemberCoupon {
  id: string;
  source: CouponSource;
  code: string | null;
  kind: CouponKind;
  value: number;
  minSpend: number;
  label: string;
  status: 'ACTIVE' | 'USED' | 'EXPIRED';
  enabled: boolean;
  validFrom: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  usedAt: Date | null;
  usedDrawId: string | null;
  discountCoins: number | null;
}

interface CouponRow extends Omit<MemberCoupon, 'label'> {
  label: string | null;
}

export function memberCouponLabel(kind: string, value: number): string {
  return kind === 'pct' ? couponLabel(value) : `折抵 ${value} UC幣`;
}

export function couponDiscount(kind: CouponKind, value: number, subtotal: number): number {
  if (subtotal <= 0) return 0;
  const d = kind === 'pct' ? Math.floor((subtotal * value) / 100) : Math.min(value, subtotal);
  return Math.max(0, Math.min(d, subtotal));
}

export interface CouponEvaluation {
  usable: boolean;
  reason: CouponUnusableReason | null;
  discountCoins: number;
  payCoins: number;
}

/** 某張券套用在「小計 subtotal」時是否可用、折抵多少（不可用時折抵為 0） */
export function evaluateCoupon(c: Pick<MemberCoupon, 'status' | 'enabled' | 'validFrom' | 'expiresAt' | 'minSpend' | 'kind' | 'value'>, subtotal: number, now: Date = new Date()): CouponEvaluation {
  let reason: CouponUnusableReason | null = null;
  if (c.status === 'USED') reason = 'USED';
  else if (c.status === 'EXPIRED' || (c.expiresAt && c.expiresAt <= now)) reason = 'EXPIRED';
  else if (c.validFrom && c.validFrom > now) reason = 'NOT_YET_VALID';
  else if (!c.enabled) reason = 'DISABLED';
  else if (subtotal < c.minSpend) reason = 'MIN_SPEND';
  const discountCoins = reason ? 0 : couponDiscount(c.kind, c.value, subtotal);
  return { usable: reason === null, reason, discountCoins, payCoins: subtotal - discountCoins };
}

const REASON_MSG: Record<CouponUnusableReason, string> = {
  USED: '此優惠券已使用',
  EXPIRED: '此優惠券已過期',
  NOT_YET_VALID: '此優惠券尚未開始',
  DISABLED: '此優惠券已停用',
  MIN_SPEND: '未達優惠券最低消費',
};

const out = (r: CouponRow): MemberCoupon => ({ ...r, label: r.label ?? memberCouponLabel(r.kind, r.value) });

const VIP_SELECT = (d: Db | Tx) => d`
  'VIP' AS source, vc.id, NULL::text AS code, 'pct' AS kind, vc.discount_pct AS value, 0 AS min_spend, vc.label, vc.status, true AS enabled,
  vc.valid_from, vc.expires_at, vc.created_at, vc.used_at, vc.used_draw_id, vc.discount_coins`;
const CODE_SELECT = (d: Db | Tx) => d`
  'CODE' AS source, uc.id, c.code, c.kind, c.value, c.min_spend, NULL::text AS label, uc.status, (c.enabled AND c.deleted_at IS NULL) AS enabled,
  NULL::timestamptz AS valid_from, c.expires_at, uc.created_at, uc.used_at, uc.used_draw_id, uc.discount_coins`;

export async function loadMemberCoupons(d: Db, userId: string): Promise<MemberCoupon[]> {
  const rows = await d<CouponRow[]>`
    SELECT ${VIP_SELECT(d)} FROM vip_coupons vc WHERE vc.user_id = ${userId}
    UNION ALL
    SELECT ${CODE_SELECT(d)} FROM user_coupons uc JOIN coupons c ON c.id = uc.coupon_id WHERE uc.user_id = ${userId}`;
  return rows.map(out);
}

/** 抽賞交易內：鎖定本人的會員券（他人的券、不存在 → NOT_FOUND，不透露是否存在） */
export async function lockMemberCoupon(tx: Tx, userId: string, couponId: string): Promise<MemberCoupon> {
  const [v] = await tx<CouponRow[]>`SELECT ${VIP_SELECT(tx)} FROM vip_coupons vc WHERE vc.id = ${couponId} AND vc.user_id = ${userId} FOR UPDATE OF vc`;
  if (v) return out(v);
  const [c] = await tx<CouponRow[]>`
    SELECT ${CODE_SELECT(tx)} FROM user_coupons uc JOIN coupons c ON c.id = uc.coupon_id
    WHERE uc.id = ${couponId} AND uc.user_id = ${userId} FOR UPDATE OF uc`;
  if (c) return out(c);
  throw new AppError('NOT_FOUND', '找不到這張優惠券', { couponId });
}

/** 驗證可用並回傳折抵（不可用 → COUPON_NOT_USABLE，details.reason） */
export function assertCouponUsable(c: MemberCoupon, subtotal: number, now: Date = new Date()): CouponEvaluation {
  const ev = evaluateCoupon(c, subtotal, now);
  if (!ev.usable) throw new AppError('COUPON_NOT_USABLE', REASON_MSG[ev.reason!], { couponId: c.id, reason: ev.reason, minSpend: c.minSpend, subtotal });
  return ev;
}

/** 標記會員券已使用（同一交易內、draws 列已寫入之後） */
export async function markMemberCouponUsed(tx: Tx, c: MemberCoupon, drawId: string, discountCoins: number): Promise<void> {
  const rows =
    c.source === 'VIP'
      ? await tx`UPDATE vip_coupons SET status = 'USED', used_at = now(), used_draw_id = ${drawId}, discount_coins = ${discountCoins}
                 WHERE id = ${c.id} AND status = 'ACTIVE' RETURNING id`
      : await tx`UPDATE user_coupons SET status = 'USED', used_at = now(), used_draw_id = ${drawId}, discount_coins = ${discountCoins}
                 WHERE id = ${c.id} AND status = 'ACTIVE' RETURNING id`;
  if (!rows.length) throw new AppError('COUPON_NOT_USABLE', REASON_MSG.USED, { couponId: c.id, reason: 'USED' });
}

/** 代碼券的使用次數（共用的優惠券定義列；於交易後段、稽核前更新以縮短鎖定時間） */
export async function bumpCouponUsage(tx: Tx, c: MemberCoupon): Promise<void> {
  if (c.source !== 'CODE') return;
  await tx`UPDATE coupons SET used_count = used_count + 1, updated_at = now()
           WHERE id = (SELECT coupon_id FROM user_coupons WHERE id = ${c.id})`;
}

// ───────────── 會員 API ─────────────

export const MyCouponsQuerySchema = z.object({
  usableFor: z.string().min(1).max(100).optional(),
  qty: z.coerce.number().int().positive().optional(),
  all: z.boolean().optional(),
});

const showCoupon = (c: MemberCoupon) => ({
  id: c.id,
  source: c.source,
  code: c.code,
  kind: c.kind,
  value: c.value,
  label: c.label,
  minSpend: c.minSpend,
  status: c.status,
  validFrom: c.validFrom,
  expiresAt: c.expiresAt,
  createdAt: c.createdAt,
  usedAt: c.usedAt,
  usedDrawId: c.usedDrawId,
  usedDiscountCoins: c.discountCoins,
});

/**
 * GET /api/me/coupons：會員優惠券。預設只列「未使用且未過期」的券；all=1 另含已使用 / 已過期。
 * usable_for=<poolId|slug>&qty=<n>：以「單價 × n」為小計試算每張券是否可用與折抵金額，並回傳折抵最多的券（best）。
 */
export async function listMyCoupons(userId: string, q: z.input<typeof MyCouponsQuerySchema>, now: Date = new Date()) {
  const v = MyCouponsQuerySchema.parse(q);
  const d = db();
  let ctx: { poolId: string; qty: number; unitPrice: number; subtotal: number } | null = null;
  if (v.usableFor) {
    const qty = v.qty ?? 1;
    if (qty > config().MAX_TICKETS_PER_DRAW) throw new AppError('VALIDATION', `max ${config().MAX_TICKETS_PER_DRAW} tickets per draw`);
    const { id } = await resolvePublicPool(d, v.usableFor);
    const [p] = await d<{ priceCoins: number }[]>`SELECT price_coins FROM pools WHERE id = ${id}`;
    ctx = { poolId: id, qty, unitPrice: p!.priceCoins, subtotal: p!.priceCoins * qty };
  }
  const all = await loadMemberCoupons(d, userId);
  const live = (c: MemberCoupon) => c.status === 'ACTIVE' && !(c.expiresAt && c.expiresAt <= now);
  const list = all
    .filter((c) => v.all || live(c))
    .sort((a, b) => Number(live(b)) - Number(live(a)) || (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity) || a.createdAt.getTime() - b.createdAt.getTime());
  const coupons = list.map((c) => {
    const base = showCoupon(c);
    if (!ctx) return { ...base, usable: live(c) && c.enabled && !(c.validFrom && c.validFrom > now) };
    const ev = evaluateCoupon(c, ctx.subtotal, now);
    return { ...base, usable: ev.usable, reason: ev.reason, discountCoins: ev.discountCoins, payCoins: ev.payCoins };
  });
  let best: string | null = null;
  if (ctx) {
    let max = 0;
    for (const c of coupons as { id: string; usable: boolean; discountCoins: number }[]) {
      if (c.usable && c.discountCoins > max) {
        max = c.discountCoins;
        best = c.id;
      }
    }
  }
  return { coupons, ...(ctx ? { usableFor: ctx, best } : {}) };
}

export const ClaimCouponSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{4,16}$/, '優惠碼須為 4–16 碼英文大寫或數字'),
});

/** 會員以代碼領取優惠券（每人每券一張；受發放上限、啟用、到期限制）；發放後寄送站內通知 */
export async function claimCoupon(userId: string, input: z.input<typeof ClaimCouponSchema>, now: Date = new Date()) {
  const { code } = ClaimCouponSchema.parse(input);
  return transaction(async (tx) => {
    const [c] = await tx<{ id: string; merchantId: string; kind: CouponKind; value: number; minSpend: number; issueLimit: number | null; issuedCount: number; expiresAt: Date | null; enabled: boolean }[]>`
      SELECT id, merchant_id, kind, value, min_spend, issue_limit, issued_count, expires_at, enabled FROM coupons
      WHERE code = ${code} AND deleted_at IS NULL FOR UPDATE`;
    if (!c || !c.enabled || c.kind === ('ship' as CouponKind)) throw new AppError('NOT_FOUND', '優惠碼無效');
    if (c.expiresAt && c.expiresAt <= now) throw new AppError('COUPON_NOT_USABLE', REASON_MSG.EXPIRED, { reason: 'EXPIRED' });
    if (c.issueLimit !== null && c.issuedCount >= c.issueLimit) throw new AppError('COUPON_NOT_USABLE', '此優惠碼已發放完畢', { reason: 'ISSUE_LIMIT' });
    const [uc] = await tx<{ id: string }[]>`
      INSERT INTO user_coupons (merchant_id, user_id, code, source, coupon_id) VALUES (${c.merchantId}, ${userId}, ${code}, 'code', ${c.id})
      ON CONFLICT (user_id, coupon_id) WHERE coupon_id IS NOT NULL DO NOTHING RETURNING id`;
    if (!uc) throw new AppError('ALREADY_CLAIMED', '已領取過此優惠碼');
    await tx`UPDATE coupons SET issued_count = issued_count + 1, updated_at = now() WHERE id = ${c.id}`;
    const label = memberCouponLabel(c.kind, c.value);
    await notifyCouponsIssued(tx, { userId, merchantId: c.merchantId, labels: [label], expiresAt: c.expiresAt, dedupeOn: { userCouponId: uc.id } });
    await appendAudit(tx, { actorType: 'USER', actorId: userId, action: 'COUPON_CLAIMED', entityType: 'user_coupon', entityId: uc.id, merchantId: c.merchantId, payload: { couponId: c.id, code } });
    const [row] = await tx<CouponRow[]>`SELECT ${CODE_SELECT(tx)} FROM user_coupons uc JOIN coupons c ON c.id = uc.coupon_id WHERE uc.id = ${uc.id}`;
    return showCoupon(out(row!));
  });
}

/** 優惠券發放通知（站內＋依偏好的外部管道；dedupeOn 讓重跑排程不重複通知） */
export async function notifyCouponsIssued(tx: Tx, a: { userId: string; merchantId?: string; labels: string[]; expiresAt: Date | null; dedupeOn: unknown }) {
  const counts = new Map<string, number>();
  for (const l of a.labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  const summary = [...counts].map(([l, n]) => (n > 1 ? `${l} ×${n}` : l)).join('、');
  await notifyEvent(tx, {
    userId: a.userId,
    merchantId: a.merchantId,
    event: 'COUPON_ISSUED',
    data: { count: a.labels.length, summary, expiresAt: a.expiresAt },
    payload: { count: a.labels.length },
    dedupeOn: a.dedupeOn,
  });
}
