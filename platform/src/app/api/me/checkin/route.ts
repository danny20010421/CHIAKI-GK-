import { db } from '@/server/db';
import { json, requirePrincipal, route } from '@/server/http';
import { checkIn, getCheckinStatus } from '@/server/modules/checkin/checkin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/me/checkin — 連續簽到狀態：
 * { today, streak, position（1–7，0=無有效紀錄）, todayDone, streakBroken, lastCheckinDay,
 *   slots: [{ seq, coins, done, day }]×7, nextReward: { seq, streak, coins, day, availableToday }, refundable:false, note, rule }
 */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json(await getCheckinStatus(db(), p.userId));
});

/** POST /api/me/checkin — 簽到（每個台灣日期一次；重複呼叫回傳當天結果、不重複入帳：首次 201，重複 200）→ { alreadyCheckedIn, streak, seq, coins, coinsAfter, day, refundable, status } */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const r = await checkIn(p.userId);
  return json(r, r.alreadyCheckedIn ? 200 : 201);
});
