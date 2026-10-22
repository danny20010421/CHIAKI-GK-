import { AppError } from '../../errors';
import { transaction, type Db, type Tx } from '../../db';
import { appendAudit } from '../audit/audit';
import { postLedger } from './wallet';
import { notifyEvent } from '../notifications/outbox';

/**
 * 未使用儲值代幣退款：僅建立「申請單」（工作流程紀錄），不自動退款。
 * 退款條件/手續費/時限待法遵確認；核准走雙人覆核（admin approvals → executeRefund）。
 */
export interface RefundRequest {
  id: string;
  userId: string;
  amountCoins: number;
  reason: string;
  status: 'REQUESTED' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'PAID';
  createdAt: Date;
  decidedAt: Date | null;
}

export async function createRefundRequest(userId: string, amountCoins: number, reason: string): Promise<RefundRequest> {
  return transaction(async (tx) => {
    // 可退款餘額 = 代幣 − 不可退款代幣（例如寄存到期自動轉換的代幣）
    const [w] = await tx<{ refundable: number }[]>`SELECT coins - nonrefundable_coins AS refundable FROM wallets WHERE user_id = ${userId} FOR UPDATE`;
    if (!w) throw new AppError('NOT_FOUND', 'wallet not found');
    const [o] = await tx<{ open: number }[]>`
      SELECT COALESCE(SUM(amount_coins), 0)::bigint AS open FROM refund_requests
      WHERE user_id = ${userId} AND status IN ('REQUESTED', 'PENDING_APPROVAL')`;
    if (o!.open + amountCoins > w.refundable) {
      throw new AppError('INSUFFICIENT_FUNDS', '申請金額超過可退款代幣', { refundable: w.refundable - o!.open });
    }
    const [r] = await tx<RefundRequest[]>`
      INSERT INTO refund_requests (user_id, amount_coins, reason) VALUES (${userId}, ${amountCoins}, ${reason})
      RETURNING id, user_id, amount_coins, reason, status, created_at, decided_at`;
    await appendAudit(tx, {
      actorType: 'USER',
      actorId: userId,
      action: 'REFUND_REQUESTED',
      entityType: 'refund_request',
      entityId: r!.id,
      payload: { amountCoins },
    });
    return r!;
  });
}

export async function listRefundRequests(db: Db, userId: string): Promise<RefundRequest[]> {
  return db<RefundRequest[]>`
    SELECT id, user_id, amount_coins, reason, status, created_at, decided_at
    FROM refund_requests WHERE user_id = ${userId} ORDER BY created_at DESC`;
}

/** 由雙人覆核核准後執行：扣除代幣（REFUND_DEBIT）。實際撥款由財務線下處理後標記 PAID。 */
export async function executeRefund(tx: Tx, refundId: string, approverId: string): Promise<Record<string, unknown>> {
  const [r] = await tx<{ id: string; userId: string; amountCoins: number; status: string }[]>`
    SELECT id, user_id, amount_coins, status FROM refund_requests WHERE id = ${refundId} FOR UPDATE`;
  if (!r) throw new AppError('NOT_FOUND', 'refund request not found');
  if (r.status !== 'PENDING_APPROVAL') throw new AppError('INVALID_STATE', `refund is ${r.status}`);
  const { balanceAfter, ledgerId } = await postLedger(tx, {
    userId: r.userId,
    currency: 'COINS',
    amount: -r.amountCoins,
    entryType: 'REFUND_DEBIT',
    refType: 'refund_request',
    refId: r.id,
    createdBy: approverId,
  });
  await tx`UPDATE refund_requests SET status = 'APPROVED', decided_by = ${approverId}, decided_at = now() WHERE id = ${r.id}`;
  await notifyEvent(tx, {
    userId: r.userId,
    event: 'REFUND_STATUS',
    data: { kindLabel: '代幣退款', amountLabel: `${r.amountCoins} 代幣`, statusLabel: '已核准，將於撥款後通知' },
    payload: { refundId: r.id, status: 'APPROVED' },
    dedupeOn: { refundId: r.id, status: 'APPROVED' },
  });
  return { refundId: r.id, userId: r.userId, amountCoins: r.amountCoins, ledgerId, balanceAfter };
}
