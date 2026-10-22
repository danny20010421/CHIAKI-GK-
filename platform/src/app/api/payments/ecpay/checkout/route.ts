import { body, json, requirePrincipal, route } from '@/server/http';
import { CheckoutSchema, createEcpayCheckout } from '@/server/modules/payment/payments';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/payments/ecpay/checkout — 建立儲值訂單，回傳要 POST 到綠界的表單參數 */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, CheckoutSchema);
  return json(await createEcpayCheckout(p.userId, b), 201);
});
