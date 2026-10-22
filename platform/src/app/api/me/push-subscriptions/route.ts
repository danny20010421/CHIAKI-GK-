import { z } from 'zod';
import { body, json, requirePrincipal, route } from '@/server/http';
import { PushSubscriptionSchema, revokePushSubscription, savePushSubscription } from '@/server/modules/notifications/outbox';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/me/push-subscriptions — 儲存 Web Push 訂閱（PushSubscription.toJSON()） */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, PushSubscriptionSchema);
  return json(await savePushSubscription(p.userId, b, req.headers.get('user-agent')), 201);
});

/** DELETE /api/me/push-subscriptions — 取消訂閱 { endpoint } */
export const DELETE = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, z.object({ endpoint: z.string().url() }));
  return json(await revokePushSubscription(p.userId, b.endpoint));
});
