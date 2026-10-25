import { z } from 'zod';
import { AppError } from '../../errors';
import { canonicalJson } from '../../lib/canonical';
import { taipeiDate, taipeiMidnight, taipeiMonth } from '../../lib/taipei';
import { db, transaction, type Db, type Tx } from '../../db';
import { appendAudit, type AuditEntry } from '../audit/audit';
import { requirePermission, type Principal } from '../auth/rbac';
import { ensureWallet, NONREFUNDABLE_LABEL, postLedger } from '../wallet/wallet';
import { notifyEvent } from '../notifications/outbox';
import { notifyCouponsIssued } from '../marketing/coupons';

/**
 * VIP 會員等級（業主 2026-10 第八批）。
 *
 *  - 等級依「抽賞累計花費 UC幣」決定（可退款與不可退款扣款皆計入；抽賞退款會扣回花費，但年度中不降級）。
 *    門檻、名稱、禮物、優惠券、加碼寄存天數、權益存於 vip_tiers，後台可改（留稽核）。
 *  - 升級禮：每個等級一生只發一次（vip_gift_grants UNIQUE (user, UPGRADE, L<等級>)）；跳級時逐級發放；
 *    於「跨過門檻的那筆抽賞結算時」在同一交易內入帳（不可退款 UC幣，帳本 VIP_UPGRADE_GIFT）。
 *  - 生日禮：生日當月（台灣時間）每年一次，依當時等級（帳本 VIP_BIRTHDAY_GIFT，不可退款）。排程工作 runVipBirthdayGifts。
 *  - 每月優惠券：每月 1 日（台灣時間）依當時等級發放，每人每月一次（runVipMonthlyCoupons）；當月有效。
 *  - 年度重新評等：1/1（台灣時間）依前 12 個月（上一個日曆年）花費重新評等，每年最多降一級（runVipAnnualRerating）。
 *    評等後「升級用累計花費」重設為 max(前 12 個月花費, 新等級門檻) ＋ 評等期間之後的花費，避免降級後立即以舊累計升回。
 *  - 加碼寄存天數：在該等級期間「入庫」的獎品，免費寄存期間 + extra_storage_days。
 *  - 權益（perks）：每個等級列出「新增」的權益，較高等級自動包含較低等級的權益；
 *    LIVE_ODDS（賞池頁即時機率顯示）由程式強制（見 pool/queries.ts），其餘目前為顯示用標示。
 *
 *  - 會員通知：升級禮、生日禮入帳與每月優惠券發放時，在同一交易內登記通知（站內＋依會員偏好的外部管道，outbox）；
 *    通知以禮物/發放紀錄為冪等依據（UPGRADE 等級、BIRTHDAY 年份、MONTHLY_COUPONS 月份），重跑排程不會重複通知。
 *
 * 鎖順序：錢包 → vip_members → vip_gift_grants → 稽核（audit_head 最後）。
 */

export const ODDS_PERK = 'LIVE_ODDS';
export const VIP_GIFT_NOTE = `VIP 禮物 UC幣${NONREFUNDABLE_LABEL}`;

export const CouponSpecSchema = z.object({
  /** 折扣百分比：5 = 95折、10 = 9折、15 = 85折 */
  discountPct: z.number().int().min(1).max(90),
  qty: z.number().int().min(1).max(10),
});
export const PerkSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/, '權益代碼須為英文大寫、數字與底線'),
  label: z.string().trim().min(1).max(50),
});
export type CouponSpec = z.infer<typeof CouponSpecSchema>;
export type Perk = z.infer<typeof PerkSchema>;

export interface VipTier {
  level: number;
  name: string;
  spendThreshold: number;
  upgradeGiftCoins: number;
  birthdayGiftCoins: number;
  monthlyCoupons: CouponSpec[];
  extraStorageDays: number;
  perks: Perk[];
}

/** 95折券、9折券、85折券 */
export function couponLabel(discountPct: number): string {
  const r = 100 - discountPct;
  return r % 10 === 0 ? `${r / 10}折券` : `${r}折券`;
}

const couponsOut = (c: CouponSpec[]) => c.map((x) => ({ ...x, label: couponLabel(x.discountPct) }));

interface TierRow {
  level: number;
  name: string;
  spendThreshold: number;
  upgradeGiftCoins: number;
  birthdayGiftCoins: number;
  monthlyCouponsJson: string;
  extraStorageDays: number;
  perksJson: string;
  updatedAt?: Date;
}
const tierOf = (r: TierRow): VipTier => ({
  level: r.level,
  name: r.name,
  spendThreshold: r.spendThreshold,
  upgradeGiftCoins: r.upgradeGiftCoins,
  birthdayGiftCoins: r.birthdayGiftCoins,
  monthlyCoupons: JSON.parse(r.monthlyCouponsJson) as CouponSpec[],
  extraStorageDays: r.extraStorageDays,
  perks: JSON.parse(r.perksJson) as Perk[],
});

export async function loadTiers(d: Db, opts: { lock?: boolean } = {}): Promise<VipTier[]> {
  const rows = await d<TierRow[]>`
    SELECT level, name, spend_threshold, upgrade_gift_coins, birthday_gift_coins, monthly_coupons_json, extra_storage_days, perks_json
    FROM vip_tiers ORDER BY level ${opts.lock ? d`FOR UPDATE` : d``}`;
  if (!rows.length || rows[0]!.level !== 0) throw new Error('vip_tiers must define level 0');
  return rows.map(tierOf);
}

/** 依累計花費對應的等級（門檻 ≤ 花費 的最高等級） */
export function tierForSpend(tiers: VipTier[], spend: number): VipTier {
  let t = tiers[0]!;
  for (const x of tiers) if (x.spendThreshold <= spend && x.level > t.level) t = x;
  return t;
}

export function tierAt(tiers: VipTier[], level: number): VipTier {
  return tiers.filter((t) => t.level <= level).at(-1) ?? tiers[0]!;
}

/** 某等級享有的全部權益（含較低等級的權益） */
export function cumulativePerks(tiers: VipTier[], level: number): (Perk & { fromLevel: number })[] {
  return tiers.filter((t) => t.level <= level).flatMap((t) => t.perks.map((p) => ({ ...p, fromLevel: t.level })));
}

/** 解鎖「即時機率顯示」的最低等級（未設定任何等級 → null：所有會員皆不顯示） */
export function oddsUnlockLevel(tiers: VipTier[]): number | null {
  return tiers.find((t) => t.perks.some((p) => p.code === ODDS_PERK))?.level ?? null;
}

export async function vipLevelOf(d: Db, userId: string): Promise<number> {
  const [m] = await d<{ level: number }[]>`SELECT level FROM vip_members WHERE user_id = ${userId}`;
  return m?.level ?? 0;
}

/** 會員（或訪客）是否可看賞池即時機率 */
export async function oddsAccess(d: Db, viewerId: string | null | undefined): Promise<{ oddsLocked: boolean; oddsUnlockLevel: number | null; vipLevel: number | null }> {
  const unlock = oddsUnlockLevel(await loadTiers(d));
  const vipLevel = viewerId ? await vipLevelOf(d, viewerId) : null;
  return { oddsLocked: unlock === null || vipLevel === null || vipLevel < unlock, oddsUnlockLevel: unlock, vipLevel };
}

/** 目前等級的加碼寄存天數（呼叫端：入庫當下） */
export async function vipExtraStorageDays(d: Db, userId: string): Promise<number> {
  const tiers = await loadTiers(d);
  return tierAt(tiers, await vipLevelOf(d, userId)).extraStorageDays;
}

async function lockMember(tx: Tx, userId: string) {
  await tx`INSERT INTO vip_members (user_id) VALUES (${userId}) ON CONFLICT DO NOTHING`;
  const [m] = await tx<{ level: number; qualifyingSpend: number; lifetimeSpend: number }[]>`
    SELECT level, qualifying_spend, lifetime_spend FROM vip_members WHERE user_id = ${userId} FOR UPDATE`;
  return m!;
}

export interface UpgradeGift {
  level: number;
  name: string;
  coins: number;
}

/**
 * 發放尚未領取的升級禮（等級 1..level；一生一次）。呼叫端須已鎖定錢包（及 vip_members）。
 * 回傳待寫入的稽核紀錄（由呼叫端最後寫入，維持鎖順序）。
 */
async function grantUpgradeGifts(tx: Tx, userId: string, tiers: VipTier[], level: number, merchantId: string, source: string): Promise<{ gifts: UpgradeGift[]; audits: AuditEntry[] }> {
  const done = new Set((await tx<{ level: number }[]>`SELECT level FROM vip_gift_grants WHERE user_id = ${userId} AND kind = 'UPGRADE'`).map((r) => r.level));
  const gifts: UpgradeGift[] = [];
  const audits: AuditEntry[] = [];
  for (const t of tiers) {
    if (t.level < 1 || t.level > level || done.has(t.level)) continue;
    let ledgerId: number | null = null;
    if (t.upgradeGiftCoins > 0) {
      ledgerId = (
        await postLedger(tx, {
          userId,
          amount: t.upgradeGiftCoins,
          entryType: 'VIP_UPGRADE_GIFT',
          refType: 'vip_gift',
          refId: `${userId}:L${t.level}`,
          merchantId,
          memo: `VIP${t.level} ${t.name} 升級禮（不可退款）`,
        })
      ).ledgerId;
    }
    await tx`INSERT INTO vip_gift_grants (user_id, kind, period, level, coins, ledger_id)
             VALUES (${userId}, 'UPGRADE', ${`L${t.level}`}, ${t.level}, ${t.upgradeGiftCoins}, ${ledgerId})`;
    if (t.upgradeGiftCoins > 0) {
      await notifyEvent(tx, {
        userId,
        merchantId,
        event: 'VIP_UPGRADE_GIFT',
        data: { level: t.level, name: t.name, coins: t.upgradeGiftCoins },
        payload: { level: t.level, coins: t.upgradeGiftCoins },
        dedupeOn: { kind: 'UPGRADE', level: t.level },
      });
    }
    gifts.push({ level: t.level, name: t.name, coins: t.upgradeGiftCoins });
    audits.push({ actorType: 'SYSTEM', actorId: 'vip', action: 'VIP_UPGRADE_GIFT', entityType: 'user', entityId: userId, merchantId, payload: { level: t.level, coins: t.upgradeGiftCoins, ledgerId, source, refundable: false } });
  }
  return { gifts, audits };
}

export interface DrawSpendResult {
  previousLevel: number;
  level: number;
  levelName: string;
  upgraded: boolean;
  spend: number;
  gifts: UpgradeGift[];
  /** 本次入庫獎品的加碼寄存天數（結算後的等級） */
  extraStorageDays: number;
  audits: AuditEntry[];
}

/**
 * 抽賞結算（executeDraw 交易內、錢包已鎖定之後呼叫）：記錄花費、升級、發放升級禮（冪等：每筆抽賞一次、每個等級一次）。
 */
export async function applyDrawSpend(tx: Tx, a: { userId: string; drawId: string; amount: number; merchantId: string }): Promise<DrawSpendResult> {
  const tiers = await loadTiers(tx);
  const m = await lockMember(tx, a.userId);
  // 實付 0（優惠券全額折抵）不計花費
  const ins =
    a.amount > 0
      ? await tx`
          INSERT INTO vip_spend_events (user_id, draw_id, kind, ref_id, amount) VALUES (${a.userId}, ${a.drawId}, 'DRAW', ${a.drawId}, ${a.amount})
          ON CONFLICT DO NOTHING RETURNING id`
      : [];
  const spend = ins.length ? m.qualifyingSpend + a.amount : m.qualifyingSpend;
  const level = Math.max(m.level, tierForSpend(tiers, spend).level);
  await tx`
    UPDATE vip_members SET qualifying_spend = ${spend}, lifetime_spend = lifetime_spend + ${ins.length ? a.amount : 0}, level = ${level},
           level_since = ${level !== m.level ? tx`now()` : tx`level_since`}, updated_at = now()
    WHERE user_id = ${a.userId}`;
  const { gifts, audits } = await grantUpgradeGifts(tx, a.userId, tiers, level, a.merchantId, `draw:${a.drawId}`);
  if (level !== m.level) {
    audits.unshift({ actorType: 'SYSTEM', actorId: 'vip', action: 'VIP_LEVEL_CHANGED', entityType: 'user', entityId: a.userId, merchantId: a.merchantId, payload: { from: m.level, to: level, spend, reason: 'DRAW', drawId: a.drawId } });
  }
  const t = tierAt(tiers, level);
  return { previousLevel: m.level, level, levelName: t.name, upgraded: level > m.level, spend, gifts, extraStorageDays: t.extraStorageDays, audits };
}

/**
 * 抽賞退款（目前平台沒有抽賞退款流程；供日後的退款流程在其交易內呼叫）：扣回花費（不低於 0），年度中不降級。
 * 冪等：同一 refundId 只扣一次。
 */
export async function recordDrawRefund(tx: Tx, a: { userId: string; drawId: string; refundId: string; amount: number }): Promise<{ spend: number; applied: boolean }> {
  if (!Number.isSafeInteger(a.amount) || a.amount <= 0) throw new AppError('VALIDATION', 'refund amount must be a positive integer');
  const m = await lockMember(tx, a.userId);
  const ins = await tx`
    INSERT INTO vip_spend_events (user_id, draw_id, kind, ref_id, amount) VALUES (${a.userId}, ${a.drawId}, 'DRAW_REFUND', ${a.refundId}, ${-a.amount})
    ON CONFLICT DO NOTHING RETURNING id`;
  if (!ins.length) return { spend: m.qualifyingSpend, applied: false };
  const spend = Math.max(0, m.qualifyingSpend - a.amount);
  await tx`UPDATE vip_members SET qualifying_spend = ${spend}, lifetime_spend = GREATEST(lifetime_spend - ${a.amount}, 0), updated_at = now() WHERE user_id = ${a.userId}`;
  return { spend, applied: true };
}

// ───────────── 會員：GET /api/me/vip ─────────────

const tierOut = (tiers: VipTier[], t: VipTier) => ({
  level: t.level,
  name: t.name,
  spendThreshold: t.spendThreshold,
  upgradeGiftCoins: t.upgradeGiftCoins,
  birthdayGiftCoins: t.birthdayGiftCoins,
  monthlyCoupons: couponsOut(t.monthlyCoupons),
  extraStorageDays: t.extraStorageDays,
  /** 本等級新增的權益 */
  perks: t.perks,
  /** 本等級享有的全部權益（含較低等級） */
  allPerks: cumulativePerks(tiers, t.level),
});

export async function getVipStatus(userId: string, now: Date = new Date()) {
  const d = db();
  const tiers = await loadTiers(d);
  const [m] = await d<{ level: number; qualifyingSpend: number; lifetimeSpend: number; levelSince: Date }[]>`
    SELECT level, qualifying_spend, lifetime_spend, level_since FROM vip_members WHERE user_id = ${userId}`;
  const level = m?.level ?? 0;
  const spend = m?.qualifyingSpend ?? 0;
  const cur = tierAt(tiers, level);
  const next = tiers.find((t) => t.level > level) ?? null;
  const span = next ? next.spendThreshold - cur.spendThreshold : 0;
  const progress = next ? Math.min(1, Math.max(0, span > 0 ? (spend - cur.spendThreshold) / span : 1)) : 1;
  const unlock = oddsUnlockLevel(tiers);
  const gifts = await d<{ kind: string; period: string; level: number; coins: number; couponsJson: string; createdAt: Date }[]>`
    SELECT kind, period, level, coins, coupons_json, created_at FROM vip_gift_grants WHERE user_id = ${userId} ORDER BY created_at DESC, kind, period LIMIT 100`;
  const coupons = await d<{ id: string; label: string; discountPct: number; status: string; validFrom: Date; expiresAt: Date }[]>`
    SELECT id, label, discount_pct, status, valid_from, expires_at FROM vip_coupons
    WHERE user_id = ${userId} AND status = 'ACTIVE' AND expires_at > ${now} ORDER BY expires_at, discount_pct DESC`;
  return {
    level,
    name: cur.name,
    /** 升級用累計花費（抽賞 UC幣，含可退款與不可退款；年度評等後重設） */
    spend,
    /** 歷來抽賞淨花費 */
    lifetimeSpend: m?.lifetimeSpend ?? 0,
    levelSince: m?.levelSince ?? null,
    nextLevel: next ? { level: next.level, name: next.name, spendThreshold: next.spendThreshold, remaining: Math.max(0, next.spendThreshold - spend) } : null,
    nextThreshold: next?.spendThreshold ?? null,
    /** 0–1：目前等級門檻 → 下一等級門檻 的進度（最高等級為 1） */
    progress: Math.round(progress * 10_000) / 10_000,
    perks: cumulativePerks(tiers, level),
    benefits: {
      birthdayGiftCoins: cur.birthdayGiftCoins,
      monthlyCoupons: couponsOut(cur.monthlyCoupons),
      extraStorageDays: cur.extraStorageDays,
      oddsVisible: unlock !== null && level >= unlock,
    },
    oddsUnlockLevel: unlock,
    tiers: tiers.map((t) => tierOut(tiers, t)),
    gifts: gifts.map((g) => ({ kind: g.kind, period: g.period, level: g.level, coins: g.coins, coupons: couponsOut(JSON.parse(g.couponsJson) as CouponSpec[]), refundable: false, createdAt: g.createdAt })),
    coupons,
    rules: [
      '等級依抽賞累計花費（UC幣，可退款與不可退款皆計）自動升級；抽賞退款會扣回花費',
      '升級禮每個等級限領一次，跳級時逐級發放；生日禮於生日當月發放（每年一次）；優惠券於每月 1 日依當時等級發放，當月有效',
      '每年 1 月 1 日依前 12 個月花費重新評等，每年最多降一級',
      VIP_GIFT_NOTE,
    ],
  };
}

// ───────────── 後台：等級設定 ─────────────

export const TierUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(20).optional(),
    spendThreshold: z.number().int().min(0).max(1_000_000_000).optional(),
    upgradeGiftCoins: z.number().int().min(0).max(1_000_000).optional(),
    birthdayGiftCoins: z.number().int().min(0).max(1_000_000).optional(),
    monthlyCoupons: z.array(CouponSpecSchema).max(5).optional(),
    extraStorageDays: z.number().int().min(0).max(365).optional(),
    perks: z
      .array(PerkSchema)
      .max(10)
      .refine((a) => new Set(a.map((p) => p.code)).size === a.length, '權益代碼不可重複')
      .optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'nothing to update');

export async function listTiersAdmin(actor: Principal) {
  requirePermission(actor, 'vip.manage');
  const d = db();
  const rows = await d<(TierRow & { updatedBy: string | null; updatedAt: Date })[]>`
    SELECT level, name, spend_threshold, upgrade_gift_coins, birthday_gift_coins, monthly_coupons_json, extra_storage_days, perks_json, updated_by, updated_at
    FROM vip_tiers ORDER BY level`;
  const tiers = rows.map(tierOf);
  const counts = await d<{ level: number; n: number }[]>`SELECT level, count(*)::int AS n FROM vip_members GROUP BY level`;
  return {
    tiers: rows.map((r, i) => ({ ...tierOut(tiers, tiers[i]!), members: counts.find((c) => c.level === r.level)?.n ?? 0, updatedBy: r.updatedBy, updatedAt: r.updatedAt })),
    oddsUnlockLevel: oddsUnlockLevel(tiers),
  };
}

/** 修改單一等級（門檻須隨等級嚴格遞增、VIP0 門檻固定為 0）；寫入稽核（before/after）。已發放的禮物不追溯。 */
export async function updateTier(actor: Principal, level: number, input: z.input<typeof TierUpdateSchema>) {
  requirePermission(actor, 'vip.manage');
  const v = TierUpdateSchema.parse(input);
  return transaction(async (tx) => {
    const tiers = await loadTiers(tx, { lock: true });
    const cur = tiers.find((t) => t.level === level);
    if (!cur) throw new AppError('NOT_FOUND', 'VIP level not found');
    const next: VipTier = {
      ...cur,
      ...(v.name !== undefined ? { name: v.name } : {}),
      ...(v.spendThreshold !== undefined ? { spendThreshold: v.spendThreshold } : {}),
      ...(v.upgradeGiftCoins !== undefined ? { upgradeGiftCoins: v.upgradeGiftCoins } : {}),
      ...(v.birthdayGiftCoins !== undefined ? { birthdayGiftCoins: v.birthdayGiftCoins } : {}),
      ...(v.monthlyCoupons !== undefined ? { monthlyCoupons: v.monthlyCoupons } : {}),
      ...(v.extraStorageDays !== undefined ? { extraStorageDays: v.extraStorageDays } : {}),
      ...(v.perks !== undefined ? { perks: v.perks } : {}),
    };
    if (level === 0 && next.spendThreshold !== 0) throw new AppError('VALIDATION', 'VIP0 門檻固定為 0');
    const all = tiers.map((t) => (t.level === level ? next : t));
    for (let i = 1; i < all.length; i++) {
      if (all[i]!.spendThreshold <= all[i - 1]!.spendThreshold) throw new AppError('VALIDATION', '各等級門檻須隨等級嚴格遞增', { level: all[i]!.level });
    }
    const codes = all.flatMap((t) => t.perks.map((p) => p.code));
    if (new Set(codes).size !== codes.length) throw new AppError('VALIDATION', '同一權益代碼只能出現在一個等級（較高等級自動包含）');
    await tx`
      UPDATE vip_tiers SET name = ${next.name}, spend_threshold = ${next.spendThreshold}, upgrade_gift_coins = ${next.upgradeGiftCoins},
             birthday_gift_coins = ${next.birthdayGiftCoins}, monthly_coupons_json = ${canonicalJson(next.monthlyCoupons)},
             extra_storage_days = ${next.extraStorageDays}, perks_json = ${canonicalJson(next.perks)}, updated_by = ${actor.userId}, updated_at = now()
      WHERE level = ${level}`;
    const changed = (Object.keys(v) as (keyof typeof v)[]).filter((k) => v[k] !== undefined);
    const pick = (t: VipTier) => Object.fromEntries(changed.map((k) => [k, t[k as keyof VipTier]]));
    await appendAudit(tx, { actorType: 'ADMIN', actorId: actor.userId, action: 'VIP_TIER_UPDATED', entityType: 'vip_tier', entityId: String(level), payload: { level, changed, before: pick(cur), after: pick(next) } });
    return tierOut(all, next);
  });
}

// ───────────── 排程工作 ─────────────

async function lockWallet(tx: Tx, userId: string) {
  await ensureWallet(tx, userId);
  await tx`SELECT 1 FROM wallets WHERE user_id = ${userId} FOR UPDATE`;
}

/**
 * 每月優惠券（排程：每月 1 日 00:05 台灣時間；可重複執行，每人每月一次）。
 * 發給 `now` 所在月份（台灣時間）時、等級設有每月優惠券的會員；有效至下月 1 日 00:00。
 */
export async function runVipMonthlyCoupons(now: Date = new Date()): Promise<{ month: string; members: number; coupons: number }> {
  const month = taipeiMonth(now);
  const t = taipeiDate(now);
  const validFrom = taipeiMidnight(t.year, t.month, 1);
  const expiresAt = taipeiMidnight(t.year, t.month + 1, 1);
  const tiers = await loadTiers(db());
  const eligible = tiers.filter((x) => x.monthlyCoupons.length).map((x) => x.level);
  const out = { month, members: 0, coupons: 0 };
  if (!eligible.length) return out;
  const users = await db()<{ userId: string }[]>`
    SELECT m.user_id FROM vip_members m JOIN users u ON u.id = m.user_id
    WHERE m.level >= 1 AND u.status = 'ACTIVE'
      AND NOT EXISTS (SELECT 1 FROM vip_gift_grants g WHERE g.user_id = m.user_id AND g.kind = 'MONTHLY_COUPONS' AND g.period = ${month})
    ORDER BY m.user_id`;
  for (const { userId } of users) {
    const n = await transaction(async (tx) => {
      const [m] = await tx<{ level: number }[]>`SELECT level FROM vip_members WHERE user_id = ${userId} FOR UPDATE`;
      const tier = tierAt(tiers, m!.level);
      if (!tier.monthlyCoupons.length) return 0;
      const [g] = await tx<{ id: string }[]>`
        INSERT INTO vip_gift_grants (user_id, kind, period, level, coupons_json) VALUES (${userId}, 'MONTHLY_COUPONS', ${month}, ${tier.level}, ${canonicalJson(tier.monthlyCoupons)})
        ON CONFLICT DO NOTHING RETURNING id`;
      if (!g) return 0;
      let count = 0;
      const labels: string[] = [];
      for (const c of tier.monthlyCoupons) {
        for (let i = 0; i < c.qty; i++) {
          await tx`INSERT INTO vip_coupons (user_id, grant_id, discount_pct, label, valid_from, expires_at)
                   VALUES (${userId}, ${g.id}, ${c.discountPct}, ${couponLabel(c.discountPct)}, ${validFrom}, ${expiresAt})`;
          labels.push(couponLabel(c.discountPct));
          count++;
        }
      }
      await notifyCouponsIssued(tx, { userId, labels, expiresAt, dedupeOn: { kind: 'MONTHLY_COUPONS', month } });
      await appendAudit(tx, { actorType: 'SYSTEM', actorId: 'vip-monthly-coupons', action: 'VIP_MONTHLY_COUPONS', entityType: 'user', entityId: userId, payload: { month, level: tier.level, coupons: couponsOut(tier.monthlyCoupons) } });
      return count;
    });
    if (n) {
      out.members++;
      out.coupons += n;
    }
  }
  return out;
}

/**
 * 生日禮（排程：每日；可重複執行，每人每年一次）：生日月份（台灣時間）＝本月、等級設有生日禮的會員。
 */
export async function runVipBirthdayGifts(now: Date = new Date()): Promise<{ year: number; month: number; granted: number; coins: number }> {
  const { year, month } = taipeiDate(now);
  const period = String(year);
  const tiers = await loadTiers(db());
  const out = { year, month, granted: 0, coins: 0 };
  const users = await db()<{ userId: string }[]>`
    SELECT m.user_id FROM vip_members m JOIN users u ON u.id = m.user_id
    WHERE m.level >= 1 AND u.status = 'ACTIVE' AND u.birth_date IS NOT NULL AND extract(month FROM u.birth_date) = ${month}
      AND NOT EXISTS (SELECT 1 FROM vip_gift_grants g WHERE g.user_id = m.user_id AND g.kind = 'BIRTHDAY' AND g.period = ${period})
    ORDER BY m.user_id`;
  for (const { userId } of users) {
    const coins = await transaction(async (tx) => {
      await lockWallet(tx, userId);
      const [done] = await tx`SELECT 1 FROM vip_gift_grants WHERE user_id = ${userId} AND kind = 'BIRTHDAY' AND period = ${period}`;
      if (done) return 0;
      const tier = tierAt(tiers, await vipLevelOf(tx, userId));
      if (tier.birthdayGiftCoins <= 0) return 0;
      const { ledgerId, balanceAfter } = await postLedger(tx, {
        userId,
        amount: tier.birthdayGiftCoins,
        entryType: 'VIP_BIRTHDAY_GIFT',
        refType: 'vip_gift',
        refId: `${userId}:${period}`,
        memo: `VIP${tier.level} ${tier.name} ${year} 生日禮（不可退款）`,
      });
      await tx`INSERT INTO vip_gift_grants (user_id, kind, period, level, coins, ledger_id) VALUES (${userId}, 'BIRTHDAY', ${period}, ${tier.level}, ${tier.birthdayGiftCoins}, ${ledgerId})`;
      await notifyEvent(tx, {
        userId,
        event: 'VIP_BIRTHDAY_GIFT',
        data: { level: tier.level, name: tier.name, coins: tier.birthdayGiftCoins, year },
        payload: { level: tier.level, coins: tier.birthdayGiftCoins, year },
        dedupeOn: { kind: 'BIRTHDAY', year },
      });
      await appendAudit(tx, { actorType: 'SYSTEM', actorId: 'vip-birthday', action: 'VIP_BIRTHDAY_GIFT', entityType: 'user', entityId: userId, payload: { year, level: tier.level, coins: tier.birthdayGiftCoins, ledgerId, coinsAfter: balanceAfter, refundable: false } });
      return tier.birthdayGiftCoins;
    });
    if (coins) {
      out.granted++;
      out.coins += coins;
    }
  }
  return out;
}

/**
 * 年度重新評等（排程：1/1 00:05 台灣時間；可重複執行，每人每年一次）。
 * 評等年度 = `now` 的台灣年份；評等期間 = 上一個日曆年（[前一年 1/1, 今年 1/1)，台灣時間）。
 *   新等級 = max(依期間花費的等級, 原等級 − 1)（每年最多降一級；期間花費達更高等級則升級並補發升級禮）。
 *   升級用累計花費 = max(期間花費, 新等級門檻) ＋ 期間結束後（今年）已發生的花費。
 */
export async function runVipAnnualRerating(now: Date = new Date()): Promise<{ year: number; processed: number; dropped: number; raised: number; kept: number }> {
  const { year } = taipeiDate(now);
  const from = taipeiMidnight(year - 1, 1, 1);
  const to = taipeiMidnight(year, 1, 1);
  const out = { year, processed: 0, dropped: 0, raised: 0, kept: 0 };
  const users = await db()<{ userId: string }[]>`
    SELECT m.user_id FROM vip_members m
    WHERE NOT EXISTS (SELECT 1 FROM vip_ratings r WHERE r.user_id = m.user_id AND r.year = ${year})
    ORDER BY m.user_id`;
  for (const { userId } of users) {
    const r = await transaction(async (tx) => {
      await lockWallet(tx, userId);
      const tiers = await loadTiers(tx);
      const m = await lockMember(tx, userId);
      const [done] = await tx`SELECT 1 FROM vip_ratings WHERE user_id = ${userId} AND year = ${year}`;
      if (done) return null;
      const [s] = await tx<{ inWindow: number; since: number }[]>`
        SELECT COALESCE(sum(amount) FILTER (WHERE occurred_at >= ${from} AND occurred_at < ${to}), 0)::bigint AS in_window,
               COALESCE(sum(amount) FILTER (WHERE occurred_at >= ${to}), 0)::bigint AS since
        FROM vip_spend_events WHERE user_id = ${userId}`;
      const windowSpend = Math.max(0, s!.inWindow);
      const computed = tierForSpend(tiers, windowSpend).level;
      const rated = Math.max(computed, m.level - 1, 0);
      const qualifying = Math.max(0, Math.max(windowSpend, tierAt(tiers, rated).spendThreshold) + s!.since);
      const level = Math.max(rated, tierForSpend(tiers, qualifying).level);
      await tx`
        UPDATE vip_members SET level = ${level}, qualifying_spend = ${qualifying}, level_since = ${level !== m.level ? tx`now()` : tx`level_since`}, updated_at = now()
        WHERE user_id = ${userId}`;
      await tx`INSERT INTO vip_ratings (user_id, year, from_level, computed_level, to_level, window_spend)
               VALUES (${userId}, ${year}, ${m.level}, ${computed}, ${level}, ${windowSpend})`;
      const { audits } = level > m.level ? await grantUpgradeGifts(tx, userId, tiers, level, 'chiaki', `rerating:${year}`) : { audits: [] };
      await appendAudit(tx, { actorType: 'SYSTEM', actorId: 'vip-rerating', action: 'VIP_ANNUAL_RERATING', entityType: 'user', entityId: userId, payload: { year, from: m.level, computed, to: level, windowSpend, qualifyingSpend: qualifying } });
      for (const a of audits) await appendAudit(tx, a);
      return { from: m.level, to: level };
    });
    if (!r) continue;
    out.processed++;
    if (r.to < r.from) out.dropped++;
    else if (r.to > r.from) out.raised++;
    else out.kept++;
  }
  return out;
}
