import { db } from '@/server/db';
import { json, query, route } from '@/server/http';
import { publicIps } from '@/server/modules/catalog/ips';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/ips?q= — IP 目錄（大廳篩選與搜尋；IP 只代表作品，沒有分類）。
 * q：名稱或別名（不分大小寫、部分比對）。排序：預設依名稱字數再依中文排序，後台可改為手動順序。
 */
export const GET = route(async (req: Request) => {
  const q = query(req);
  return json(await publicIps(db(), { q: q.get('q') ?? undefined }));
});
