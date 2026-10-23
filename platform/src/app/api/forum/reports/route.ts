import { body, json, requirePrincipal, route } from '@/server/http';
import { reportContent, ReportSchema } from '@/server/modules/forum/forum';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/forum/reports — 檢舉 { targetType: POST|COMMENT, targetId, reason }（每人每個對象一次） */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json(await reportContent(p.userId, await body(req, ReportSchema)), 201);
});
