import { json, query, requirePrincipal, route } from '@/server/http';
import { listReports } from '@/server/modules/forum/forum';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/admin/forum/reports?status=OPEN|RESOLVED|DISMISSED — 檢舉列表 */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const s = query(req).get('status');
  return json(await listReports(p, s === 'RESOLVED' || s === 'DISMISSED' ? s : 'OPEN'));
});
