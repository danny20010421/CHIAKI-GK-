import { db } from '@/server/db';
import { json, route } from '@/server/http';
import { liveBanners } from '@/server/modules/marketing/marketing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/banners — 首頁橫幅（啟用且在上架期間內，依排序；桌機 3:1 圖、手機圖選填） */
export const GET = route(async () => json({ banners: await liveBanners(db()) }));
