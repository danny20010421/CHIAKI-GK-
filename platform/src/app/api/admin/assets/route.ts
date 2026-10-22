import { z } from 'zod';
import { config } from '@/server/config';
import { body, json, query, requirePrincipal, route } from '@/server/http';
import { listAssets, uploadAsset, UploadSchema } from '@/server/modules/assets/assets';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/admin/assets?type=&targetType=&targetId= — 素材列表（含連結） */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const q = query(req);
  const f = z
    .object({ type: z.string().max(20).optional(), targetType: z.string().max(20).optional(), targetId: z.string().max(100).optional() })
    .parse({ type: q.get('type') ?? undefined, targetType: q.get('targetType') ?? undefined, targetId: q.get('targetId') ?? undefined });
  return json({ assets: await listAssets(p, f) });
});

/**
 * POST /api/admin/assets — 上傳圖片素材（JSON）：
 *   { type, altText, copyrightConfirmed: true, dataBase64, filename?, mimeType?, dryRun?, links?: [{ targetType, targetId, role? }] }
 * 伺服器以檔頭判斷格式/尺寸並逐項檢查；不符 → 422 ASSET_REJECTED（details.report.checks 為各項繁中結果）。
 * dryRun=true 只回傳檢查結果不儲存。同類型同內容重複上傳 → 回傳既有素材（200）。
 */
export const POST = route(
  async (req: Request) => {
    const p = await requirePrincipal(req);
    const b = await body(req, UploadSchema);
    const r = await uploadAsset(p, b);
    return json(r, r.stored && !r.replayed ? 201 : 200);
  },
  { maxBodyBytes: () => config().ASSET_UPLOAD_MAX_BODY_BYTES },
);
