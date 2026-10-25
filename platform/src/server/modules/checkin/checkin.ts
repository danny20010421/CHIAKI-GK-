import { AppError } from '../../errors';
import { addDays, taipeiDay } from '../../lib/taipei';
import { db, transaction, type Db } from '../../db';
import { ensureWallet, NONREFUNDABLE_LABEL, postLedger } from '../wallet/wallet';

/**
 * 每日簽到（業主 2026-10 第十批：連續簽到）：
 *  - 以台灣時間（Asia/Taipei）的日曆日計；每天最多簽到一次。
 *  - 連續簽到：前一天有簽到 → 連續天數 +1；漏簽任何一天 → 從第 1 天重新開始。
 *  - 獎勵依連續天數在 7 天循環中的位置：第 1–6 天各 2 UC幣、第 7 天 10 UC幣，之後循環重新開始（第 8 天 = 第 1 格 2 UC幣…）。
 *    一律不可退款（帳本 CHECKIN）。
 *  - 冪等＋並發安全：同一會員的簽到以錢包列鎖序列化；member_checkins PK(user_id, day) 與帳本唯一索引
 *    (entry_type, ref_id = 會員:日期) 為第二、三道防線 → 同時送出兩次只入帳一次。
 */
export const CHECKIN_REWARDS = [2, 2, 2, 2, 2, 2, 10] as const;
export const CHECKIN_CYCLE = CHECKIN_REWARDS.length;

/** 連續第 streak 天在 7 天循環中的位置（1–7） */
export function cyclePosition(streak: number): number {
  if (!Number.isInteger(streak) || streak < 1) throw new Error(`invalid check-in streak ${streak}`);
  return ((streak - 1) % CHECKIN_CYCLE) + 1;
}

/** 連續第 streak 天的獎勵（UC幣） */
export function checkinReward(streak: number): number {
  return CHECKIN_REWARDS[cyclePosition(streak) - 1]!;
}

interface CheckinRow {
  day: string;
  streak: number;
  seq: number;
  coins: number;
}

async function recentCheckins(d: Db, userId: string, today: string): Promise<CheckinRow[]> {
  return d<CheckinRow[]>`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, streak, seq, coins FROM member_checkins
    WHERE user_id = ${userId} AND day <= ${today}::date ORDER BY day DESC LIMIT ${CHECKIN_CYCLE}`;
}

export async function getCheckinStatus(d: Db, userId: string, now: Date = new Date()) {
  const today = taipeiDay(now);
  const yesterday = addDays(today, -1);
  const rows = await recentCheckins(d, userId, today);
  const last = rows[0];
  const todayRow = last?.day === today ? last : null;
  // 目前仍有效的連續紀錄：今天已簽 → 含今天；否則昨天有簽 → 延續中；其餘 → 已中斷（0）
  const alive = todayRow ?? (last?.day === yesterday ? last : null);
  const streak = alive?.streak ?? 0;
  const nextStreak = todayRow ? todayRow.streak + 1 : streak + 1;
  const nextPos = cyclePosition(nextStreak);
  // 顯示中的循環：已簽的格子 = 目前連續紀錄在本循環中的天數；今天未簽且上一循環剛滿 7 天 → 顯示新循環（全空）
  const filled = alive ? (todayRow || nextPos !== 1 ? cyclePosition(alive.streak) : 0) : 0;
  const cycleRows = alive ? rows.slice(0, filled).reverse() : [];
  return {
    today,
    /** 連續簽到天數（含今天；今天未簽則為截至昨天；已中斷為 0） */
    streak,
    /** 目前連續紀錄在 7 天循環中的位置（1–7；0 = 尚無有效紀錄） */
    position: alive ? cyclePosition(alive.streak) : 0,
    todayDone: todayRow !== null,
    /** 上次簽到不是昨天或今天 → 連續已中斷，下次從第 1 天開始 */
    streakBroken: !alive && last !== undefined,
    lastCheckinDay: last?.day ?? null,
    slots: CHECKIN_REWARDS.map((coins, i) => {
      const r = cycleRows[i];
      return { seq: i + 1, coins, done: r !== undefined, day: r?.day ?? null };
    }),
    /** 下一次簽到（今天未簽 → 今天；今天已簽 → 明天，前提是明天有簽） */
    nextReward: { seq: nextPos, streak: nextStreak, coins: checkinReward(nextStreak), day: todayRow ? addDays(today, 1) : today, availableToday: todayRow === null },
    refundable: false,
    note: `簽到獎勵 UC幣${NONREFUNDABLE_LABEL}`,
    rule: '每天（台灣時間）可簽到一次；連續簽到第 1–6 天各得 2 UC幣、第 7 天得 10 UC幣，之後重新循環；漏簽一天即從第 1 天重新開始',
  };
}

/** 簽到（冪等：同一台灣日期重複呼叫回傳當天的結果，不重複入帳） */
export async function checkIn(userId: string, now: Date = new Date()) {
  const today = taipeiDay(now);
  const yesterday = addDays(today, -1);
  const result = await transaction(async (tx) => {
    const [u] = await tx<{ status: string }[]>`SELECT status FROM users WHERE id = ${userId}`;
    if (!u) throw new AppError('UNAUTHENTICATED', 'user not found');
    if (u.status !== 'ACTIVE') throw new AppError('FORBIDDEN', 'account suspended');
    await ensureWallet(tx, userId);
    await tx`SELECT 1 FROM wallets WHERE user_id = ${userId} FOR UPDATE`; // 同一會員的簽到序列化
    const [existing] = await tx<{ streak: number; seq: number; coins: number }[]>`
      SELECT streak, seq, coins FROM member_checkins WHERE user_id = ${userId} AND day = ${today}`;
    if (existing) return { alreadyCheckedIn: true, streak: existing.streak, seq: existing.seq, coins: existing.coins, coinsAfter: null as number | null };
    const [prev] = await tx<{ streak: number }[]>`SELECT streak FROM member_checkins WHERE user_id = ${userId} AND day = ${yesterday}`;
    const streak = prev ? prev.streak + 1 : 1;
    const seq = cyclePosition(streak);
    const coins = checkinReward(streak);
    const { ledgerId, balanceAfter } = await postLedger(tx, {
      userId,
      amount: coins,
      entryType: 'CHECKIN',
      refType: 'checkin',
      refId: `${userId}:${today}`,
      memo: `每日簽到 連續第 ${streak} 天（第 ${seq}/${CHECKIN_CYCLE} 格，不可退款 UC幣）`,
    });
    await tx`INSERT INTO member_checkins (user_id, day, streak, seq, coins, ledger_id) VALUES (${userId}, ${today}, ${streak}, ${seq}, ${coins}, ${ledgerId})`;
    return { alreadyCheckedIn: false, streak, seq, coins, coinsAfter: balanceAfter };
  });
  return { ...result, day: today, refundable: false, status: await getCheckinStatus(db(), userId, now) };
}
