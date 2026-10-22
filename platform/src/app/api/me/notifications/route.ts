import { db } from '@/server/db';
import { body, json, query, requirePrincipal, route } from '@/server/http';
import { listNotifications, markNotificationsRead, MarkReadSchema } from '@/server/modules/notifications/notifications';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/me/notifications?unread=1 — 站內通知（寄存到期提醒、自動轉換結果…） */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json({ notifications: await listNotifications(db(), p.userId, query(req).get('unread') === '1') });
});

/** POST /api/me/notifications — 標記已讀 { ids: uuid[] } */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, MarkReadSchema);
  return json(await markNotificationsRead(db(), p.userId, b.ids));
});
