import { body, json, requirePrincipal, route } from '@/server/http';
import { BannerSchema, createBanner, listBannersAdmin } from '@/server/modules/marketing/marketing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/admin/banners — 全部橫幅 */
export const GET = route(async (req: Request) => json(await listBannersAdmin(await requirePrincipal(req))));

/** POST /api/admin/banners — { title, altText, linkUrl?, startsAt?, endsAt?, enabled?, sortOrder?, desktopAssetId（3:1 必填）, mobileAssetId? } */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json(await createBanner(p, await body(req, BannerSchema)), 201);
});
