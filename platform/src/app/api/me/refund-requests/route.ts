import { z } from 'zod';
import { db } from '@/server/db';
import { body, json, requirePrincipal, route } from '@/server/http';
import { createRefundRequest, listRefundRequests } from '@/server/modules/wallet/refunds';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const B = z.object({ amountCoins: z.number().int().positive(), reason: z.string().max(500).default('') });

export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json({ requests: await listRefundRequests(db(), p.userId) });
});

/** POST /api/me/refund-requests — 申請未使用代幣退款（僅建立申請單，需後台雙人覆核） */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, B);
  return json(await createRefundRequest(p.userId, b.amountCoins, b.reason), 201);
});
