import { AppError } from '../../errors';
import type { Db, Tx } from '../../db';

export type Currency = 'COINS' | 'POINTS';
export type LedgerEntryType =
  | 'TOPUP'
  | 'TOPUP_BONUS'
  | 'DRAW_DEBIT'
  | 'PURCHASE_DEBIT'
  | 'SHIPPING_FEE'
  | 'SHIPPING_PREPAID' // 抽賞時按套預收運費
  | 'RECYCLE_CREDIT'
  | 'EXPIRY_AUTO_CONVERT' // 寄存到期自動轉換為代幣（不可退款）
  | 'SHIPPING_REFUND_COINS' // 回收小獎後多收運費的部分退還（不可退款）
  | 'REFERRAL_REWARD' // 邀請獎勵（不可退款）
  | 'CS_COMPENSATION' // 客服補償（平台點數）
  | 'REFUND_DEBIT'
  | 'ADMIN_ADJUST'
  | 'BIND_REWARD';

/**
 * 業主規則：以下來源入帳的代幣一律「不可退款・無法轉換」（不計入可退款餘額、不可申請退款或新台幣退還）。
 * postLedger 強制 refundable=false，資料庫另有 CHECK（ledger_nonrefundable_sources）。
 */
export const NONREFUNDABLE_COIN_SOURCES: readonly LedgerEntryType[] = ['EXPIRY_AUTO_CONVERT', 'SHIPPING_REFUND_COINS', 'REFERRAL_REWARD'];
export const NONREFUNDABLE_LABEL = '不可退款・無法轉換，如有疑問請聯絡官方小編';

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
  /**
   * 只用於「代幣入帳」：此筆代幣是否計入可退款餘額。預設 true（儲值、人工調整）；
   * NONREFUNDABLE_COIN_SOURCES（到期轉換、邀請獎勵、運費部分退還）一律 false，不可覆寫。
   */
  refundable?: boolean;
}

export async function ensureWallet(db: Db, userId: string, merchantId = 'chiaki'): Promise<void> {
  await db`INSERT INTO wallets (user_id, merchant_id) VALUES (${userId}, ${merchantId}) ON CONFLICT (user_id) DO NOTHING`;
}

/**
 * 唯一的餘額異動入口：條件式 UPDATE（不足即失敗、列鎖序列化同一使用者）＋ 寫入帳本含 balance_after。
 * 必須在交易內呼叫，與業務資料同生共死。
 *
 * 代幣分為「可退款」與「不可退款」兩部分（wallets.nonrefundable_coins ⊆ coins）：
 *  - 入帳：refundable=false 的代幣累加到 nonrefundable_coins。
 *  - 一般扣款（抽賞、運費、購買…）：優先消耗不可退款部分。
 *  - 退款扣款（REFUND_DEBIT）：只能動用可退款部分（coins − nonrefundable_coins）。
 */
export async function postLedger(tx: Tx, p: LedgerPost): Promise<{ ledgerId: number; balanceAfter: number }> {
  if (!Number.isSafeInteger(p.amount) || p.amount === 0) throw new AppError('VALIDATION', 'ledger amount must be a non-zero integer');
  if (p.refundable !== undefined && !(p.currency === 'COINS' && p.amount > 0)) throw new Error('refundable flag only applies to coin credits');
  const forcedNonRefundable = NONREFUNDABLE_COIN_SOURCES.includes(p.entryType);
  if (forcedNonRefundable && p.refundable === true) throw new Error(`${p.entryType} coins are always non-refundable`);
  const refundable = p.currency === 'COINS' && p.amount > 0 ? (forcedNonRefundable ? false : (p.refundable ?? true)) : null;
  let rows: { balance: number; nonrefundable: number | null }[];
  if (p.currency === 'POINTS') {
    rows = await tx<{ balance: number; nonrefundable: null }[]>`
      UPDATE wallets SET points = points + ${p.amount}, updated_at = now()
      WHERE user_id = ${p.userId} AND points + ${p.amount} >= 0 RETURNING points AS balance, NULL::bigint AS nonrefundable`;
  } else if (p.amount > 0) {
    rows = await tx<{ balance: number; nonrefundable: number }[]>`
      UPDATE wallets SET coins = coins + ${p.amount}, nonrefundable_coins = nonrefundable_coins + ${refundable ? 0 : p.amount}, updated_at = now()
      WHERE user_id = ${p.userId} RETURNING coins AS balance, nonrefundable_coins AS nonrefundable`;
  } else if (p.entryType === 'REFUND_DEBIT') {
    rows = await tx<{ balance: number; nonrefundable: number }[]>`
      UPDATE wallets SET coins = coins + ${p.amount}, updated_at = now()
      WHERE user_id = ${p.userId} AND coins - nonrefundable_coins + ${p.amount} >= 0 RETURNING coins AS balance, nonrefundable_coins AS nonrefundable`;
  } else {
    rows = await tx<{ balance: number; nonrefundable: number }[]>`
      UPDATE wallets SET coins = coins + ${p.amount}, nonrefundable_coins = GREATEST(nonrefundable_coins + ${p.amount}, 0), updated_at = now()
      WHERE user_id = ${p.userId} AND coins + ${p.amount} >= 0 RETURNING coins AS balance, nonrefundable_coins AS nonrefundable`;
  }
  const row = rows[0];
  if (!row) {
    const [w] = await tx`SELECT 1 FROM wallets WHERE user_id = ${p.userId}`;
    if (!w) throw new AppError('NOT_FOUND', 'wallet not found');
    const msg = p.currency === 'POINTS' ? '點數不足' : p.entryType === 'REFUND_DEBIT' ? '可退款代幣不足' : '代幣餘額不足';
    throw new AppError('INSUFFICIENT_FUNDS', msg, { currency: p.currency });
  }
  const [led] = await tx<{ id: number }[]>`
    INSERT INTO wallet_ledger (merchant_id, user_id, currency, amount, balance_after, entry_type, ref_type, ref_id, memo, created_by,
                               refundable, nonrefundable_after)
    VALUES (${p.merchantId ?? 'chiaki'}, ${p.userId}, ${p.currency}, ${p.amount}, ${row.balance}, ${p.entryType},
            ${p.refType}, ${p.refId}, ${p.memo ?? null}, ${p.createdBy ?? null}, ${refundable}, ${row.nonrefundable})
    RETURNING id`;
  return { ledgerId: led!.id, balanceAfter: row.balance };
}

export interface WalletBalance {
  coins: number;
  points: number;
  /** 可申請退款的代幣（不含寄存到期自動轉換等不可退款代幣） */
  refundableCoins: number;
  nonRefundableCoins: number;
}

export async function getWallet(db: Db, userId: string): Promise<WalletBalance> {
  const [w] = await db<{ coins: number; points: number; nonrefundableCoins: number }[]>`
    SELECT coins, points, nonrefundable_coins FROM wallets WHERE user_id = ${userId}`;
  if (!w) throw new AppError('NOT_FOUND', 'wallet not found');
  return { coins: w.coins, points: w.points, refundableCoins: w.coins - w.nonrefundableCoins, nonRefundableCoins: w.nonrefundableCoins };
}

export interface CoinBreakdown {
  coins: number;
  refundableCoins: number;
  nonRefundableCoins: number;
  /** 不可退款代幣的說明文字（前台照原文顯示） */
  nonRefundableLabel: string;
  /** 各不可退款來源的累計入帳（僅供說明；目前不可退款餘額以 nonRefundableCoins 為準，消費時優先扣除不可退款代幣） */
  nonRefundableCredited: Record<'EXPIRY_AUTO_CONVERT' | 'SHIPPING_REFUND_COINS' | 'REFERRAL_REWARD', number>;
  spendingOrder: string;
}

/** 會員代幣明細：可退款 vs 不可退款（含標示文字與來源）。 */
export async function getCoinBreakdown(db: Db, userId: string): Promise<CoinBreakdown> {
  const w = await getWallet(db, userId);
  const rows = await db<{ entryType: string; total: number }[]>`
    SELECT entry_type, COALESCE(sum(amount), 0)::bigint AS total FROM wallet_ledger
    WHERE user_id = ${userId} AND currency = 'COINS' AND amount > 0 AND refundable = false
    GROUP BY entry_type`;
  const credited = { EXPIRY_AUTO_CONVERT: 0, SHIPPING_REFUND_COINS: 0, REFERRAL_REWARD: 0 };
  for (const r of rows) if (r.entryType in credited) credited[r.entryType as keyof typeof credited] = r.total;
  return {
    coins: w.coins,
    refundableCoins: w.refundableCoins,
    nonRefundableCoins: w.nonRefundableCoins,
    nonRefundableLabel: NONREFUNDABLE_LABEL,
    nonRefundableCredited: credited,
    spendingOrder: '消費時優先扣除不可退款代幣',
  };
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
  refundable: boolean | null;
  createdAt: Date;
}

export async function listLedger(db: Db, userId: string, limit = 50, beforeId?: number): Promise<LedgerRow[]> {
  return db<LedgerRow[]>`
    SELECT id, currency, amount, balance_after, entry_type, ref_type, ref_id, memo, refundable, created_at
    FROM wallet_ledger WHERE user_id = ${userId} ${beforeId ? db`AND id < ${beforeId}` : db``}
    ORDER BY id DESC LIMIT ${limit}`;
}

export interface Reconciliation {
  userId: string;
  ok: boolean;
  coins: { cached: number; ledgerSum: number; lastBalanceAfter: number };
  points: { cached: number; ledgerSum: number; lastBalanceAfter: number };
  nonRefundableCoins: { cached: number; lastNonrefundableAfter: number };
  brokenChainEntries: number;
}

/**
 * 對帳：證明「錢包快取餘額 == 帳本加總 == 最後一筆 balance_after」，
 * 且每筆 balance_after == 前一筆 balance_after + amount（同使用者、同幣別，依 id 排序），
 * 以及不可退款代幣快取 == 最後一筆代幣帳本的 nonrefundable_after。
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
      nonrefundableCoins: number;
      nonrefLast: number;
      broken: number;
    }[]
  >`
    WITH l AS (
      SELECT user_id, currency, amount, balance_after, nonrefundable_after,
             lag(balance_after) OVER (PARTITION BY user_id, currency ORDER BY id) AS prev,
             row_number() OVER (PARTITION BY user_id, currency ORDER BY id DESC) AS rn_desc
      FROM wallet_ledger ${userId ? db`WHERE user_id = ${userId}` : db``}
    ), agg AS (
      SELECT user_id,
        COALESCE(SUM(amount) FILTER (WHERE currency = 'COINS'), 0)::bigint AS coin_sum,
        COALESCE(SUM(amount) FILTER (WHERE currency = 'POINTS'), 0)::bigint AS point_sum,
        COALESCE(MAX(balance_after) FILTER (WHERE currency = 'COINS' AND rn_desc = 1), 0)::bigint AS coin_last,
        COALESCE(MAX(balance_after) FILTER (WHERE currency = 'POINTS' AND rn_desc = 1), 0)::bigint AS point_last,
        COALESCE(MAX(nonrefundable_after) FILTER (WHERE currency = 'COINS' AND rn_desc = 1), 0)::bigint AS nonref_last,
        COUNT(*) FILTER (WHERE balance_after <> COALESCE(prev, 0) + amount)::int AS broken
      FROM l GROUP BY user_id
    )
    SELECT w.user_id, w.coins, w.points, w.nonrefundable_coins, COALESCE(a.nonref_last, 0)::bigint AS nonref_last,
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
      r.nonrefundableCoins === r.nonrefLast &&
      r.broken === 0,
    coins: { cached: r.coins, ledgerSum: r.coinSum, lastBalanceAfter: r.coinLast },
    points: { cached: r.points, ledgerSum: r.pointSum, lastBalanceAfter: r.pointLast },
    nonRefundableCoins: { cached: r.nonrefundableCoins, lastNonrefundableAfter: r.nonrefLast },
    brokenChainEntries: r.broken,
  }));
}
