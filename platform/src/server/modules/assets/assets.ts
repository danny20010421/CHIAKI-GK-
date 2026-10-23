import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../errors';
import { db, transaction, type Db, type Tx } from '../../db';
import { appendAudit } from '../audit/audit';
import { requirePermission, type Principal } from '../auth/rbac';
import { readImageHeader, type ImageInfo } from './image-header';
import { stripMetadata } from './reencode';
import { ASSET_SPECS, ASSET_TYPES, checkAgainstSpec, type AssetType, type CheckResult } from './specs';

/**
 * 圖片素材（伺服器端驗證，後台無法繞過前台檢查器）：
 *  - 以 base64 JSON 上傳（POST /api/admin/assets；本文上限 ASSET_UPLOAD_MAX_BODY_BYTES）。
 *  - 格式與尺寸一律由檔頭位元組解析（image-header.ts），宣告的檔名/MIME 只用來提示「與實際內容不符」。
 *  - 逐項檢查（格式、檔案大小、最小尺寸、比例 ±2%、高度上限）並回傳繁體中文訊息；任何一項不通過 → 422 ASSET_REJECTED（不儲存）。
 *  - 通過者儲存：類型、格式、寬高、位元組數、SHA-256、替代文字（必填）、上傳者、著作權確認（必須為 true）。
 *    同類型同內容（SHA-256）重複上傳 → 回傳既有素材（冪等）。
 *  - 素材可連結到賞池 / 獎項 / 橫幅 / IP / 合作夥伴 / 商城商品（類型須相容）。
 */
export const UploadSchema = z.object({
  type: z.enum(ASSET_TYPES),
  altText: z.string().trim().min(1, '替代文字（alt）為必填').max(200),
  copyrightConfirmed: z.literal(true, { errorMap: () => ({ message: '請確認您擁有此圖片的使用授權（copyrightConfirmed 必須為 true）' }) }),
  dataBase64: z.string().min(1).max(2_100_000),
  filename: z.string().max(200).optional(),
  mimeType: z.string().max(100).optional(),
  dryRun: z.boolean().default(false),
  links: z
    .array(z.object({ targetType: z.enum(['POOL', 'PRIZE', 'BANNER', 'IP', 'PARTNER', 'PRODUCT']), targetId: z.string().min(1).max(100), role: z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/).default('main') }))
    .max(20)
    .default([]),
});

export type TargetType = 'POOL' | 'PRIZE' | 'BANNER' | 'IP' | 'PARTNER' | 'PRODUCT';

/** 各連結對象可使用的素材類型 */
export const COMPATIBLE: Record<TargetType, AssetType[]> = {
  POOL: ['cover', 'banner', 'bannerM', 'event', 'eventBody', 'og'],
  PRIZE: ['prize', 'ticket'],
  BANNER: ['banner', 'bannerM', 'event', 'eventBody', 'og'],
  IP: ['ip', 'cover'],
  PARTNER: ['partner'],
  PRODUCT: ['product'],
};

const EXT: Record<string, string> = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', jfif: 'jpeg', webp: 'webp' };

export interface ValidationReport {
  type: AssetType;
  ok: boolean;
  detected: ImageInfo | null;
  bytes: number;
  sha256: string;
  checks: CheckResult[];
  /** 不影響通過與否的提醒（例如副檔名/MIME 與實際內容不符） */
  warnings: string[];
}

function decodeBase64(s: string): Buffer {
  const clean = s.replace(/^data:[^;,]+;base64,/, '').replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) throw new AppError('VALIDATION', 'dataBase64 不是有效的 base64');
  return Buffer.from(clean, 'base64');
}

/** 純驗證（不寫入）：前台與上傳共用 */
export function validateAsset(type: AssetType, bytes: Uint8Array, declared: { filename?: string; mimeType?: string } = {}): ValidationReport {
  const spec = ASSET_SPECS[type];
  const info = readImageHeader(bytes);
  const checks = checkAgainstSpec(spec, info, bytes.length);
  const warnings: string[] = [];
  if (info) {
    const ext = declared.filename?.split('.').pop()?.toLowerCase();
    if (ext && EXT[ext] && EXT[ext] !== info.format) warnings.push(`副檔名 .${ext} 與實際內容（${info.format.toUpperCase()}）不符，已以實際內容判斷`);
    const m = declared.mimeType?.toLowerCase().match(/^image\/(png|jpe?g|webp)$/)?.[1];
    if (m && EXT[m] !== info.format) warnings.push(`宣告的 MIME ${declared.mimeType} 與實際內容（${info.format.toUpperCase()}）不符，已以實際內容判斷`);
  }
  return { type, ok: checks.every((c) => c.ok), detected: info, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), checks, warnings };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

async function resolveTarget(tx: Tx, type: AssetType, targetType: TargetType, targetId: string): Promise<string> {
  if (!COMPATIBLE[targetType].includes(type)) {
    throw new AppError('VALIDATION', `「${ASSET_SPECS[type].label}」不能連結到 ${targetType}（可用：${COMPATIBLE[targetType].map((t) => ASSET_SPECS[t].label).join('、')}）`);
  }
  const need = (rows: readonly unknown[]) => {
    if (!rows.length) throw new AppError('NOT_FOUND', `${targetType} ${targetId} not found`);
  };
  switch (targetType) {
    case 'POOL': {
      const rows = UUID_RE.test(targetId) ? await tx<{ id: string }[]>`SELECT id FROM pools WHERE id = ${targetId}` : await tx<{ id: string }[]>`SELECT id FROM pools WHERE slug = ${targetId}`;
      need(rows);
      return rows[0]!.id;
    }
    case 'PRIZE':
    case 'IP':
    case 'PRODUCT': {
      if (!UUID_RE.test(targetId)) throw new AppError('VALIDATION', `${targetType} id must be a uuid`);
      const table = targetType === 'PRIZE' ? 'pool_prizes' : targetType === 'IP' ? 'ips' : 'products';
      need(await tx`SELECT 1 FROM ${tx(table)} WHERE id = ${targetId}`);
      return targetId;
    }
    case 'BANNER':
    case 'PARTNER':
      // 橫幅與合作夥伴尚無資料表 → 以 slug 識別
      if (!SLUG_RE.test(targetId)) throw new AppError('VALIDATION', `${targetType} 識別碼需為小寫英數與 -`);
      return targetId;
  }
}

async function insertLinks(tx: Tx, actor: Principal, assetId: string, type: AssetType, links: { targetType: TargetType; targetId: string; role: string }[]) {
  const out = [];
  for (const l of links) {
    const id = await resolveTarget(tx, type, l.targetType, l.targetId);
    await tx`INSERT INTO asset_links (asset_id, target_type, target_id, role, created_by) VALUES (${assetId}, ${l.targetType}, ${id}, ${l.role}, ${actor.userId})
             ON CONFLICT DO NOTHING`;
    out.push({ targetType: l.targetType, targetId: id, role: l.role });
  }
  return out;
}

export interface StoredAsset {
  id: string;
  type: AssetType;
  format: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  altText: string;
  copyrightConfirmed: boolean;
  uploadedBy: string;
  createdAt: Date;
}

const ASSET_COLS = (d: Db) => d`id, type, format, width, height, bytes, sha256, alt_text, copyright_confirmed, uploaded_by, created_at`;

export async function uploadAsset(actor: Principal, input: z.input<typeof UploadSchema>) {
  requirePermission(actor, 'asset.manage');
  const v = UploadSchema.parse(input);
  const bytes = decodeBase64(v.dataBase64);
  const report = validateAsset(v.type, bytes, { filename: v.filename, mimeType: v.mimeType });
  if (!report.ok) throw new AppError('ASSET_REJECTED', '圖片不符合規格，請依各項檢查結果修正後再上傳', { report });
  if (v.dryRun) return { stored: false, replayed: false, asset: null, links: [], report };
  return transaction(async (tx) => {
    const [existing] = await tx<StoredAsset[]>`SELECT ${ASSET_COLS(tx)} FROM assets WHERE type = ${v.type} AND sha256 = ${report.sha256}`;
    let asset = existing;
    if (!asset) {
      [asset] = await tx<StoredAsset[]>`
        INSERT INTO assets (type, format, width, height, bytes, sha256, alt_text, copyright_confirmed, original_filename, uploaded_by, content)
        VALUES (${v.type}, ${report.detected!.format}, ${report.detected!.width}, ${report.detected!.height}, ${bytes.length}, ${report.sha256},
                ${v.altText}, true, ${v.filename ?? null}, ${actor.userId}, ${bytes})
        ON CONFLICT (type, sha256) DO NOTHING
        RETURNING ${ASSET_COLS(tx)}`;
      asset ??= (await tx<StoredAsset[]>`SELECT ${ASSET_COLS(tx)} FROM assets WHERE type = ${v.type} AND sha256 = ${report.sha256}`)[0];
    }
    const links = await insertLinks(tx, actor, asset!.id, v.type, v.links);
    await appendAudit(tx, {
      actorType: 'ADMIN',
      actorId: actor.userId,
      action: existing ? 'ASSET_REUSED' : 'ASSET_UPLOADED',
      entityType: 'asset',
      entityId: asset!.id,
      payload: { type: v.type, format: asset!.format, width: asset!.width, height: asset!.height, bytes: asset!.bytes, sha256: asset!.sha256, copyrightConfirmed: true, links },
    });
    return { stored: true, replayed: Boolean(existing), asset: asset!, links, report };
  });
}

export const LinkSchema = z.object({
  targetType: z.enum(['POOL', 'PRIZE', 'BANNER', 'IP', 'PARTNER', 'PRODUCT']),
  targetId: z.string().min(1).max(100),
  role: z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/).default('main'),
});

export async function linkAsset(actor: Principal, assetId: string, input: z.input<typeof LinkSchema>) {
  requirePermission(actor, 'asset.manage');
  const v = LinkSchema.parse(input);
  return transaction(async (tx) => {
    const [a] = await tx<{ type: AssetType }[]>`SELECT type FROM assets WHERE id = ${assetId}`;
    if (!a) throw new AppError('NOT_FOUND', 'asset not found');
    const [link] = await insertLinks(tx, actor, assetId, a.type, [v]);
    await appendAudit(tx, { actorType: 'ADMIN', actorId: actor.userId, action: 'ASSET_LINKED', entityType: 'asset', entityId: assetId, payload: link! });
    return { assetId, ...link! };
  });
}

export async function unlinkAsset(actor: Principal, assetId: string, input: z.input<typeof LinkSchema>) {
  requirePermission(actor, 'asset.manage');
  const v = LinkSchema.parse(input);
  return transaction(async (tx) => {
    const rows = await tx`DELETE FROM asset_links WHERE asset_id = ${assetId} AND target_type = ${v.targetType} AND target_id = ${v.targetId} AND role = ${v.role} RETURNING asset_id`;
    if (!rows.length) throw new AppError('NOT_FOUND', 'link not found');
    await appendAudit(tx, { actorType: 'ADMIN', actorId: actor.userId, action: 'ASSET_UNLINKED', entityType: 'asset', entityId: assetId, payload: v });
    return { unlinked: true };
  });
}

export async function listAssets(actor: Principal, f: { type?: string; targetType?: string; targetId?: string } = {}) {
  requirePermission(actor, 'asset.manage');
  const d = db();
  const rows = await d<(StoredAsset & { links: string })[]>`
    SELECT ${d`a.id, a.type, a.format, a.width, a.height, a.bytes, a.sha256, a.alt_text, a.copyright_confirmed, a.uploaded_by, a.created_at`},
           COALESCE((SELECT json_agg(json_build_object('targetType', l.target_type, 'targetId', l.target_id, 'role', l.role))::text FROM asset_links l WHERE l.asset_id = a.id), '[]') AS links
    FROM assets a
    WHERE true
      ${f.type ? d`AND a.type = ${f.type}` : d``}
      ${f.targetType && f.targetId ? d`AND EXISTS (SELECT 1 FROM asset_links l WHERE l.asset_id = a.id AND l.target_type = ${f.targetType} AND l.target_id = ${f.targetId})` : d``}
    ORDER BY a.created_at DESC LIMIT 200`;
  return rows.map((r) => ({ ...r, links: JSON.parse(r.links) as unknown[], url: `/api/assets/${r.id}` }));
}

const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const;

/** 公開取圖（內容不可變 → 可長期快取） */
export async function getAssetContent(d: Db, id: string): Promise<{ contentType: string; body: Buffer; sha256: string; altText: string }> {
  const [a] = await d<{ format: keyof typeof MIME; content: Buffer; sha256: string; altText: string }[]>`SELECT format, content, sha256, alt_text FROM assets WHERE id = ${id}`;
  if (!a) throw new AppError('NOT_FOUND', 'asset not found');
  return { contentType: MIME[a.format], body: a.content, sha256: a.sha256, altText: a.altText };
}

/** 會員上傳（頭像、討論區圖片）的輸入 */
export const MemberImageSchema = z.object({
  dataBase64: z.string().min(1).max(1_200_000),
  copyrightConfirmed: z.literal(true, { errorMap: () => ({ message: '請確認您擁有此圖片的使用授權（copyrightConfirmed 必須為 true）' }) }),
  filename: z.string().max(200).optional(),
  mimeType: z.string().max(100).optional(),
});

/**
 * 會員圖片：沿用素材驗證器（格式、大小、尺寸、比例）→ 重新封裝去除所有中繼資料（EXIF/GPS…）→ 再驗證一次 → 儲存。
 * 回傳素材 id（公開網址 /api/assets/:id）。須在呼叫端的交易內執行（稽核由呼叫端寫）。
 */
export async function storeMemberImage(
  tx: Tx,
  userId: string,
  type: 'avatar' | 'forum',
  input: z.infer<typeof MemberImageSchema>,
  altText: string,
  extra?: (info: ImageInfo) => CheckResult | null,
): Promise<{ id: string; url: string; width: number; height: number; bytes: number; strippedBytes: number }> {
  const raw = decodeBase64(input.dataBase64);
  const first = validateAsset(type, raw, { filename: input.filename, mimeType: input.mimeType });
  const more = first.detected && extra ? extra(first.detected) : null;
  if (more && !more.ok) first.checks.push(more);
  if (!first.ok || (more && !more.ok)) throw new AppError('ASSET_REJECTED', '圖片不符合規格，請依各項檢查結果修正後再上傳', { report: { ...first, ok: false } });
  const clean = stripMetadata(raw, first.detected!.format);
  const report = validateAsset(type, clean);
  if (!report.ok) throw new AppError('ASSET_REJECTED', '圖片不符合規格', { report });
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO assets (type, format, width, height, bytes, sha256, alt_text, copyright_confirmed, original_filename, uploaded_by, content)
    VALUES (${type}, ${report.detected!.format}, ${report.detected!.width}, ${report.detected!.height}, ${clean.length}, ${report.sha256},
            ${altText.slice(0, 200)}, true, ${input.filename ?? null}, ${userId}, ${clean})
    ON CONFLICT (type, sha256) DO UPDATE SET type = EXCLUDED.type
    RETURNING id`;
  return { id: row!.id, url: `/api/assets/${row!.id}`, width: report.detected!.width, height: report.detected!.height, bytes: raw.length, strippedBytes: clean.length };
}
