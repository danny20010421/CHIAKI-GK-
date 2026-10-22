import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../errors';
import { db, transaction, type Db, type Tx } from '../../db';
import { appendAudit } from '../audit/audit';
import { requirePermission, type Principal } from '../auth/rbac';
import { notifyEvent } from '../notifications/outbox';
import { ecpayRefundGateway } from '../payment/ecpay-refund';
import { lockUserSetShipping, partialRefundAmount, refundRatioBp, surplusOfSet } from './prepaid';

/**
 * 預收運費「新台幣退款」申請（會員擇一：預設/建議為自動退不可退款代幣；或申請現金）。
 *  - 只有「目前多收」的運費可申請（有效已付份數 > floor(持有小獎 / 20) + 1）。
 *  - 金額 = floor(運費 × SHIPPING_REFUND_RATIO)，且不超過「當初以可退款代幣支付」的部分 ——
 *    消費時優先扣不可退款代幣，若該份運費是用不可退款代幣（到期轉換/邀請獎勵/運費退還）付的，就不能換成現金（業主規則：無法轉換）。
 *  - 流程：PENDING →（財務 A）APPROVED / REJECTED →（財務 B，不同人）PAID。資料庫 CHECK 保證 paid_by ≠ decided_by。
 *  - 同一份運費：代幣與現金只能擇一（唯一索引）；同一份重複申請回傳同一筆（冪等）；撥款重送回傳同一結果。
 *  - 撥款方式：BANK_TRANSFER（財務線下轉帳後填轉帳參考號）或 ECPAY_CARD（呼叫綠界刷退介面，目前為替身）。
 *  - 駁回後該份運費恢復為有效（可再次被使用或申請）。
 */
export const CashRefundRequestSchema = z
  .object({
    prepaymentId: z.string().uuid(),
    payoutMethod: z.enum(['BANK_TRANSFER', 'ECPAY_CARD']),
    bankCode: z.string().regex(/^\d{3}$/, '銀行代碼為 3 碼').optional(),
    bankAccount: z.string().regex(/^\d{8,16}$/, '帳號為 8–16 碼數字').optional(),
    accountName: z.string().min(1).max(50).optional(),
    paymentOrderId: z.string().uuid().optional(),
    reason: z.string().max(500).default(''),
  })
  .superRefine((v, ctx) => {
    if (v.payoutMethod === 'BANK_TRANSFER' && !(v.bankCode && v.bankAccount && v.accountName)) {
      ctx.addIssue({ code: 'custom', path: ['bankAccount'], message: '銀行轉帳需填銀行代碼、帳號與戶名' });
    }
    if (v.payoutMethod === 'ECPAY_CARD' && !v.paymentOrderId) ctx.addIssue({ code: 'custom', path: ['paymentOrderId'], message: '信用卡刷退需指定原儲值訂單' });
  });

export interface CashRefundRow {
  id: string;
  userId: string;
  setId: string;
  prepaymentId: string;
  mode: 'COINS' | 'CASH';
  feeCoins: number;
  ratioBp: number;
  amount: number;
  payoutMethod: 'BANK_TRANSFER' | 'ECPAY_CARD' | null;
  paymentOrderId: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAID';
  decidedBy: string | null;
  paidBy: string | null;
  providerRef: string | null;
  createdAt: Date;
}

const COLS = (d: Db) => d`id, user_id, set_id, prepayment_id, mode, fee_coins, ratio_bp, amount, payout_method, payment_order_id, status, decided_by, paid_by, provider_ref, created_at`;

/**
 * 某份預收運費中「以可退款代幣支付」的金額：由帳本的 nonrefundable_after 鏈推得
 * （該筆扣款前的不可退款餘額 − 扣款後的不可退款餘額 = 消耗的不可退款代幣）。
 */
async function refundablePortionPaid(d: Db, userId: string, prepaymentId: string): Promise<number> {
  const [r] = await d<{ amount: number; nonrefAfter: number; prevNonref: number | null }[]>`
    WITH l AS (
      SELECT id, ref_type, ref_id, amount, nonrefundable_after,
             lag(nonrefundable_after) OVER (ORDER BY id) AS prev_nonref
      FROM wallet_ledger WHERE user_id = ${userId} AND currency = 'COINS')
    SELECT amount, nonrefundable_after AS nonref_after, prev_nonref FROM l
    WHERE ref_type = 'shipping_prepayment' AND ref_id = ${prepaymentId}`;
  if (!r) return 0;
  const consumedNonRefundable = Math.max(0, (r.prevNonref ?? 0) - r.nonrefAfter);
  return Math.max(0, -r.amount - consumedNonRefundable);
}

/** 會員：目前可申請退還（多收）的運費清單，含代幣與現金可退金額 */
export async function listRefundableShippingFees(userId: string) {
  const sets = await db()<{ setId: string; setNo: number; poolTitle: string }[]>`
    SELECT DISTINCT sp.set_id, s.set_no, p.title AS pool_title FROM shipping_prepayments sp
    JOIN pool_sets s ON s.id = sp.set_id JOIN pools p ON p.id = s.pool_id WHERE sp.user_id = ${userId} ORDER BY p.title, s.set_no`;
  const ratioBp = refundRatioBp();
  const out = [];
  for (const s of sets) {
    const sur = await surplusOfSet(db(), userId, s.setId);
    for (const p of sur.surplus) {
      const cashCap = await refundablePortionPaid(db(), userId, p.id);
      out.push({
        setId: s.setId,
        setNo: s.setNo,
        poolTitle: s.poolTitle,
        prepaymentId: p.id,
        seq: p.seq,
        feeCoins: p.feeCoins,
        coinRefund: partialRefundAmount(p.feeCoins, ratioBp),
        cashRefundTwd: Math.min(partialRefundAmount(p.feeCoins, ratioBp), cashCap),
      });
    }
  }
  return { ratio: ratioBp / 10_000, fees: out, note: '建議選擇代幣退還（即時入帳，不可退款・無法轉換）；新台幣退款需財務審核與撥款' };
}

export async function createCashRefundRequest(userId: string, input: z.input<typeof CashRefundRequestSchema>): Promise<CashRefundRow & { replayed: boolean }> {
  const v = CashRefundRequestSchema.parse(input);
  return transaction(async (tx) => {
    const [pp] = await tx<{ id: string; setId: string; feeCoins: number; merchantId: string }[]>`
      SELECT id, set_id, fee_coins, merchant_id FROM shipping_prepayments WHERE id = ${v.prepaymentId} AND user_id = ${userId}`;
    if (!pp) throw new AppError('NOT_FOUND', 'prepaid shipping fee not found');
    await lockUserSetShipping(tx, userId, pp.setId);
    const [existing] = await tx<CashRefundRow[]>`SELECT ${COLS(tx)} FROM shipping_fee_refunds WHERE prepayment_id = ${pp.id} AND status <> 'REJECTED'`;
    if (existing) {
      if (existing.mode === 'CASH') return { ...existing, replayed: true };
      throw new AppError('CONFLICT', '此份運費已退還為代幣，不可再申請現金退款');
    }
    const sur = await surplusOfSet(tx, userId, pp.setId);
    if (sur.surplus.length === 0) {
      throw new AppError('INVALID_STATE', '此套運費目前沒有多收（持有小獎仍需要這些運費）', { feesNeeded: sur.feesNeeded, feesActive: sur.feesActive });
    }
    const ratioBp = refundRatioBp();
    const amount = Math.min(partialRefundAmount(pp.feeCoins, ratioBp), await refundablePortionPaid(tx, userId, pp.id));
    if (amount <= 0) throw new AppError('INVALID_STATE', '此份運費以不可退款代幣支付，僅能以代幣退還');
    if (v.payoutMethod === 'ECPAY_CARD') {
      const [o] = await tx<{ amountTwd: number; refunded: number }[]>`
        SELECT o.amount_twd,
               COALESCE((SELECT sum(r.amount) FROM shipping_fee_refunds r WHERE r.payment_order_id = o.id AND r.status <> 'REJECTED'), 0)::bigint AS refunded
        FROM payment_orders o
        WHERE o.id = ${v.paymentOrderId!} AND o.user_id = ${userId} AND o.provider = 'ECPAY' AND o.status = 'PAID' AND o.payment_type LIKE 'Credit%'
        FOR UPDATE OF o`;
      if (!o) throw new AppError('VALIDATION', '信用卡刷退需指定本人已付款的綠界信用卡儲值訂單');
      if (o.refunded + amount > o.amountTwd) throw new AppError('VALIDATION', '退款金額超過原訂單可刷退金額');
    }
    const id = randomUUID();
    const [row] = await tx<CashRefundRow[]>`
      INSERT INTO shipping_fee_refunds (id, merchant_id, user_id, set_id, prepayment_id, mode, fee_coins, ratio_bp, amount, payout_method,
                                        bank_code, bank_account, account_name, payment_order_id, status, reason)
      VALUES (${id}, ${pp.merchantId}, ${userId}, ${pp.setId}, ${pp.id}, 'CASH', ${pp.feeCoins}, ${ratioBp}, ${amount}, ${v.payoutMethod},
              ${v.bankCode ?? null}, ${v.bankAccount ?? null}, ${v.accountName ?? null}, ${v.paymentOrderId ?? null}, 'PENDING', ${v.reason})
      RETURNING ${COLS(tx)}`;
    await appendAudit(tx, {
      actorType: 'USER',
      actorId: userId,
      action: 'SHIPPING_CASH_REFUND_REQUESTED',
      entityType: 'shipping_fee_refund',
      entityId: id,
      payload: { prepaymentId: pp.id, amount, payoutMethod: v.payoutMethod, ratioBp },
    });
    return { ...row!, replayed: false };
  });
}

export async function listMyShippingRefunds(d: Db, userId: string) {
  return d<CashRefundRow[]>`SELECT ${COLS(d)} FROM shipping_fee_refunds WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 200`;
}

export async function listCashRefundsForAdmin(actor: Principal, status?: string) {
  requirePermission(actor, 'shipping_refund.decide');
  const d = db();
  return d`SELECT id, user_id, set_id, prepayment_id, fee_coins, ratio_bp, amount, payout_method, bank_code, bank_account, account_name,
                  payment_order_id, status, reason, decided_by, decided_at, paid_by, paid_at, provider_ref, created_at
           FROM shipping_fee_refunds WHERE mode = 'CASH' ${status ? d`AND status = ${status}` : d``} ORDER BY created_at DESC LIMIT 200`;
}

const STATUS_LABEL = { PENDING: '審核中', APPROVED: '已核准，待撥款', REJECTED: '已駁回', PAID: '已撥款' } as const;

async function notifyStatus(tx: Tx, r: CashRefundRow, note?: string | null) {
  await notifyEvent(tx, {
    userId: r.userId,
    event: 'REFUND_STATUS',
    data: { kindLabel: '運費退款', amountLabel: `NT$${r.amount}`, statusLabel: STATUS_LABEL[r.status], note: note ?? null },
    payload: { shippingRefundId: r.id, status: r.status, amount: r.amount },
    dedupeOn: { shippingRefundId: r.id, status: r.status },
  });
}

/** 財務 A：核准或駁回（approveCashRefund 也供客服一鍵動作使用） */
export async function decideCashRefund(actor: Principal, id: string, decision: 'APPROVE' | 'REJECT', note?: string) {
  requirePermission(actor, 'shipping_refund.decide');
  return transaction(async (tx) => {
    const [r] = await tx<CashRefundRow[]>`SELECT ${COLS(tx)} FROM shipping_fee_refunds WHERE id = ${id} AND mode = 'CASH' FOR UPDATE`;
    if (!r) throw new AppError('NOT_FOUND', 'shipping refund request not found');
    if (r.status !== 'PENDING') throw new AppError('INVALID_STATE', `refund is ${r.status}`);
    const status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    const [u] = await tx<CashRefundRow[]>`
      UPDATE shipping_fee_refunds SET status = ${status}, decided_by = ${actor.userId}, decided_at = now(), decision_note = ${note ?? null}
      WHERE id = ${id} RETURNING ${COLS(tx)}`;
    await notifyStatus(tx, u!, note);
    await appendAudit(tx, { actorType: 'ADMIN', actorId: actor.userId, action: `SHIPPING_CASH_REFUND_${status}`, entityType: 'shipping_fee_refund', entityId: id, payload: { amount: r.amount, note: note ?? null } });
    return u!;
  });
}

export const PayoutSchema = z.object({ bankTransferRef: z.string().min(3).max(100).optional() });

/**
 * 財務 B：撥款（必須與核准者不同人；資料庫 CHECK 亦強制）。冪等：已撥款者直接回傳同一結果。
 * ECPAY_CARD 會在交易內呼叫刷退介面（以申請單 id 為冪等鍵；替身）。正式串接建議改為「先標記 PAYING、交易外呼叫、再回寫」。
 */
export async function payoutCashRefund(actor: Principal, id: string, input: z.input<typeof PayoutSchema> = {}) {
  requirePermission(actor, 'shipping_refund.payout');
  const v = PayoutSchema.parse(input);
  return transaction(async (tx) => {
    const [r] = await tx<(CashRefundRow & { merchantTradeNo: string | null; providerTradeNo: string | null })[]>`
      SELECT r.id, r.user_id, r.set_id, r.prepayment_id, r.mode, r.fee_coins, r.ratio_bp, r.amount, r.payout_method, r.payment_order_id, r.status,
             r.decided_by, r.paid_by, r.provider_ref, r.created_at, o.merchant_trade_no, o.provider_trade_no
      FROM shipping_fee_refunds r LEFT JOIN payment_orders o ON o.id = r.payment_order_id
      WHERE r.id = ${id} AND r.mode = 'CASH' FOR UPDATE OF r`;
    if (!r) throw new AppError('NOT_FOUND', 'shipping refund request not found');
    if (r.status === 'PAID') return { ...r, replayed: true };
    if (r.status !== 'APPROVED') throw new AppError('INVALID_STATE', `refund is ${r.status}`);
    if (r.decidedBy === actor.userId) throw new AppError('SELF_APPROVAL', '雙人覆核：撥款者不可與核准者為同一人');
    let providerRef: string;
    if (r.payoutMethod === 'ECPAY_CARD') {
      providerRef = (await ecpayRefundGateway().refundCard({ merchantTradeNo: r.merchantTradeNo!, providerTradeNo: r.providerTradeNo, amount: r.amount, idempotencyKey: r.id })).providerRef;
    } else {
      if (!v.bankTransferRef) throw new AppError('VALIDATION', '銀行轉帳撥款需填寫轉帳參考號');
      providerRef = v.bankTransferRef;
    }
    const [u] = await tx<CashRefundRow[]>`
      UPDATE shipping_fee_refunds SET status = 'PAID', paid_by = ${actor.userId}, paid_at = now(), provider_ref = ${providerRef}
      WHERE id = ${id} RETURNING ${COLS(tx)}`;
    await notifyStatus(tx, u!);
    await appendAudit(tx, {
      actorType: 'ADMIN',
      actorId: actor.userId,
      action: 'SHIPPING_CASH_REFUND_PAID',
      entityType: 'shipping_fee_refund',
      entityId: id,
      payload: { amount: r.amount, payoutMethod: r.payoutMethod, providerRef, approvedBy: r.decidedBy },
    });
    return { ...u!, replayed: false };
  });
}
