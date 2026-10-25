import { db } from '@/server/db';
import { body, json, query, requirePrincipal, route } from '@/server/http';
import { listNotifications, markNotificationsRead, MarkReadSchema } from '@/server/modules/notifications/notifications';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/me/notifications?limit=20&cursor=<nextCursor>&unread=1 — 站內通知（新到舊、游標分頁）：
 * { notifications: [{ id, type, title, body, link, unread, readAt, createdAt, payload }], unreadCount, nextCursor|null }
 */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const q = query(req);
  return json(await listNotifications(db(), p.userId, { limit: q.has('limit') ? Number(q.get('limit')) : undefined, cursor: q.get('cursor') ?? undefined, unreadOnly: q.get('unread') === '1' }));
});

/** POST /api/me/notifications — 標記已讀（同 /api/me/notifications/read）{ ids: uuid[] } 或 { all: true } → { updated, unreadCount } */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json(await markNotificationsRead(db(), p.userId, await body(req, MarkReadSchema)));
});
