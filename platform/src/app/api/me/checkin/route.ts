import { db } from '@/server/db';
import { json, requirePrincipal, route } from '@/server/http';
import { checkIn, getCheckinStatus } from '@/server/modules/checkin/checkin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/me/checkin — 本週簽到狀態（次數、今天是否已簽、7 格獎勵、下一次獎勵） */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json(await getCheckinStatus(db(), p.userId));
});

/** POST /api/me/checkin — 簽到（每個台灣日期一次；重複呼叫回傳當天結果、不重複入帳：首次 201，重複 200） */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const r = await checkIn(p.userId);
  return json(r, r.alreadyCheckedIn ? 200 : 201);
});
