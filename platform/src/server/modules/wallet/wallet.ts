import { AppError } from '../../errors';
import type { Db, Tx } from '../../db';

export type Currency = 'COINS' | 'POINTS';
export type LedgerEntryType =
  | 'TOPUP'
  | 'TOPUP_BONUS'
  | 'DRAW_DEBIT'
  | 'PURCHASE_DEBIT'
  | 'SHIPPING_FEE'
  | 'RECYCLE_CREDIT'
  | 'REFUND_DEBIT'
  | 'ADMIN_ADJUST'
  | 'BIND_REWARD';

export interface LedgerPost {
  userId: string;
  currency: Currency;
  amount: number; // 正數入帳、負數扣款
  entryType: LedgerEntryType;
  refType: string;
  refId: string;
  memo?: string | null;
  createdBy?: string | null;
  merchantId?: string;
}

export async function ensureWallet(db: Db, userId: string, merchantId = 'chiaki'): Promise<void> {
  await db`INSERT INTO wallets (user_id, merchant_id) VALUES (${userId}, ${merchantId}) ON CONFLICT (user_id) DO NOTHING`;
}

/**
 * 唯一的餘額異動入口：條件式 UPDATE（不足即失敗、列鎖序列化同一使用者）＋ 寫入帳本含 balance_after。
 * 必須在交易內呼叫，與業務資料同生共死。
 */
export async function postLedger(tx: Tx, p: LedgerPost): Promise<{ ledgerId: number; balanceAfter: number }> {
  if (!Number.isSafeInteger(p.amount) || p.amount === 0) throw new AppError('VALIDATION', 'ledger amount must be a non-zero integer');
  const rows =
    p.currency === 'COINS'
      ? await tx<{ balance: number }[]>`
          UPDATE wallets SET coins = coins + ${p.amount}, updated_at = now()
          WHERE user_id = ${p.userId} AND coins + ${p.amount} >= 0 RETURNING coins AS balance`
      : await tx<{ balance: number }[]>`
          UPDATE wallets SET points = points + ${p.amount}, updated_at = now()
          WHERE user_id = ${p.userId} AND points + ${p.amount} >= 0 RETURNING points AS balance`;
  const row = rows[0];
  if (!row) {
    const [w] = await tx`SELECT 1 FROM wallets WHERE user_id = ${p.userId}`;
    if (!w) throw new AppError('NOT_FOUND', 'wallet not found');
    throw new AppError('INSUFFICIENT_FUNDS', p.currency === 'COINS' ? '代幣餘額不足' : '點數不足', { currency: p.currency });
  }
  const [led] = await tx<{ id: number }[]>`
    INSERT INTO wallet_ledger (merchant_id, user_id, currency, amount, balance_after, entry_type, ref_type, ref_id, memo, created_by)
    VALUES (${p.merchantId ?? 'chiaki'}, ${p.userId}, ${p.currency}, ${p.amount}, ${row.balance}, ${p.entryType},
            ${p.refType}, ${p.refId}, ${p.memo ?? null}, ${p.createdBy ?? null})
    RETURNING id`;
  return { ledgerId: led!.id, balanceAfter: row.balance };
}

export async function getWallet(db: Db, userId: string): Promise<{ coins: number; points: number }> {
  const [w] = await db<{ coins: number; points: number }[]>`SELECT coins, points FROM wallets WHERE user_id = ${userId}`;
  if (!w) throw new AppError('NOT_FOUND', 'wallet not found');
  return { coins: w.coins, points: w.points };
}

export interface LedgerRow {
  id: number;
  currency: Currency;
  amount: number;
  balanceAfter: number;
  entryType: LedgerEntryType;
  refType: string;
  refId: string;
  memo: string | null;
  createdAt: Date;
}

export async function listLedger(db: Db, userId: string, limit = 50, beforeId?: number): Promise<LedgerRow[]> {
  return db<LedgerRow[]>`
    SELECT id, currency, amount, balance_after, entry_type, ref_type, ref_id, memo, created_at
    FROM wallet_ledger WHERE user_id = ${userId} ${beforeId ? db`AND id < ${beforeId}` : db``}
    ORDER BY id DESC LIMIT ${limit}`;
}

export interface Reconciliation {
  userId: string;
  ok: boolean;
  coins: { cached: number; ledgerSum: number; lastBalanceAfter: number };
  points: { cached: number; ledgerSum: number; lastBalanceAfter: number };
  brokenChainEntries: number;
}

/**
 * 對帳：證明「錢包快取餘額 == 帳本加總 == 最後一筆 balance_after」，
 * 且每筆 balance_after == 前一筆 balance_after + amount（同使用者、同幣別，依 id 排序）。
 */
export async function reconcileWallets(db: Db, userId?: string): Promise<Reconciliation[]> {
  const rows = await db<
    {
      userId: string;
      coins: number;
      points: number;
      coinSum: number;
      pointSum: number;
      coinLast: number;
      pointLast: number;
      broken: number;
    }[]
  >`
    WITH l AS (
      SELECT user_id, currency, amount, balance_after,
             lag(balance_after) OVER (PARTITION BY user_id, currency ORDER BY id) AS prev,
             row_number() OVER (PARTITION BY user_id, currency ORDER BY id DESC) AS rn_desc
      FROM wallet_ledger ${userId ? db`WHERE user_id = ${userId}` : db``}
    ), agg AS (
      SELECT user_id,
        COALESCE(SUM(amount) FILTER (WHERE currency = 'COINS'), 0)::bigint AS coin_sum,
        COALESCE(SUM(amount) FILTER (WHERE currency = 'POINTS'), 0)::bigint AS point_sum,
        COALESCE(MAX(balance_after) FILTER (WHERE currency = 'COINS' AND rn_desc = 1), 0)::bigint AS coin_last,
        COALESCE(MAX(balance_after) FILTER (WHERE currency = 'POINTS' AND rn_desc = 1), 0)::bigint AS point_last,
        COUNT(*) FILTER (WHERE balance_after <> COALESCE(prev, 0) + amount)::int AS broken
      FROM l GROUP BY user_id
    )
    SELECT w.user_id, w.coins, w.points,
           COALESCE(a.coin_sum, 0)::bigint AS coin_sum, COALESCE(a.point_sum, 0)::bigint AS point_sum,
           COALESCE(a.coin_last, 0)::bigint AS coin_last, COALESCE(a.point_last, 0)::bigint AS point_last,
           COALESCE(a.broken, 0)::int AS broken
    FROM wallets w LEFT JOIN agg a ON a.user_id = w.user_id
    ${userId ? db`WHERE w.user_id = ${userId}` : db``}
    ORDER BY w.user_id`;
  return rows.map((r) => ({
    userId: r.userId,
    ok:
      r.coins === r.coinSum &&
      r.points === r.pointSum &&
      r.coins === r.coinLast &&
      r.points === r.pointLast &&
      r.broken === 0,
    coins: { cached: r.coins, ledgerSum: r.coinSum, lastBalanceAfter: r.coinLast },
    points: { cached: r.points, ledgerSum: r.pointSum, lastBalanceAfter: r.pointLast },
    brokenChainEntries: r.broken,
  }));
}
