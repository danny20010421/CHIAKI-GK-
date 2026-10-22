import { db } from '@/server/db';
import { json, query, requirePrincipal, route } from '@/server/http';
import { getWallet, listLedger } from '@/server/modules/wallet/wallet';
import { listPaymentOrders } from '@/server/modules/payment/payments';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/me/wallet — 代幣/點數餘額與交易明細（?before=<ledgerId> 分頁） */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const before = Number(query(req).get('before')) || undefined;
  const [wallet, ledger, orders] = await Promise.all([getWallet(db(), p.userId), listLedger(db(), p.userId, 50, before), listPaymentOrders(db(), p.userId)]);
  return json({ ...wallet, pointsNote: '平台點數不可提領或兌換現金', ledger, paymentOrders: orders });
});
