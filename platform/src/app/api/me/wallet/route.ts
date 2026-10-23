import { db } from '@/server/db';
import { json, query, requirePrincipal, route } from '@/server/http';
import { getCoinBreakdown, listLedger } from '@/server/modules/wallet/wallet';
import { listPaymentOrders } from '@/server/modules/payment/payments';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/me/wallet — CC幣餘額（可退款 + 不可退款）與交易明細（?before=<ledgerId> 分頁） */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const before = Number(query(req).get('before')) || undefined;
  const [b, ledger, orders] = await Promise.all([
    getCoinBreakdown(db(), p.userId),
    listLedger(db(), p.userId, 50, before),
    listPaymentOrders(db(), p.userId),
  ]);
  return json({
    currency: b.currency,
    coins: b.coins,
    refundableCoins: b.refundableCoins,
    nonRefundableCoins: b.nonRefundableCoins,
    coinBreakdown: b,
    ledger,
    paymentOrders: orders,
  });
});
