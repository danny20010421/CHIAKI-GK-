import { z } from 'zod';
import { db } from '@/server/db';
import { route, type RouteContext } from '@/server/http';
import { getAssetContent } from '@/server/modules/assets/assets';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/assets/:id — 取得素材圖片（內容以 SHA-256 識別、不可變 → 長期快取） */
export const GET = route(async (_req: Request, ctx: RouteContext<{ id: string }>) => {
  const { id } = await ctx.params;
  const a = await getAssetContent(db(), z.string().uuid().parse(id));
  return new Response(new Uint8Array(a.body), {
    status: 200,
    headers: { 'content-type': a.contentType, 'cache-control': 'public, max-age=31536000, immutable', etag: `"${a.sha256}"`, 'content-disposition': 'inline' },
  });
});
