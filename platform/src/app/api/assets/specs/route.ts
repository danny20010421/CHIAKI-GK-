import { json, route } from '@/server/http';
import { publicSpecs } from '@/server/modules/assets/specs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/assets/specs — 圖片素材規格表（前台檢查器與後台共用；伺服器上傳時會重新驗證） */
export const GET = route(async () => json(publicSpecs(), 200, { 'cache-control': 'public, max-age=300' }));
