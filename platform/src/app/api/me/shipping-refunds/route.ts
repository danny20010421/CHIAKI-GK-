import { db } from '@/server/db';
import { body, json, requirePrincipal, route } from '@/server/http';
import { CashRefundRequestSchema, createCashRefundRequest, listMyShippingRefunds, listRefundableShippingFees } from '@/server/modules/shipping/shipping-refunds';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/me/shipping-refunds — 可退還（多收）的預收運費與我的運費退還紀錄 */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const [refundable, history] = await Promise.all([listRefundableShippingFees(p.userId), listMyShippingRefunds(db(), p.userId)]);
  return json({ ...refundable, refunds: history });
});

/**
 * POST /api/me/shipping-refunds — 申請多收運費的新台幣退款（銀行轉帳或綠界刷退；需財務核准＋另一人撥款）。
 * 同一份運費重複申請回傳同一筆（200）；已退為代幣者 409。
 */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, CashRefundRequestSchema);
  const r = await createCashRefundRequest(p.userId, b);
  return json(r, r.replayed ? 200 : 201);
});
