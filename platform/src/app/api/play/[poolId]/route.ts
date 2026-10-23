import { db } from '@/server/db';
import { json, query, route, type RouteContext } from '@/server/http';
import { clientIp } from '@/server/security/ip';
import { enforceFreePlayLimit, freePlay } from '@/server/modules/play/play';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET/POST /api/play/:poolId?count=1|5|10 — 免費試玩（不需登入；每 IP 每分鐘上限 FREE_PLAY_PER_MIN，預設 30）。
 * 依目前開賣中那一套的剩餘分布模擬抽出結果，回應 demo: true；不動庫存、帳本、倉庫，不列入抽賞紀錄。
 */
async function play(req: Request, ctx: RouteContext<{ poolId: string }>): Promise<Response> {
  await enforceFreePlayLimit(clientIp(req));
  const { poolId } = await ctx.params;
  return json(await freePlay(db(), poolId, query(req).get('count') ?? undefined));
}

export const GET = route(play);
export const POST = route(play);
