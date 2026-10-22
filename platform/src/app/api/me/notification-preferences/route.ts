import { db } from '@/server/db';
import { body, json, requirePrincipal, route } from '@/server/http';
import { getPreferences, PreferencesSchema, setPreferences } from '@/server/modules/notifications/outbox';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/me/notification-preferences — 各事件 × 管道（站內/簡訊/LINE/推播/Email）的通知設定 */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json(await getPreferences(db(), p.userId));
});

/** PUT /api/me/notification-preferences — { preferences: [{ channel, eventType | '*', enabled }] } */
export const PUT = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, PreferencesSchema);
  return json(await setPreferences(p.userId, b));
});
