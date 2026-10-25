import { z } from 'zod';
import { mediaUrl } from '../../lib/media';
import { AppError } from '../../errors';
import { db, transaction, type Db, type Tx } from '../../db';
import { appendAudit } from '../audit/audit';
import { requirePermission, type Principal } from '../auth/rbac';
import { taipeiDay, taipeiDayStart } from '../../lib/taipei';

/**
 * 首頁橫幅與優惠券（後台，權限 marketing.manage：營運 / 超級管理員；所有變更寫入稽核鏈）。
 *
 * 橫幅：標題、替代文字（未填 = 標題）、連結（站內路徑 /… 或 https:// 網址）、是否新分頁開啟（未填：外部網址 → 是、站內 → 否）、
 *   上架起訖（台灣時間；可給 YYYY-MM-DD → 開始日 00:00 起、結束日當天 23:59:59 止，或完整 ISO 時間）、啟用、排序；
 *   桌機圖必填：素材（類型 banner，3:1 ±2%）或圖片網址（https:// 或站內路徑）擇一；手機圖（素材 bannerM 或網址）選填。
 *   公開端點只回傳「啟用中且在起訖時間內」的橫幅，依排序（再依建立時間）。
 * 優惠券：代碼 A–Z0–9 4–16 碼（未刪除者唯一）、類型 pct（折扣 1–90%）/ amt（折抵 ≥ 1 UC幣）、最低消費、發放上限、到期日、啟用。
 *   免運券（ship）已停用（運費到付）。已被使用過的代碼不可再改（資料庫觸發器同步強制）；刪除為軟刪除。
 *   會員領取與抽賞結帳折抵見 marketing/coupons.ts。
 */

// ───────────── 橫幅 ─────────────

/** 連結：站內路徑（/ 開頭、不可為 //）或 https:// 網址（須有主機名稱）；不可含空白 */
export const BannerLinkSchema = z
  .string()
  .trim()
  .max(500)
  .refine((s) => {
    if (/\s/.test(s)) return false;
    if (s.startsWith('/')) return !s.startsWith('//') && !s.startsWith('/\\');
    if (!s.startsWith('https://')) return false;
    try {
      const u = new URL(s);
      return u.protocol === 'https:' && u.hostname.length > 0 && !u.username && !u.password;
    } catch {
      return false;
    }
  }, '連結須為站內路徑（/ 開頭）或 https:// 網址');
const ImageRefSchema = z
  .string()
  .trim()
  .max(2000)
  .regex(/^(https:\/\/[^/\s]+|\/[^/\s])\S*$/, '圖片須為 https:// 網址或站內路徑');
/** 起訖：YYYY-MM-DD（台灣日期）或 ISO 時間 */
const DayOrDate = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.coerce.date()]);
const startOf = (v: string | Date | null | undefined) => (v == null ? v : typeof v === 'string' ? taipeiDayStart(v) : v);
const endOf = (v: string | Date | null | undefined) => (v == null ? v : typeof v === 'string' ? taipeiDayStart(v, 1) : v);

const isExternal = (link: string | null) => link !== null && link.startsWith('https://');

const BannerFields = {
  title: z.string().trim().min(1).max(100),
  altText: z.string().trim().min(1).max(200).optional(),
  linkUrl: BannerLinkSchema.nullable().optional(),
  openInNewTab: z.boolean().optional(),
  startsAt: DayOrDate.nullable().optional(),
  endsAt: DayOrDate.nullable().optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().min(-100000).max(100000).optional(),
  desktopAssetId: z.string().uuid().nullable().optional(),
  desktopImageUrl: ImageRefSchema.nullable().optional(),
  mobileAssetId: z.string().uuid().nullable().optional(),
  mobileImageUrl: ImageRefSchema.nullable().optional(),
};
export const BannerSchema = z
  .object(BannerFields)
  .strict()
  .superRefine((v, ctx) => {
    if (!v.desktopAssetId && !v.desktopImageUrl) ctx.addIssue({ code: 'custom', path: ['desktopAssetId'], message: '桌機圖片為必填（素材 id 或圖片網址）' });
    if (v.desktopAssetId && v.desktopImageUrl) ctx.addIssue({ code: 'custom', path: ['desktopImageUrl'], message: '桌機圖片請擇一：素材 id 或圖片網址' });
    if (v.mobileAssetId && v.mobileImageUrl) ctx.addIssue({ code: 'custom', path: ['mobileImageUrl'], message: '手機圖片請擇一：素材 id 或圖片網址' });
    const s = startOf(v.startsAt);
    const e = endOf(v.endsAt);
    if (s && e && e <= s) ctx.addIssue({ code: 'custom', path: ['endsAt'], message: '結束時間必須晚於開始時間' });
  });
export const BannerUpdateSchema = z
  .object({ ...BannerFields, title: BannerFields.title.optional() })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'nothing to update');

interface BannerRow {
  id: string;
  title: string;
  altText: string;
  linkUrl: string | null;
  openInNewTab: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  enabled: boolean;
  sortOrder: number;
  desktopAssetId: string | null;
  desktopImageUrl: string | null;
  mobileAssetId: string | null;
  mobileImageUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}
const BANNER_COLS = (d: Db | Tx) =>
  d`id, title, alt_text, link_url, open_in_new_tab, starts_at, ends_at, enabled, sort_order, desktop_asset_id, desktop_image_url, mobile_asset_id, mobile_image_url, created_at, updated_at`;
const imageOf = (assetId: string | null, url: string | null) => (assetId ? `/api/assets/${assetId}` : mediaUrl(url));
/** 結束時刻（不含）→ 最後上架的台灣日期 */
const lastDayOf = (end: Date | null) => (end ? taipeiDay(new Date(end.getTime() - 1)) : null);
const showBanner = (b: BannerRow) => ({
  id: b.id,
  title: b.title,
  altText: b.altText,
  linkUrl: b.linkUrl,
  openInNewTab: b.openInNewTab,
  external: isExternal(b.linkUrl),
  startsAt: b.startsAt,
  endsAt: b.endsAt,
  /** 上架起訖（台灣日期，含結束日） */
  startDate: b.startsAt ? taipeiDay(b.startsAt) : null,
  endDate: lastDayOf(b.endsAt),
  enabled: b.enabled,
  sortOrder: b.sortOrder,
  desktopAssetId: b.desktopAssetId,
  mobileAssetId: b.mobileAssetId,
  desktopImageUrl: imageOf(b.desktopAssetId, b.desktopImageUrl),
  mobileImageUrl: imageOf(b.mobileAssetId, b.mobileImageUrl),
  createdAt: b.createdAt,
  updatedAt: b.updatedAt,
});

async function assertBannerAssets(tx: Tx, desktopId: string | null, mobileId: string | null) {
  if (desktopId) {
    const [d] = await tx<{ type: string; width: number; height: number }[]>`SELECT type, width, height FROM assets WHERE id = ${desktopId}`;
    if (!d) throw new AppError('VALIDATION', '找不到桌機橫幅圖片素材');
    if (d.type !== 'banner') throw new AppError('VALIDATION', '桌機圖片須為「首頁橫幅（桌機）」素材（3:1）');
    if (Math.abs(d.width / d.height / 3 - 1) > 0.02) throw new AppError('VALIDATION', `桌機橫幅須為 3:1（目前 ${d.width}×${d.height}）`);
  }
  if (mobileId) {
    const [m] = await tx<{ type: string }[]>`SELECT type FROM assets WHERE id = ${mobileId}`;
    if (!m || m.type !== 'bannerM') throw new AppError('VALIDATION', '手機圖片須為「首頁橫幅（手機）」素材');
  }
}

async function audit(tx: Tx, actor: Principal, action: string, entityType: string, entityId: string, payload: Record<string, unknown>) {
  await appendAudit(tx, { actorType: 'ADMIN', actorId: actor.userId, action, entityType, entityId, payload });
}

export async function listBannersAdmin(actor: Principal) {
  requirePermission(actor, 'marketing.manage');
  const d = db();
  return { banners: (await d<BannerRow[]>`SELECT ${BANNER_COLS(d)} FROM banners ORDER BY sort_order, created_at`).map(showBanner) };
}

export async function getBannerAdmin(actor: Principal, id: string) {
  requirePermission(actor, 'marketing.manage');
  const d = db();
  const [b] = await d<BannerRow[]>`SELECT ${BANNER_COLS(d)} FROM banners WHERE id = ${id}`;
  if (!b) throw new AppError('NOT_FOUND', 'banner not found');
  return showBanner(b);
}

const auditView = (b: ReturnType<typeof showBanner>) => ({
  title: b.title,
  linkUrl: b.linkUrl,
  openInNewTab: b.openInNewTab,
  startsAt: b.startsAt,
  endsAt: b.endsAt,
  enabled: b.enabled,
  sortOrder: b.sortOrder,
  desktopImageUrl: b.desktopImageUrl,
  mobileImageUrl: b.mobileImageUrl,
});

export async function createBanner(actor: Principal, input: z.input<typeof BannerSchema>) {
  requirePermission(actor, 'marketing.manage');
  const v = BannerSchema.parse(input);
  const link = v.linkUrl ?? null;
  return transaction(async (tx) => {
    await assertBannerAssets(tx, v.desktopAssetId ?? null, v.mobileAssetId ?? null);
    const [b] = await tx<BannerRow[]>`
      INSERT INTO banners (title, alt_text, link_url, open_in_new_tab, starts_at, ends_at, enabled, sort_order,
                           desktop_asset_id, desktop_image_url, mobile_asset_id, mobile_image_url, created_by)
      VALUES (${v.title}, ${v.altText ?? v.title}, ${link}, ${v.openInNewTab ?? isExternal(link)}, ${startOf(v.startsAt) ?? null}, ${endOf(v.endsAt) ?? null},
              ${v.enabled ?? true}, ${v.sortOrder ?? 0}, ${v.desktopAssetId ?? null}, ${v.desktopImageUrl ?? null}, ${v.mobileAssetId ?? null}, ${v.mobileImageUrl ?? null},
              ${actor.userId})
      RETURNING ${BANNER_COLS(tx)}`;
    const out = showBanner(b!);
    await audit(tx, actor, 'BANNER_CREATED', 'banner', b!.id, { after: auditView(out) });
    return out;
  });
}

export async function updateBanner(actor: Principal, id: string, input: z.input<typeof BannerUpdateSchema>) {
  requirePermission(actor, 'marketing.manage');
  const v = BannerUpdateSchema.parse(input);
  return transaction(async (tx) => {
    const [cur] = await tx<BannerRow[]>`SELECT ${BANNER_COLS(tx)} FROM banners WHERE id = ${id} FOR UPDATE`;
    if (!cur) throw new AppError('NOT_FOUND', 'banner not found');
    // 圖片：給素材 id → 改用素材（清除網址）；給網址 → 改用網址（清除素材）；null → 移除
    if (v.desktopAssetId && v.desktopImageUrl) throw new AppError('VALIDATION', '桌機圖片請擇一：素材 id 或圖片網址');
    if (v.mobileAssetId && v.mobileImageUrl) throw new AppError('VALIDATION', '手機圖片請擇一：素材 id 或圖片網址');
    const pickImage = (assetIn: string | null | undefined, urlIn: string | null | undefined, asset: string | null, url: string | null) =>
      assetIn ? { asset: assetIn, url: null } : urlIn ? { asset: null, url: urlIn } : { asset: assetIn === null ? null : asset, url: urlIn === null ? null : url };
    const desk = pickImage(v.desktopAssetId, v.desktopImageUrl, cur.desktopAssetId, cur.desktopImageUrl);
    const mob = pickImage(v.mobileAssetId, v.mobileImageUrl, cur.mobileAssetId, cur.mobileImageUrl);
    if (!desk.asset && !desk.url) throw new AppError('VALIDATION', '桌機圖片為必填（素材 id 或圖片網址）');
    const linkUrl = v.linkUrl === undefined ? cur.linkUrl : v.linkUrl;
    const next = {
      title: v.title ?? cur.title,
      altText: v.altText ?? cur.altText,
      linkUrl,
      // 連結改變且未指定 → 依新連結預設（外部網址新分頁）
      openInNewTab: v.openInNewTab ?? (v.linkUrl !== undefined && v.linkUrl !== cur.linkUrl ? isExternal(linkUrl) : cur.openInNewTab),
      startsAt: v.startsAt === undefined ? cur.startsAt : (startOf(v.startsAt) as Date | null),
      endsAt: v.endsAt === undefined ? cur.endsAt : (endOf(v.endsAt) as Date | null),
      enabled: v.enabled ?? cur.enabled,
      sortOrder: v.sortOrder ?? cur.sortOrder,
    };
    if (next.startsAt && next.endsAt && next.endsAt <= next.startsAt) throw new AppError('VALIDATION', '結束時間必須晚於開始時間');
    if (v.desktopAssetId || v.mobileAssetId) await assertBannerAssets(tx, v.desktopAssetId ?? null, v.mobileAssetId ?? null);
    const [b] = await tx<BannerRow[]>`
      UPDATE banners SET title = ${next.title}, alt_text = ${next.altText}, link_url = ${next.linkUrl}, open_in_new_tab = ${next.openInNewTab},
             starts_at = ${next.startsAt}, ends_at = ${next.endsAt}, enabled = ${next.enabled}, sort_order = ${next.sortOrder},
             desktop_asset_id = ${desk.asset}, desktop_image_url = ${desk.url}, mobile_asset_id = ${mob.asset}, mobile_image_url = ${mob.url}, updated_at = now()
      WHERE id = ${id} RETURNING ${BANNER_COLS(tx)}`;
    const out = showBanner(b!);
    const changed = Object.keys(v).filter((k) => v[k as keyof typeof v] !== undefined);
    await audit(tx, actor, 'BANNER_UPDATED', 'banner', id, { changed, before: auditView(showBanner(cur)), after: auditView(out) });
    return out;
  });
}

export async function deleteBanner(actor: Principal, id: string) {
  requirePermission(actor, 'marketing.manage');
  return transaction(async (tx) => {
    const [b] = await tx<BannerRow[]>`DELETE FROM banners WHERE id = ${id} RETURNING ${BANNER_COLS(tx)}`;
    if (!b) throw new AppError('NOT_FOUND', 'banner not found');
    await audit(tx, actor, 'BANNER_DELETED', 'banner', id, { before: auditView(showBanner(b)) });
    return { id, deleted: true };
  });
}

/** 公開：目前上架中的橫幅（啟用且在起訖時間內），依排序 */
export async function liveBanners(d: Db, now: Date = new Date()) {
  const rows = await d<BannerRow[]>`
    SELECT ${BANNER_COLS(d)} FROM banners
    WHERE enabled AND (starts_at IS NULL OR starts_at <= ${now}) AND (ends_at IS NULL OR ends_at > ${now})
    ORDER BY sort_order, created_at, id`;
  return rows.map((b) => {
    const x = showBanner(b);
    return {
      id: x.id,
      title: x.title,
      altText: x.altText,
      linkUrl: x.linkUrl,
      openInNewTab: x.openInNewTab,
      external: x.external,
      desktopImageUrl: x.desktopImageUrl!,
      mobileImageUrl: x.mobileImageUrl,
      sortOrder: x.sortOrder,
      startsAt: x.startsAt,
      endsAt: x.endsAt,
    };
  });
}

// ───────────── 優惠券 ─────────────

/** 優惠券類型（免運券 ship 已停用：運費到付） */
export const COUPON_KINDS = ['pct', 'amt'] as const;
const CodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{4,16}$/, '優惠碼須為 4–16 碼英文大寫或數字');
const CouponFields = {
  code: CodeSchema,
  kind: z.enum(COUPON_KINDS),
  value: z.number().int().min(0).max(1_000_000),
  minSpend: z.number().int().min(0).max(10_000_000).optional(),
  issueLimit: z.number().int().positive().max(10_000_000).nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  enabled: z.boolean().optional(),
};
function valueRule(kind: string, value: number): string | null {
  if (kind === 'pct' && (value < 1 || value > 90)) return '折扣百分比須為 1–90';
  if (kind === 'amt' && value < 1) return '折抵金額須至少 1';
  return null;
}
export const CouponSchema = z.object(CouponFields).superRefine((v, ctx) => {
  const m = valueRule(v.kind, v.value);
  if (m) ctx.addIssue({ code: 'custom', path: ['value'], message: m });
});
export const CouponUpdateSchema = z
  .object({ ...CouponFields, code: CodeSchema.optional(), kind: CouponFields.kind.optional(), value: CouponFields.value.optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'nothing to update');

interface CouponRow {
  id: string;
  code: string;
  kind: (typeof COUPON_KINDS)[number] | 'ship';
  value: number;
  minSpend: number;
  issueLimit: number | null;
  issuedCount: number;
  usedCount: number;
  expiresAt: Date | null;
  enabled: boolean;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
const COUPON_COLS = (d: Db | Tx) => d`id, code, kind, value, min_spend, issue_limit, issued_count, used_count, expires_at, enabled, deleted_at, created_at, updated_at`;

export async function listCouponsAdmin(actor: Principal, opts: { includeDeleted?: boolean } = {}) {
  requirePermission(actor, 'marketing.manage');
  const d = db();
  return { coupons: await d<CouponRow[]>`SELECT ${COUPON_COLS(d)} FROM coupons ${opts.includeDeleted ? d`` : d`WHERE deleted_at IS NULL`} ORDER BY created_at DESC` };
}

async function assertCodeFree(tx: Tx, code: string, exceptId: string | null) {
  const [dup] = await tx`SELECT 1 FROM coupons WHERE code = ${code} AND deleted_at IS NULL ${exceptId ? tx`AND id <> ${exceptId}` : tx``}`;
  if (dup) throw new AppError('CONFLICT', `優惠碼 ${code} 已存在`);
}

export async function createCoupon(actor: Principal, input: z.input<typeof CouponSchema>) {
  requirePermission(actor, 'marketing.manage');
  const v = CouponSchema.parse(input);
  return transaction(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`coupon:${v.code}`}))`;
    await assertCodeFree(tx, v.code, null);
    const [c] = await tx<CouponRow[]>`
      INSERT INTO coupons (code, kind, value, min_spend, issue_limit, expires_at, enabled, created_by)
      VALUES (${v.code}, ${v.kind}, ${v.value}, ${v.minSpend ?? 0}, ${v.issueLimit ?? null}, ${v.expiresAt ?? null}, ${v.enabled ?? true}, ${actor.userId})
      RETURNING ${COUPON_COLS(tx)}`;
    await audit(tx, actor, 'COUPON_CREATED', 'coupon', c!.id, { code: v.code, kind: v.kind, value: v.value, minSpend: v.minSpend ?? 0, issueLimit: v.issueLimit ?? null });
    return c!;
  });
}

export async function updateCoupon(actor: Principal, id: string, input: z.input<typeof CouponUpdateSchema>) {
  requirePermission(actor, 'marketing.manage');
  const v = CouponUpdateSchema.parse(input);
  return transaction(async (tx) => {
    const [cur] = await tx<CouponRow[]>`SELECT ${COUPON_COLS(tx)} FROM coupons WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
    if (!cur) throw new AppError('NOT_FOUND', 'coupon not found');
    const next = {
      code: v.code ?? cur.code,
      kind: v.kind ?? cur.kind,
      value: v.value ?? cur.value,
      minSpend: v.minSpend ?? cur.minSpend,
      issueLimit: v.issueLimit === undefined ? cur.issueLimit : v.issueLimit,
      expiresAt: v.expiresAt === undefined ? cur.expiresAt : v.expiresAt,
      enabled: v.enabled ?? cur.enabled,
    };
    if (next.code !== cur.code) {
      if (cur.usedCount > 0) throw new AppError('CONFLICT', '此優惠碼已被使用過，不能修改代碼');
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`coupon:${next.code}`}))`;
      await assertCodeFree(tx, next.code, id);
    }
    const m = valueRule(next.kind, next.value);
    if (m) throw new AppError('VALIDATION', m);
    if (next.issueLimit !== null && next.issueLimit < cur.issuedCount) throw new AppError('VALIDATION', `發放上限不能小於已發放數量（${cur.issuedCount}）`);
    const [c] = await tx<CouponRow[]>`
      UPDATE coupons SET code = ${next.code}, kind = ${next.kind}, value = ${next.value}, min_spend = ${next.minSpend}, issue_limit = ${next.issueLimit},
             expires_at = ${next.expiresAt}, enabled = ${next.enabled}, updated_at = now()
      WHERE id = ${id} RETURNING ${COUPON_COLS(tx)}`;
    const before = Object.fromEntries(Object.keys(next).map((k) => [k, cur[k as keyof CouponRow]]));
    await audit(tx, actor, 'COUPON_UPDATED', 'coupon', id, { before, after: next });
    return c!;
  });
}

export async function deleteCoupon(actor: Principal, id: string) {
  requirePermission(actor, 'marketing.manage');
  return transaction(async (tx) => {
    const [c] = await tx<{ code: string }[]>`UPDATE coupons SET deleted_at = now(), enabled = false, updated_at = now() WHERE id = ${id} AND deleted_at IS NULL RETURNING code`;
    if (!c) throw new AppError('NOT_FOUND', 'coupon not found');
    await audit(tx, actor, 'COUPON_DELETED', 'coupon', id, { code: c.code });
    return { id, deleted: true };
  });
}
