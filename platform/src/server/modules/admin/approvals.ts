import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../errors';
import { canonicalJson } from '../../lib/canonical';
import { db, transaction, type Db, type Tx } from '../../db';
import { appendAudit } from '../audit/audit';
import { hasPermission, requirePermission, type Permission, type Principal } from '../auth/rbac';
import { assertPublishable, publishPool, publishRuleVersion } from '../pool/admin';
import { executeRefund } from '../wallet/refunds';
import { postLedger } from '../wallet/wallet';
import { executeBankTransferConfirm } from '../payment/payments';
import { notifyEvent } from '../notifications/outbox';

/**
 * 高風險後台動作採「雙人覆核」：A 提出申請 → 另一位具核准權限的 B 核准後才「在同一交易內」執行。
 * 資料庫另有 CHECK (decided_by <> requested_by) 作為最後防線。
 */
export type ApprovalType = 'PUBLISH_POOL' | 'PUBLISH_RULE_VERSION' | 'REFUND' | 'BALANCE_ADJUST' | 'BANK_TRANSFER_CONFIRM' | 'CS_COMPENSATION';

const APPROVE_PERMISSION: Record<ApprovalType, Permission> = {
  PUBLISH_POOL: 'pool.publish.approve',
  PUBLISH_RULE_VERSION: 'pool.publish.approve',
  REFUND: 'refund.approve',
  BALANCE_ADJUST: 'wallet.adjust.approve',
  BANK_TRANSFER_CONFIRM: 'payment.bank.confirm.approve',
  CS_COMPENSATION: 'cs.compensation.approve',
};

interface ApprovalRow {
  id: string;
  type: ApprovalType;
  targetId: string;
  payloadJson: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  requestedBy: string;
  decidedBy: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  resultJson: string | null;
}

export async function createApproval(tx: Tx, actor: Principal, type: ApprovalType, targetId: string, payload: Record<string, unknown>): Promise<{ approvalId: string }> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO approval_requests (type, target_id, payload_json, requested_by)
    VALUES (${type}, ${targetId}, ${canonicalJson(payload)}, ${actor.userId})
    ON CONFLICT (type, target_id) WHERE status = 'PENDING' DO NOTHING
    RETURNING id`;
  if (!rows[0]) throw new AppError('CONFLICT', 'a pending approval already exists for this target');
  await appendAudit(tx, { actorType: 'ADMIN', actorId: actor.userId, action: 'APPROVAL_REQUESTED', entityType: 'approval_request', entityId: rows[0].id, payload: { type, targetId, ...payload } });
  return { approvalId: rows[0].id };
}

// ───────────── 申請 ─────────────

export async function requestPoolPublish(actor: Principal, poolId: string) {
  requirePermission(actor, 'pool.publish.request');
  return transaction(async (tx) => {
    const upd = await tx`UPDATE pools SET status = 'PENDING_PUBLISH' WHERE id = ${poolId} AND status = 'DRAFT' AND deleted_at IS NULL RETURNING id`;
    if (!upd.length) throw new AppError('INVALID_STATE', 'pool must be DRAFT to request publish');
    await assertPublishable(tx, poolId);
    return createApproval(tx, actor, 'PUBLISH_POOL', poolId, {});
  });
}

export async function requestRuleVersionPublish(actor: Principal, ruleVersionId: string) {
  requirePermission(actor, 'pool.publish.request');
  return transaction(async (tx) => {
    const [rv] = await tx<{ publishedAt: Date | null }[]>`SELECT published_at FROM pool_rule_versions WHERE id = ${ruleVersionId}`;
    if (!rv) throw new AppError('NOT_FOUND', 'rule version not found');
    if (rv.publishedAt) throw new AppError('INVALID_STATE', 'already published');
    return createApproval(tx, actor, 'PUBLISH_RULE_VERSION', ruleVersionId, {});
  });
}

/**
 * 人工調整 CC幣（雙人覆核）。只有一種貨幣：currency 可省略或為 COINS；舊的 POINTS（平台點數）視為「不可退款 CC幣」。
 * refundable：入帳是否計入可退款餘額（預設 true；扣款不適用）。
 */
export const BalanceAdjustSchema = z
  .object({
    userId: z.string().uuid(),
    currency: z.enum(['COINS', 'POINTS']).default('COINS'),
    amount: z.number().int().refine((n) => n !== 0 && Math.abs(n) <= 10_000_000, 'non-zero, |amount| <= 10,000,000'),
    refundable: z.boolean().optional(),
    memo: z.string().min(3).max(500),
  })
  .refine((v) => v.amount > 0 || v.refundable === undefined, 'refundable only applies to credits')
  .transform(({ currency, ...v }) => ({ ...v, currency: 'COINS' as const, refundable: v.amount > 0 ? (currency === 'POINTS' ? false : (v.refundable ?? true)) : undefined }));

export async function requestBalanceAdjust(actor: Principal, input: z.input<typeof BalanceAdjustSchema>) {
  requirePermission(actor, 'wallet.adjust.request');
  const v = BalanceAdjustSchema.parse(input);
  return transaction(async (tx) => {
    const [w] = await tx`SELECT 1 FROM wallets WHERE user_id = ${v.userId}`;
    if (!w) throw new AppError('NOT_FOUND', 'wallet not found');
    // 每筆調整都是獨立目標（以 uuid 為 target_id），允許同一使用者多筆待審
    return createApproval(tx, actor, 'BALANCE_ADJUST', randomUUID(), v);
  });
}

export async function decideRefundRequest(actor: Principal, refundId: string, decision: 'APPROVE' | 'REJECT', note?: string) {
  requirePermission(actor, 'refund.decide');
  return transaction(async (tx) => {
    const [r] = await tx<{ status: string; userId: string; amountCoins: number }[]>`
      SELECT status, user_id, amount_coins FROM refund_requests WHERE id = ${refundId} FOR UPDATE`;
    if (!r) throw new AppError('NOT_FOUND', 'refund request not found');
    if (r.status !== 'REQUESTED') throw new AppError('INVALID_STATE', `refund is ${r.status}`);
    if (decision === 'REJECT') {
      await tx`UPDATE refund_requests SET status = 'REJECTED', decided_by = ${actor.userId}, decided_at = now() WHERE id = ${refundId}`;
      await notifyEvent(tx, {
        userId: r.userId,
        event: 'REFUND_STATUS',
        data: { kindLabel: '代幣退款', amountLabel: `${r.amountCoins} 代幣`, statusLabel: '已駁回', note: note ?? null },
        payload: { refundId, status: 'REJECTED' },
        dedupeOn: { refundId, status: 'REJECTED' },
      });
      await appendAudit(tx, { actorType: 'ADMIN', actorId: actor.userId, action: 'REFUND_REJECTED', entityType: 'refund_request', entityId: refundId, payload: { note: note ?? null } });
      return { refundId, status: 'REJECTED' as const };
    }
    const a = await createApproval(tx, actor, 'REFUND', refundId, { userId: r.userId, amountCoins: r.amountCoins });
    await tx`UPDATE refund_requests SET status = 'PENDING_APPROVAL', approval_request_id = ${a.approvalId} WHERE id = ${refundId}`;
    return { refundId, status: 'PENDING_APPROVAL' as const, approvalId: a.approvalId };
  });
}

export async function requestBankTransferConfirm(actor: Principal, orderId: string) {
  requirePermission(actor, 'payment.bank.confirm.request');
  return transaction(async (tx) => {
    const [o] = await tx<{ provider: string; status: string; amountTwd: number; userId: string }[]>`
      SELECT provider, status, amount_twd, user_id FROM payment_orders WHERE id = ${orderId}`;
    if (!o) throw new AppError('NOT_FOUND', 'order not found');
    if (o.provider !== 'BANK_TRANSFER' || o.status !== 'PENDING') throw new AppError('INVALID_STATE', 'order is not a pending bank transfer');
    return createApproval(tx, actor, 'BANK_TRANSFER_CONFIRM', orderId, { userId: o.userId, amountTwd: o.amountTwd });
  });
}

/** 客服補償（CC幣，不可退款）。舊的待審 payload 以 points 表示，視為 coins。 */
export const CompensationSchema = z.preprocess(
  (x) => (x && typeof x === 'object' && !('coins' in x) && 'points' in x ? { ...(x as Record<string, unknown>), coins: (x as { points: unknown }).points } : x),
  z.object({
    userId: z.string().uuid(),
    coins: z.number().int().positive().max(1_000_000),
    memo: z.string().min(2).max(500),
    ticketId: z.string().uuid().optional(),
  }),
);

/** 客服補償（CS_COMPENSATION → 不可退款 CC幣）。由 cs 模組依門檻決定直接入帳或走雙人覆核。 */
export async function postCompensation(tx: Tx, v: z.infer<typeof CompensationSchema>, actorId: string, refType: string, refId: string) {
  const r = await postLedger(tx, { userId: v.userId, amount: v.coins, entryType: 'CS_COMPENSATION', refType, refId, memo: v.memo, createdBy: actorId });
  return { userId: v.userId, coins: v.coins, refundable: false, ...r };
}

// ───────────── 覆核 ─────────────

async function execute(tx: Tx, a: ApprovalRow, approverId: string): Promise<Record<string, unknown>> {
  const payload = JSON.parse(a.payloadJson) as Record<string, unknown>;
  switch (a.type) {
    case 'PUBLISH_POOL':
      return publishPool(tx, a.targetId, approverId);
    case 'PUBLISH_RULE_VERSION':
      return publishRuleVersion(tx, a.targetId, approverId);
    case 'REFUND':
      return executeRefund(tx, a.targetId, approverId);
    case 'BANK_TRANSFER_CONFIRM':
      return executeBankTransferConfirm(tx, a.targetId, approverId);
    case 'CS_COMPENSATION': {
      const v = CompensationSchema.parse(payload);
      const r = await postCompensation(tx, v, approverId, 'approval_request', a.id);
      if (v.ticketId) {
        await tx`INSERT INTO cs_messages (ticket_id, author_type, author_id, body, internal)
                 VALUES (${v.ticketId}, 'SYSTEM', ${approverId}, ${`補償 ${v.coins} CC幣已核准入帳（覆核 ${a.id}）`}, true)`;
      }
      return r;
    }
    case 'BALANCE_ADJUST': {
      const v = BalanceAdjustSchema.parse(payload);
      const r = await postLedger(tx, {
        userId: v.userId,
        amount: v.amount,
        entryType: 'ADMIN_ADJUST',
        refType: 'approval_request',
        refId: a.id,
        memo: v.memo,
        createdBy: approverId,
        ...(v.refundable !== undefined ? { refundable: v.refundable } : {}),
      });
      return { userId: v.userId, currency: v.currency, amount: v.amount, refundable: v.refundable ?? null, ...r };
    }
  }
}

async function lockPending(tx: Tx, approvalId: string, approver: Principal): Promise<ApprovalRow> {
  const [a] = await tx<ApprovalRow[]>`
    SELECT id, type, target_id, payload_json, status, requested_by, decided_by, created_at, decided_at, result_json
    FROM approval_requests WHERE id = ${approvalId} FOR UPDATE`;
  if (!a) throw new AppError('NOT_FOUND', 'approval request not found');
  if (a.status !== 'PENDING') throw new AppError('INVALID_STATE', `approval is ${a.status}`);
  if (a.requestedBy === approver.userId) throw new AppError('SELF_APPROVAL', '雙人覆核：不可核准/駁回自己提出的申請');
  if (!hasPermission(approver.roles, APPROVE_PERMISSION[a.type])) throw new AppError('FORBIDDEN', `missing permission ${APPROVE_PERMISSION[a.type]}`);
  return a;
}

/** 核准並於同一交易內執行；執行失敗則整筆 rollback，申請維持 PENDING。 */
export async function approve(approver: Principal, approvalId: string, note?: string) {
  return transaction(async (tx) => {
    const a = await lockPending(tx, approvalId, approver);
    const result = await execute(tx, a, approver.userId);
    await tx`
      UPDATE approval_requests SET status = 'APPROVED', decided_by = ${approver.userId}, decided_at = now(),
             decision_note = ${note ?? null}, result_json = ${canonicalJson(result)}
      WHERE id = ${a.id}`;
    await appendAudit(tx, { actorType: 'ADMIN', actorId: approver.userId, action: 'APPROVAL_APPROVED', entityType: 'approval_request', entityId: a.id, payload: { type: a.type, targetId: a.targetId, requestedBy: a.requestedBy } });
    return { approvalId: a.id, type: a.type, status: 'APPROVED' as const, result };
  });
}

export async function reject(approver: Principal, approvalId: string, note?: string) {
  return transaction(async (tx) => {
    const a = await lockPending(tx, approvalId, approver);
    if (a.type === 'PUBLISH_POOL') await tx`UPDATE pools SET status = 'DRAFT' WHERE id = ${a.targetId} AND status = 'PENDING_PUBLISH'`;
    if (a.type === 'REFUND') await tx`UPDATE refund_requests SET status = 'REQUESTED', approval_request_id = NULL WHERE id = ${a.targetId} AND status = 'PENDING_APPROVAL'`;
    await tx`UPDATE approval_requests SET status = 'REJECTED', decided_by = ${approver.userId}, decided_at = now(), decision_note = ${note ?? null} WHERE id = ${a.id}`;
    await appendAudit(tx, { actorType: 'ADMIN', actorId: approver.userId, action: 'APPROVAL_REJECTED', entityType: 'approval_request', entityId: a.id, payload: { type: a.type, targetId: a.targetId, note: note ?? null } });
    return { approvalId: a.id, type: a.type, status: 'REJECTED' as const };
  });
}

export async function listApprovals(actor: Principal, status?: 'PENDING' | 'APPROVED' | 'REJECTED', d: Db = db()) {
  requirePermission(actor, 'approval.list');
  const rows = await d<ApprovalRow[]>`
    SELECT id, type, target_id, payload_json, status, requested_by, decided_by, created_at, decided_at, result_json
    FROM approval_requests ${status ? d`WHERE status = ${status}` : d``} ORDER BY created_at DESC LIMIT 200`;
  return rows.map(({ payloadJson, resultJson, ...r }) => ({ ...r, payload: JSON.parse(payloadJson) as unknown, result: resultJson ? (JSON.parse(resultJson) as unknown) : null }));
}
