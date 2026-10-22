import { z } from 'zod';
import { db } from '@/server/db';
import { body, json, requirePrincipal, route } from '@/server/http';
import { claimReward, listRewardTasks } from '@/server/modules/rewards/rewards';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const B = z.object({
  taskCode: z.enum(['BIND_LINE_OA', 'JOIN_LINE_COMMUNITY', 'FOLLOW_IG', 'BIND_PHONE']),
  evidence: z.string().max(500).optional(),
});

/** GET /api/me/rewards — 綁定獎勵任務與領取狀態 */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json({ tasks: await listRewardTasks(db(), p.userId) });
});

/** POST /api/me/rewards — 領取綁定獎勵（每人每任務一次） */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, B);
  return json(await claimReward(p.userId, b.taskCode, b.evidence), 201);
});
