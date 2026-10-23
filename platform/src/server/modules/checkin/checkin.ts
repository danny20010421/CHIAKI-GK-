import { AppError } from '../../errors';
import { addDays, taipeiDay, taipeiWeekStart } from '../../lib/taipei';
import { db, transaction, type Db } from '../../db';
import { ensureWallet, NONREFUNDABLE_LABEL, postLedger } from '../wallet/wallet';

/**
 * 每日簽到（業主 2026-10 第八批）：
 *  - 以台灣時間計；每週一 00:00 起算新的一週（週一～週日），每個日曆日最多簽到一次。
 *  - 本週第 N 次簽到：N = 1–6 → 2 CC幣、N = 7 → 10 CC幣（一律不可退款，帳本 CHECKIN）。每週一歸零。
 *  - 冪等＋並發安全：同一會員的簽到以錢包列鎖序列化；member_checkins PK(user_id, day) 與帳本唯一索引
 *    (entry_type, ref_id = 會員:日期) 為第二、三道防線 → 同時送出兩次只入帳一次。
 */
export const CHECKIN_REWARDS = [2, 2, 2, 2, 2, 2, 10] as const;

export function checkinReward(seq: number): number {
  const r = CHECKIN_REWARDS[seq - 1];
  if (r === undefined) throw new Error(`invalid check-in seq ${seq}`);
  return r;
}

export async function getCheckinStatus(d: Db, userId: string, now: Date = new Date()) {
  const today = taipeiDay(now);
  const weekStart = taipeiWeekStart(now);
  const rows = await d<{ day: string; seq: number; coins: number }[]>`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, seq, coins FROM member_checkins
    WHERE user_id = ${userId} AND week_start = ${weekStart} ORDER BY seq`;
  const count = rows.length;
  const todayDone = rows.some((r) => r.day === today);
  const nextSeq = count < CHECKIN_REWARDS.length ? count + 1 : null;
  return {
    weekStart,
    weekEnd: addDays(weekStart, 6),
    today,
    count,
    todayDone,
    slots: CHECKIN_REWARDS.map((coins, i) => {
      const r = rows.find((x) => x.seq === i + 1);
      return { seq: i + 1, coins, done: !!r, day: r?.day ?? null };
    }),
    /** 下一次簽到可得（本週已簽滿 7 次 → null；今天已簽 → availableToday=false） */
    nextReward: nextSeq ? { seq: nextSeq, coins: checkinReward(nextSeq), availableToday: !todayDone } : null,
    refundable: false,
    note: `簽到獎勵 CC幣${NONREFUNDABLE_LABEL}`,
    rule: '每週一 00:00（台灣時間）重新計算；本週第 1–6 次簽到各得 2 CC幣，第 7 次得 10 CC幣；每天限簽到一次',
  };
}

/** 簽到（冪等：同一台灣日期重複呼叫回傳當天的結果，不重複入帳） */
export async function checkIn(userId: string, now: Date = new Date()) {
  const today = taipeiDay(now);
  const weekStart = taipeiWeekStart(now);
  const result = await transaction(async (tx) => {
    const [u] = await tx<{ status: string }[]>`SELECT status FROM users WHERE id = ${userId}`;
    if (!u) throw new AppError('UNAUTHENTICATED', 'user not found');
    if (u.status !== 'ACTIVE') throw new AppError('FORBIDDEN', 'account suspended');
    await ensureWallet(tx, userId);
    await tx`SELECT 1 FROM wallets WHERE user_id = ${userId} FOR UPDATE`; // 同一會員的簽到序列化
    const [existing] = await tx<{ seq: number; coins: number }[]>`SELECT seq, coins FROM member_checkins WHERE user_id = ${userId} AND day = ${today}`;
    if (existing) return { alreadyCheckedIn: true, seq: existing.seq, coins: existing.coins, coinsAfter: null as number | null };
    const [c] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM member_checkins WHERE user_id = ${userId} AND week_start = ${weekStart}`;
    const seq = c!.n + 1;
    if (seq > CHECKIN_REWARDS.length) throw new Error('invariant violated: more than 7 check-ins in a week');
    const coins = checkinReward(seq);
    const { ledgerId, balanceAfter } = await postLedger(tx, {
      userId,
      amount: coins,
      entryType: 'CHECKIN',
      refType: 'checkin',
      refId: `${userId}:${today}`,
      memo: `每日簽到 本週第 ${seq} 天（不可退款）`,
    });
    await tx`INSERT INTO member_checkins (user_id, day, week_start, seq, coins, ledger_id) VALUES (${userId}, ${today}, ${weekStart}, ${seq}, ${coins}, ${ledgerId})`;
    return { alreadyCheckedIn: false, seq, coins, coinsAfter: balanceAfter };
  });
  return { ...result, day: today, refundable: false, status: await getCheckinStatus(db(), userId, now) };
}
