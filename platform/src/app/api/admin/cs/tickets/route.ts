import { json, query, requirePrincipal, route } from '@/server/http';
import { listTickets } from '@/server/modules/cs/tickets';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/admin/cs/tickets?status=&category=&assigneeId=&overdue=1 — 工單列表（逾期優先） */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const q = query(req);
  return json({
    tickets: await listTickets(p, {
      status: (q.get('status') ?? undefined) as never,
      category: (q.get('category') ?? undefined) as never,
      assigneeId: q.get('assigneeId') ?? undefined,
      overdue: (q.get('overdue') ?? undefined) as never,
    }),
  });
});
