import { AppError } from '../../errors';
import { config } from '../../config';
import { transaction, type Db, type Tx } from '../../db';
import { appendAudit } from '../audit/audit';
import { postLedger } from '../wallet/wallet';
import { memberCouponLabel, notifyCouponsIssued } from '../marketing/coupons';

/**
 * 綁定獎勵：每位會員每個任務只能領取一次（PK(user_id, task_code) 保證，並發安全）。
 * 任務完成驗證：BIND_PHONE 檢查手機已驗證；LINE 官方帳號/社群、IG 追蹤需串接官方 API，
 * 目前僅提供開發替身（REWARD_VERIFY_STUB=1），正式環境回傳 NOT_IMPLEMENTED。
 */
export type RewardTaskCode = 'BIND_LINE_OA' | 'JOIN_LINE_COMMUNITY' | 'FOLLOW_IG' | 'BIND_PHONE';

async function verifyTask(tx: Tx, userId: string, code: RewardTaskCode): Promise<void> {
  if (code === 'BIND_PHONE') {
    const [u] = await tx<{ phone: string | null }[]>`SELECT phone FROM users WHERE id = ${userId}`;
    if (!u?.phone) throw new AppError('INVALID_STATE', '尚未綁定手機');
    return;
  }
  if (!config().REWARD_VERIFY_STUB) throw new AppError('NOT_IMPLEMENTED', `${code} verification requires LINE/IG integration`);
}

export async function listRewardTasks(d: Db, userId: string) {
  return d<{ code: string; title: string; rewardCoins: number; couponCode: string | null; claimed: boolean; claimedAt: Date | null }[]>`
    SELECT t.code, t.title, t.reward_points AS reward_coins, t.coupon_code, (c.user_id IS NOT NULL) AS claimed, c.claimed_at
    FROM reward_tasks t LEFT JOIN reward_claims c ON c.task_code = t.code AND c.user_id = ${userId}
    WHERE t.active ORDER BY t.code`;
}

export async function claimReward(userId: string, code: RewardTaskCode, evidence?: string) {
  return transaction(async (tx) => {
    const [task] = await tx<{ code: RewardTaskCode; rewardPoints: number; couponCode: string | null; merchantId: string }[]>`
      SELECT code, reward_points, coupon_code, merchant_id FROM reward_tasks WHERE code = ${code} AND active`;
    if (!task) throw new AppError('NOT_FOUND', 'reward task not found');
    await verifyTask(tx, userId, code);
    const ins = await tx`
      INSERT INTO reward_claims (user_id, task_code, evidence) VALUES (${userId}, ${code}, ${evidence ?? null})
      ON CONFLICT DO NOTHING RETURNING task_code`;
    if (!ins.length) throw new AppError('ALREADY_CLAIMED', '此任務獎勵已領取');
    // 綁定/任務獎勵 → 不可退款 UC幣（reward_tasks.reward_points 欄位沿用舊名，單位為 UC幣）
    let coinsAfter: number | null = null;
    if (task.rewardPoints > 0) {
      coinsAfter = (await postLedger(tx, { userId, amount: task.rewardPoints, entryType: 'BIND_REWARD', refType: 'reward_claim', refId: `${userId}:${code}`, merchantId: task.merchantId })).balanceAfter;
    }
    if (task.couponCode) {
      // 任務贈券：代碼對應到有效的優惠券定義 → 連結（可於抽賞結帳使用）並通知；否則僅記錄（不可使用）
      const [def] = await tx<{ id: string; kind: 'pct' | 'amt'; value: number; expiresAt: Date | null }[]>`
        SELECT id, kind, value, expires_at FROM coupons WHERE code = ${task.couponCode} AND deleted_at IS NULL AND enabled AND kind IN ('pct', 'amt')`;
      const [uc] = await tx<{ id: string }[]>`
        INSERT INTO user_coupons (merchant_id, user_id, code, source, coupon_id) VALUES (${task.merchantId}, ${userId}, ${task.couponCode}, ${`reward:${code}`}, ${def?.id ?? null})
        ON CONFLICT DO NOTHING RETURNING id`;
      if (def && uc) {
        await tx`UPDATE coupons SET issued_count = issued_count + 1, updated_at = now() WHERE id = ${def.id}`;
        await notifyCouponsIssued(tx, { userId, merchantId: task.merchantId, labels: [memberCouponLabel(def.kind, def.value)], expiresAt: def.expiresAt, dedupeOn: { userCouponId: uc.id } });
      }
    }
    await appendAudit(tx, { actorType: 'USER', actorId: userId, action: 'REWARD_CLAIMED', entityType: 'reward_claim', entityId: `${userId}:${code}`, payload: { code, coins: task.rewardPoints, coupon: task.couponCode } });
    return { code, coins: task.rewardPoints, refundable: false, coupon: task.couponCode, coinsAfter };
  });
}
