import { json, requirePrincipal, route } from '@/server/http';
import { csDashboard } from '@/server/modules/cs/tickets';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/admin/cs/dashboard — 各狀態數、逾期、即將逾期、未指派、各分類 */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json(await csDashboard(p));
});
