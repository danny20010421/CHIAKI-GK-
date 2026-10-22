import { json, query, requirePrincipal, route } from '@/server/http';
import { listCannedReplies } from '@/server/modules/cs/tickets';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/admin/cs/canned-replies?category= — 罐頭回覆範本 */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json({ replies: await listCannedReplies(p, query(req).get('category') ?? undefined) });
});
