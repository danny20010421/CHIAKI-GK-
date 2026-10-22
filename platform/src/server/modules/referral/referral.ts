import { randomInt } from 'node:crypto';
import { config } from '../../config';
import { canonicalJson } from '../../lib/canonical';
import { db, type Db, type Tx } from '../../db';
import { appendAudit, type AuditEntry } from '../audit/audit';
import { postLedger } from '../wallet/wallet';
import { notifyEvent } from '../notifications/outbox';

/**
 * 邀請碼與邀請獎勵（業主規則）：
 *  - 每位會員有一組邀請碼（首次查詢時產生）。
 *  - 被邀請者以邀請碼「成功註冊並完成手機驗證」→ 計為有效邀請（QUALIFIED）。
 *  - 有效邀請達 REFERRAL_REWARD_THRESHOLD（20）人 → 邀請人獲得 REFERRAL_REWARD_COINS（1000）「不可退款」代幣，每人僅一次
 *    （referral_rewards PK = inviter_id；計數以鎖定邀請人的 referral_codes 列序列化，並發安全、冪等）。
 *  - 防濫用（標記 FLAGGED、寫 REFERRAL_ABUSE 風控事件、不計入）：
 *      與邀請人相同裝置指紋 / 同一邀請人底下重複的裝置指紋；
 *      手機號碼前 REFERRAL_PHONE_PREFIX_LEN 碼相同者已達 REFERRAL_PHONE_PREFIX_MAX 人（連號人頭門號）；
 *      同一 IP 在 REFERRAL_IP_BURST_WINDOW_MIN 分鐘內已有 REFERRAL_IP_BURST_MAX 筆註冊（短時間大量註冊）。
 *    被標記者可由客服人工審查（目前無自動解除流程）。
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

export async function getOrCreateReferralCode(d: Db, userId: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const [existing] = await d<{ code: string }[]>`SELECT code FROM referral_codes WHERE user_id = ${userId}`;
    if (existing) return existing.code;
    const ins = await d<{ code: string }[]>`INSERT INTO referral_codes (user_id, code) VALUES (${userId}, ${newCode()}) ON CONFLICT DO NOTHING RETURNING code`;
    if (ins[0]) return ins[0].code;
  }
  throw new Error('could not allocate referral code');
}

export type ReferralStatus = 'PENDING' | 'QUALIFIED' | 'FLAGGED' | 'INVALID_CODE';

export async function registerReferral(
  tx: Tx,
  a: { inviteeId: string; inviteCode: string; phone: string | null; ip: string | null; deviceFingerprint: string | null },
): Promise<{ status: ReferralStatus; reasons?: string[] }> {
  const c = config();
  const code = a.inviteCode.trim().toUpperCase();
  // 鎖定邀請人的邀請碼列：同一邀請人的計數與發獎序列化
  const [rc] = await tx<{ userId: string }[]>`SELECT user_id FROM referral_codes WHERE code = ${code} FOR UPDATE`;
  if (!rc || rc.userId === a.inviteeId) return { status: 'INVALID_CODE' };
  const inviterId = rc.userId;
  const reasons: string[] = [];
  if (a.deviceFingerprint) {
    const [same] = await tx`SELECT 1 FROM user_devices WHERE user_id = ${inviterId} AND fingerprint = ${a.deviceFingerprint}`;
    if (same) reasons.push('SAME_DEVICE_AS_INVITER');
    const [reused] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM referrals WHERE inviter_id = ${inviterId} AND device_fingerprint = ${a.deviceFingerprint}`;
    if (reused!.n > 0) reasons.push('DEVICE_REUSED');
  }
  if (a.phone) {
    const prefix = a.phone.slice(0, c.REFERRAL_PHONE_PREFIX_LEN);
    const [p] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM referrals WHERE inviter_id = ${inviterId} AND left(phone, ${c.REFERRAL_PHONE_PREFIX_LEN}) = ${prefix}`;
    if (p!.n >= c.REFERRAL_PHONE_PREFIX_MAX) reasons.push('PHONE_PREFIX_CLUSTER');
  }
  if (a.ip && a.ip !== 'unknown') {
    const [b] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM referrals WHERE signup_ip = ${a.ip}
        AND created_at > now() - make_interval(mins => ${c.REFERRAL_IP_BURST_WINDOW_MIN})`;
    if (b!.n >= c.REFERRAL_IP_BURST_MAX) reasons.push('IP_BURST');
  }
  const [u] = await tx<{ phoneVerified: boolean }[]>`SELECT phone_verified_at IS NOT NULL AS phone_verified FROM users WHERE id = ${a.inviteeId}`;
  const status: ReferralStatus = reasons.length ? 'FLAGGED' : u?.phoneVerified ? 'QUALIFIED' : 'PENDING';
  await tx`
    INSERT INTO referrals (invitee_id, inviter_id, code, status, flag_reasons, signup_ip, device_fingerprint, phone, qualified_at)
    VALUES (${a.inviteeId}, ${inviterId}, ${code}, ${status}, ${canonicalJson(reasons)}, ${a.ip}, ${a.deviceFingerprint}, ${a.phone},
            ${status === 'QUALIFIED' ? new Date() : null})`;
  if (status === 'FLAGGED') {
    await tx`INSERT INTO risk_events (user_id, type, severity, details_json, ip)
             VALUES (${a.inviteeId}, 'REFERRAL_ABUSE', 'MEDIUM', ${canonicalJson({ inviterId, reasons })}, ${a.ip})`;
  }
  // 鎖順序：referral_codes → 錢包 → 稽核（audit_head 必須最後取得）
  const granted = status === 'QUALIFIED' ? await maybeGrantReferralReward(tx, inviterId) : null;
  await appendAudit(tx, { actorType: 'USER', actorId: a.inviteeId, action: 'REFERRAL_REGISTERED', entityType: 'referral', entityId: a.inviteeId, payload: { inviterId, status, reasons } });
  if (granted) await appendAudit(tx, granted);
  return { status, ...(reasons.length ? { reasons } : {}) };
}

/** 尚未完成手機驗證的邀請（例如日後以 LINE 註冊）在完成手機驗證時轉為有效 */
export async function qualifyPendingReferral(tx: Tx, inviteeId: string): Promise<boolean> {
  const [r] = await tx<{ inviterId: string }[]>`SELECT inviter_id FROM referrals WHERE invitee_id = ${inviteeId} AND status = 'PENDING'`;
  if (!r) return false;
  await tx`SELECT 1 FROM referral_codes WHERE user_id = ${r.inviterId} FOR UPDATE`;
  const upd = await tx`UPDATE referrals SET status = 'QUALIFIED', qualified_at = now() WHERE invitee_id = ${inviteeId} AND status = 'PENDING' RETURNING invitee_id`;
  if (!upd.length) return false;
  const granted = await maybeGrantReferralReward(tx, r.inviterId);
  if (granted) await appendAudit(tx, granted);
  return true;
}

/** 呼叫端須已鎖定邀請人的 referral_codes 列。回傳待寫入的稽核紀錄（由呼叫端最後寫入，維持鎖順序）。 */
async function maybeGrantReferralReward(tx: Tx, inviterId: string): Promise<AuditEntry | null> {
  const c = config();
  const [cnt] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM referrals WHERE inviter_id = ${inviterId} AND status = 'QUALIFIED'`;
  if (cnt!.n < c.REFERRAL_REWARD_THRESHOLD) return null;
  const [done] = await tx`SELECT 1 FROM referral_rewards WHERE inviter_id = ${inviterId}`;
  if (done) return null;
  const { ledgerId, balanceAfter } = await postLedger(tx, {
    userId: inviterId,
    currency: 'COINS',
    amount: c.REFERRAL_REWARD_COINS,
    entryType: 'REFERRAL_REWARD',
    refType: 'referral_reward',
    refId: inviterId,
    memo: `邀請 ${c.REFERRAL_REWARD_THRESHOLD} 位好友完成註冊與手機驗證`,
  });
  await tx`INSERT INTO referral_rewards (inviter_id, milestone, coins, ledger_id) VALUES (${inviterId}, ${c.REFERRAL_REWARD_THRESHOLD}, ${c.REFERRAL_REWARD_COINS}, ${ledgerId})`;
  await notifyEvent(tx, {
    userId: inviterId,
    event: 'REFERRAL_REWARD',
    data: { count: c.REFERRAL_REWARD_THRESHOLD, coins: c.REFERRAL_REWARD_COINS },
    payload: { coins: c.REFERRAL_REWARD_COINS },
    dedupeOn: { referralReward: inviterId },
  });
  return {
    actorType: 'SYSTEM',
    actorId: 'referral',
    action: 'REFERRAL_REWARD_GRANTED',
    entityType: 'user',
    entityId: inviterId,
    payload: { coins: c.REFERRAL_REWARD_COINS, qualified: cnt!.n, ledgerId, coinsAfter: balanceAfter, refundable: false },
  };
}

export async function getReferralSummary(userId: string) {
  const c = config();
  const code = await getOrCreateReferralCode(db(), userId);
  const [s] = await db()<{ qualified: number; pending: number; flagged: number }[]>`
    SELECT count(*) FILTER (WHERE status = 'QUALIFIED')::int AS qualified,
           count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
           count(*) FILTER (WHERE status = 'FLAGGED')::int AS flagged
    FROM referrals WHERE inviter_id = ${userId}`;
  const [reward] = await db()<{ coins: number; grantedAt: Date }[]>`SELECT coins, granted_at FROM referral_rewards WHERE inviter_id = ${userId}`;
  return {
    code,
    threshold: c.REFERRAL_REWARD_THRESHOLD,
    rewardCoins: c.REFERRAL_REWARD_COINS,
    qualified: s!.qualified,
    pending: s!.pending,
    flagged: s!.flagged,
    remaining: Math.max(0, c.REFERRAL_REWARD_THRESHOLD - s!.qualified),
    reward: reward ? { coins: reward.coins, grantedAt: reward.grantedAt, refundable: false } : null,
    rule: `邀請 ${c.REFERRAL_REWARD_THRESHOLD} 位好友完成註冊與手機驗證，可獲得 ${c.REFERRAL_REWARD_COINS} 代幣（不可退款・無法轉換，每人限一次）`,
  };
}
