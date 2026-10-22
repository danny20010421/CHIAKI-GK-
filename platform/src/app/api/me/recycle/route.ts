import { z } from 'zod';
import { body, json, requirePrincipal, route } from '@/server/http';
import { ItemIdsSchema, recycleItems } from '@/server/modules/warehouse/warehouse';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const B = z.object({ itemIds: ItemIdsSchema });

/** POST /api/me/recycle — 回收獎品換平台點數（不可逆；點數不可提領） */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, B);
  return json(await recycleItems(p.userId, b.itemIds));
});
