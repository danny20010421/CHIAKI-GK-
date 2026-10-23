import { AppError } from '../../errors';
import type { Db, Tx } from '../../db';

/**
 * 單一貨幣「CC幣」（業主 2026-10 第七批）：平台點數已併入代幣帳本（migration 20261102 以 POINTS_MERGED 轉為不可退款 CC幣）。
 * 歷史帳本仍可能有 POINTS 列（合併前），因此讀取型別保留 'POINTS'；新的帳本列一律 COINS（資料庫 ledger_coins_only 強制）。
 *
 * CC幣餘額 = 可退款 + 不可退款（wallets.nonrefundable_coins ⊆ coins）。
 */
export type Currency = 'COINS' | 'POINTS';
export type LedgerEntryType =
  | 'TOPUP'
  | 'TOPUP_BONUS' // 儲值贈送（不可退款）
  | 'DRAW_DEBIT'
  | 'PURCHASE_DEBIT'
  | 'RECYCLE_CREDIT' // 會員回收獎品（不可退款）
  | 'EXPIRY_AUTO_CONVERT' // 寄存到期自動轉換（不可退款）
  | 'REFERRAL_REWARD' // 邀請獎勵（不可退款）
  | 'CS_COMPENSATION' // 客服補償（不可退款）
  | 'BIND_REWARD' // 綁定/任務獎勵（不可退款）
  | 'REFUND_DEBIT'
  | 'ADMIN_ADJUST'
  | 'POINTS_MERGED' // 舊平台點數併入（只由 migration 寫入；不可退款）
  | 'CHECKIN' // 每日簽到（不可退款）
  | 'VIP_UPGRADE_GIFT' // VIP 升級禮（不可退款）
  | 'VIP_BIRTHDAY_GIFT'; // VIP 生日禮（不可退款）

/** 已停用（運費到付後不再寫入；歷史帳本列保留，資料庫 ledger_retired_entry_types 擋新列）。 */
export const RETIRED_LEDGER_ENTRY_TYPES = ['SHIPPING_FEE', 'SHIPPING_PREPAID', 'SHIPPING_REFUND_COINS'] as const;

/**
 * 業主規則：以下來源入帳的 CC幣一律「不可退款・無法轉換」（不計入可退款餘額、不可申請退款或新台幣退還）。
 * 只有儲值（TOPUP）與人工調整（ADMIN_ADJUST，預設可退款，可指定不可退款）入帳的 CC幣可退款。
 * postLedger 強制 refundable=false，資料庫另有 CHECK（ledger_nonrefundable_sources）。
 */
export const NONREFUNDABLE_COIN_SOURCES = [
  'EXPIRY_AUTO_CONVERT',
  'REFERRAL_REWARD',
  'RECYCLE_CREDIT',
  'BIND_REWARD',
  'TOPUP_BONUS',
  'CS_COMPENSATION',
  'POINTS_MERGED',
  'CHECKIN',
  'VIP_UPGRADE_GIFT',
  'VIP_BIRTHDAY_GIFT',
] as const satisfies readonly LedgerEntryType[];
export type NonRefundableSource = (typeof NONREFUNDABLE_COIN_SOURCES)[number];
export const NONREFUNDABLE_LABEL = '不可退款・無法轉換，如有疑問請聯絡官方小編';
export const CURRENCY_LABEL = 'CC幣';

export interface LedgerPost {
  userId: string;
  /** 只有一種貨幣（CC幣）；欄位保留以利閱讀，省略亦可 */
  currency?: 'COINS';
  amount: number; // 正數入帳、負數扣款
  entryType: LedgerEntryType;
  refType: string;
  refId: string;
  memo?: string | null;
  createdBy?: string | null;
  merchantId?: string;
  /**
   * 只用於「入帳」：此筆 CC幣是否計入可退款餘額。預設 true（儲值、人工調整）；
   * NONREFUNDABLE_COIN_SOURCES 一律 false，不可覆寫。
   */
  refundable?: boolean;
}

export async function ensureWallet(db: Db, userId: string, merchantId = 'chiaki'): Promise<void> {
  await db`INSERT INTO wallets (user_id, merchant_id) VALUES (${userId}, ${merchantId}) ON CONFLICT (user_id) DO NOTHING`;
}

export function isNonRefundableSource(t: string): t is NonRefundableSource {
  return (NONREFUNDABLE_COIN_SOURCES as readonly string[]).includes(t);
}

/**
 * 唯一的餘額異動入口：條件式 UPDATE（不足即失敗、列鎖序列化同一使用者）＋ 寫入帳本含 balance_after。
 * 必須在交易內呼叫，與業務資料同生共死。
 *
 *  - 入帳：refundable=false 的 CC幣累加到 nonrefundable_coins。
 *  - 一般扣款（抽賞、購買…）：先扣不可退款 CC幣，不足的部分才扣可退款 CC幣。
 *  - 退款扣款（REFUND_DEBIT）：只能動用可退款部分（coins − nonrefundable_coins）。
 */
export async function postLedger(tx: Tx, p: LedgerPost): Promise<{ ledgerId: number; balanceAfter: number }> {
  if (!Number.isSafeInteger(p.amount) || p.amount === 0) throw new AppError('VALIDATION', 'ledger amount must be a non-zero integer');
  if ((p.currency ?? 'COINS') !== 'COINS') throw new Error('only CC幣 (COINS) ledger entries are allowed');
  if (p.refundable !== undefined && p.amount <= 0) throw new Error('refundable flag only applies to credits');
  const forcedNonRefundable = isNonRefundableSource(p.entryType);
  if (forcedNonRefundable && p.refundable === true) throw new Error(`${p.entryType} coins are always non-refundable`);
  const refundable = p.amount > 0 ? (forcedNonRefundable ? false : (p.refundable ?? true)) : null;
  let rows: { balance: number; nonrefundable: number }[];
  if (p.amount > 0) {
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
    const msg = p.entryType === 'REFUND_DEBIT' ? '可退款 CC幣不足' : 'CC幣餘額不足';
    throw new AppError('INSUFFICIENT_FUNDS', msg, { currency: 'COINS' });
  }
  const [led] = await tx<{ id: number }[]>`
    INSERT INTO wallet_ledger (merchant_id, user_id, currency, amount, balance_after, entry_type, ref_type, ref_id, memo, created_by,
                               refundable, nonrefundable_after)
    VALUES (${p.merchantId ?? 'chiaki'}, ${p.userId}, 'COINS', ${p.amount}, ${row.balance}, ${p.entryType},
            ${p.refType}, ${p.refId}, ${p.memo ?? null}, ${p.createdBy ?? null}, ${refundable}, ${row.nonrefundable})
    RETURNING id`;
  return { ledgerId: led!.id, balanceAfter: row.balance };
}

export interface WalletBalance {
  /** CC幣總額 = 可退款 + 不可退款 */
  coins: number;
  /** 可申請退款的 CC幣（儲值、可退款的人工調整） */
  refundableCoins: number;
  /** 不可退款的 CC幣（回收、獎勵、補償、到期轉換、舊平台點數…） */
  nonRefundableCoins: number;
}

export async function getWallet(db: Db, userId: string): Promise<WalletBalance> {
  const [w] = await db<{ coins: number; nonrefundableCoins: number }[]>`
    SELECT coins, nonrefundable_coins FROM wallets WHERE user_id = ${userId}`;
  if (!w) throw new AppError('NOT_FOUND', 'wallet not found');
  return { coins: w.coins, refundableCoins: w.coins - w.nonrefundableCoins, nonRefundableCoins: w.nonrefundableCoins };
}

export interface CoinBreakdown {
  currency: typeof CURRENCY_LABEL;
  coins: number;
  refundableCoins: number;
  nonRefundableCoins: number;
  /** 不可退款 CC幣的說明文字（前台照原文顯示） */
  nonRefundableLabel: string;
  /** 各不可退款來源的累計入帳（僅供說明；目前不可退款餘額以 nonRefundableCoins 為準） */
  nonRefundableCredited: Record<NonRefundableSource, number>;
  spendingOrder: string;
}

/** 會員 CC幣明細：可退款 vs 不可退款（含標示文字與來源）。 */
export async function getCoinBreakdown(db: Db, userId: string): Promise<CoinBreakdown> {
  const w = await getWallet(db, userId);
  const rows = await db<{ entryType: string; total: number }[]>`
    SELECT entry_type, COALESCE(sum(amount), 0)::bigint AS total FROM wallet_ledger
    WHERE user_id = ${userId} AND currency = 'COINS' AND amount > 0 AND refundable = false
    GROUP BY entry_type`;
  const credited = Object.fromEntries(NONREFUNDABLE_COIN_SOURCES.map((t) => [t, 0])) as Record<NonRefundableSource, number>;
  for (const r of rows) if (isNonRefundableSource(r.entryType)) credited[r.entryType] = r.total;
  return {
    currency: CURRENCY_LABEL,
    coins: w.coins,
    refundableCoins: w.refundableCoins,
    nonRefundableCoins: w.nonRefundableCoins,
    nonRefundableLabel: NONREFUNDABLE_LABEL,
    nonRefundableCredited: credited,
    spendingOrder: '抽賞等消費時優先扣除不可退款 CC幣，不足再扣可退款 CC幣；只有可退款 CC幣可申請退款',
  };
}

export interface LedgerRow {
  id: number;
  currency: Currency;
  amount: number;
  balanceAfter: number;
  entryType: LedgerEntryType | (typeof RETIRED_LEDGER_ENTRY_TYPES)[number];
  refType: string;
  refId: string;
  memo: string | null;
  refundable: boolean | null;
  createdAt: Date;
}

/** 帳本明細（只列 CC幣；合併前的平台點數列不再顯示，其餘額已以 POINTS_MERGED 併入） */
export async function listLedger(db: Db, userId: string, limit = 50, beforeId?: number): Promise<LedgerRow[]> {
  return db<LedgerRow[]>`
    SELECT id, currency, amount, balance_after, entry_type, ref_type, ref_id, memo, refundable, created_at
    FROM wallet_ledger WHERE user_id = ${userId} AND currency = 'COINS' ${beforeId ? db`AND id < ${beforeId}` : db``}
    ORDER BY id DESC LIMIT ${limit}`;
}

export interface Reconciliation {
  userId: string;
  ok: boolean;
  coins: { cached: number; ledgerSum: number; lastBalanceAfter: number };
  /** 合併前的平台點數帳本：加總必須為 0（已全數併入 CC幣） */
  legacyPoints: { ledgerSum: number; lastBalanceAfter: number };
  nonRefundableCoins: { cached: number; lastNonrefundableAfter: number };
  brokenChainEntries: number;
}

/**
 * 對帳：證明「錢包快取餘額 == CC幣帳本加總 == 最後一筆 balance_after」，
 * 且每筆 balance_after == 前一筆 balance_after + amount（同使用者、同幣別，依 id 排序），
 * 不可退款 CC幣快取 == 最後一筆 CC幣帳本的 nonrefundable_after，
 * 以及歷史點數帳本已歸零（合併時以 POINTS_MERGED 扣到 0）。
 */
export async function reconcileWallets(db: Db, userId?: string): Promise<Reconciliation[]> {
  const rows = await db<
    {
      userId: string;
      coins: number;
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
    SELECT w.user_id, w.coins, w.nonrefundable_coins, COALESCE(a.nonref_last, 0)::bigint AS nonref_last,
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
      r.coins === r.coinLast &&
      r.pointSum === 0 &&
      r.pointLast === 0 &&
      r.nonrefundableCoins === r.nonrefLast &&
      r.broken === 0,
    coins: { cached: r.coins, ledgerSum: r.coinSum, lastBalanceAfter: r.coinLast },
    legacyPoints: { ledgerSum: r.pointSum, lastBalanceAfter: r.pointLast },
    nonRefundableCoins: { cached: r.nonrefundableCoins, lastNonrefundableAfter: r.nonrefLast },
    brokenChainEntries: r.broken,
  }));
}
