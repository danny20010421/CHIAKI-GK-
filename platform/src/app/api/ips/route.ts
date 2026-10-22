import { db } from '@/server/db';
import { json, route } from '@/server/http';
import { publicIpDirectory } from '@/server/modules/catalog/ips';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/ips — 大廳篩選：依分類分組、依排序的 IP 清單（只含顯示中者，附上架中賞池數） */
export const GET = route(async () => json(await publicIpDirectory(db())));
