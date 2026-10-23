import { z } from 'zod';
import { AppError } from '@/server/errors';
import { body, json, requirePrincipal, route } from '@/server/http';
import { ItemIdsSchema, recycleItems } from '@/server/modules/warehouse/warehouse';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const B = z.object({ itemIds: ItemIdsSchema });
const Key = z.string().regex(/^[A-Za-z0-9_\-:.]{8,128}$/, 'Idempotency-Key must be 8-128 chars [A-Za-z0-9_-:.]');

/**
 * POST /api/me/recycle — 回收獎品換不可退款 CC幣（不可逆；不可申請退款）。
 * 每回收一件小獎另退還 運費 ÷ N 代幣（不可退款）。可帶 Idempotency-Key：同鍵重送回傳同一結果（200 + Idempotent-Replayed）。
 */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, B);
  const rawKey = req.headers.get('idempotency-key');
  const parsed = rawKey === null ? null : Key.safeParse(rawKey);
  if (parsed && !parsed.success) throw new AppError('VALIDATION', parsed.error.issues[0]!.message);
  const r = await recycleItems(p.userId, b.itemIds, { idempotencyKey: parsed?.data ?? null });
  return json(r, 200, r.replayed ? { 'idempotent-replayed': 'true' } : {});
});
