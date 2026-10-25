import { db } from '@/server/db';
import { body, json, requirePrincipal, route } from '@/server/http';
import { markNotificationsRead, MarkReadSchema } from '@/server/modules/notifications/notifications';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/me/notifications/read — 標記已讀 { ids: uuid[] }（只影響本人的通知）或 { all: true } → { updated, unreadCount } */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json(await markNotificationsRead(db(), p.userId, await body(req, MarkReadSchema)));
});
