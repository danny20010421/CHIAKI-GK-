import { AppError } from '@/server/errors';
import { body, json, requirePrincipal, route } from '@/server/http';
import { PurchaseSchema, purchaseProduct } from '@/server/modules/catalog/catalog';
import { IdempotencyKeySchema } from '@/server/modules/draw/draw';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/me/purchases — 直購下單（代幣扣款，Idempotency-Key 必填） */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const key = req.headers.get('idempotency-key');
  if (!key) throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
  const b = await body(req, PurchaseSchema);
  const r = await purchaseProduct(p.userId, IdempotencyKeySchema.parse(key), b);
  return json(r, r.replayed ? 200 : 201);
});
