import { z } from 'zod';
import { body, json, requirePrincipal, route } from '@/server/http';
import { createBankTransferOrder } from '@/server/modules/payment/payments';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const B = z.object({ packageCode: z.string().min(1).max(20), bankLast5: z.string().regex(/^\d{5}$/).optional() });

/** POST /api/payments/bank-transfer — 建立銀行轉帳（人工對帳）訂單 */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, B);
  return json(await createBankTransferOrder(p.userId, b), 201);
});
