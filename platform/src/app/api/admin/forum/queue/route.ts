import { json, query, requirePrincipal, route } from '@/server/http';
import { moderationQueue } from '@/server/modules/forum/forum';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/admin/forum/queue?type=post|comment&status=PENDING — 審核佇列（forum.moderate） */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const q = query(req);
  return json(await moderationQueue(p, { type: (q.get('type') ?? undefined) as never, status: (q.get('status') ?? undefined) as never, limit: (q.get('limit') ?? undefined) as never }));
});
