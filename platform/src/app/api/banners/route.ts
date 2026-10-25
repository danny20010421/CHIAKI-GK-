import { db } from '@/server/db';
import { json, route } from '@/server/http';
import { liveBanners } from '@/server/modules/marketing/marketing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/banners — 首頁橫幅（啟用且在上架期間內，依 sortOrder）：
 * { banners: [{ id, title, altText, linkUrl, openInNewTab, external, desktopImageUrl, mobileImageUrl|null, sortOrder, startsAt, endsAt }] }
 */
export const GET = route(async () => json({ banners: await liveBanners(db()) }));
