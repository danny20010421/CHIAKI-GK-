import { z } from 'zod';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { PrizeItemSchema } from '@/server/modules/pool/admin';
import { createPrizeItem } from '@/server/modules/pool/structure';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/pools/:id/levels/:levelNo/items — 新增獎項 { name, qtyPerSet, recycleValue?, recyclable?, tag?, bulky?, imageUrl? }（只在草稿） */
export const POST = route(async (req: Request, ctx: RouteContext<{ id: string; levelNo: string }>) => {
  const p = await requirePrincipal(req);
  const { id, levelNo } = await ctx.params;
  const b = await body(req, PrizeItemSchema);
  return json(await createPrizeItem(p, id, z.coerce.number().int().min(1).max(8).parse(levelNo), b), 201);
});
