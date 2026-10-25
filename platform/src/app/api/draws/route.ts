import { AppError } from '@/server/errors';
import { json, requirePrincipal, route } from '@/server/http';
import { executeDraw } from '@/server/modules/draw/draw';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/draws — 抽賞（原子交易）。必須帶 Idempotency-Key header；
 * 同鍵重送回傳相同結果且不重複扣款（回應 header Idempotent-Replayed: true）。
 * body: { poolId, setNo, ticketNos: number[] }（自選籤號）或 { poolId, setNo, count }（快速抽：count 須為該賞池 drawPacks 之一，
 * 1/3/5/10/20/100 或 'all'；伺服器以 CSPRNG 原子地挑選 N 張空籤，張數超過剩餘數則拒絕）；機率賞可加 clientSeed。
 * 選用 couponId（GET /api/me/coupons 的 id）：折抵小計，與抽賞同一交易標記已使用（失敗 rollback → 券仍可用；同券並發只成功一筆，
 * 其餘 422 COUPON_NOT_USABLE）。回應含 amountCoins（小計）、discountCoins、paidCoins（= totalCoins，實付）、coupon。
 * 抽完可在結果畫面以 POST /api/me/draws/:drawId/convert 把勾選的獎品轉換為不可退款 UC幣。
 */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new AppError('VALIDATION', 'body must be JSON');
  }
  const { response, replayed } = await executeDraw(p.userId, req.headers.get('idempotency-key'), raw);
  return json(response, replayed ? 200 : 201, replayed ? { 'idempotent-replayed': 'true' } : {});
}, { bot: 'DRAW' });
