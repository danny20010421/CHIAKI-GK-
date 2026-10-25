import { body, json, requirePrincipal, route } from '@/server/http';
import { BannerSchema, createBanner, listBannersAdmin } from '@/server/modules/marketing/marketing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/admin/banners — 全部橫幅 */
export const GET = route(async (req: Request) => json(await listBannersAdmin(await requirePrincipal(req))));

/**
 * POST /api/admin/banners — { title, altText?（預設 = title）, linkUrl?（/站內路徑 或 https://…）, openInNewTab?（預設：外部網址 true）,
 *   startsAt?/endsAt?（YYYY-MM-DD 台灣日期，結束日含當天；或 ISO 時間）, enabled?, sortOrder?,
 *   desktopAssetId（3:1 素材）或 desktopImageUrl 擇一必填, mobileAssetId? / mobileImageUrl? }
 */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json(await createBanner(p, await body(req, BannerSchema)), 201);
});
