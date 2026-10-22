import { randomUUID } from 'node:crypto';
import { AppError } from '../../errors';
import { config } from '../../config';
import type { Db, Tx } from '../../db';
import { postLedger } from '../wallet/wallet';
import type { PoolRules } from '../pool/rules';
import { SHIPPING_METHODS, setFeeFor, type ShippingMethod } from './fees';

/**
 * 運費「按套預收」（業主規則，2026-10 第二批改為字面規則）：
 *  - 會員在某一套「第一次付費抽賞」時，於同一抽賞交易中依其選擇的物流方式扣一份該套運費（帳本 SHIPPING_PREPAID）。
 *  - 需要的份數 = floor((該會員在該套持有的小獎數 + 本次購買籤數) / N) + 1（N 預設 20；「滿 20 件就再收一次」）。
 *    例：持有 0、一次買 20 籤 → 需 2 份；持有 0、買 19 籤 → 1 份；持有 19、再買 1 籤 → 2 份。
 *    大獎/中獎不計入（本次籤數以「全部可能是小獎」的最壞情況計算）。
 *  - 已回收（含寄存到期自動轉換）的小獎不再計入；已申請出貨/已出貨的小獎「仍計入」（避免一份運費無限次出貨）。
 *  - 回收後若「有效已付份數」> 目前需要的份數，多出的每一份自動以 SHIPPING_REFUND_RATIO（預設 0.5）退還為
 *    「不可退款代幣」（帳本 SHIPPING_REFUND_COINS），並從有效份數中扣除（refundSurplusShippingFees）。
 *    會員也可改為申請新台幣退款（shipping-refunds.ts），同一份運費代幣與現金只能擇一（資料庫唯一索引保證）。
 *
 * 有效已付份數 = shipping_prepayments 中「沒有非駁回退還紀錄」的份數（shipping_prepayments 本身 append-only）。
 * 同一會員同一套的運費計算以 advisory lock（lockUserSetShipping）序列化：抽賞、回收、到期轉換、現金退款申請皆會取得。
 */
export interface ShippingCharge {
  method: ShippingMethod | null;
  /** 需要選擇物流方式才能抽（本次需收費但未指定、且此套尚無預收紀錄） */
  methodRequired: boolean;
  unitFee: number;
  feesToCharge: number;
  amount: number;
  /** 有效已付份數（不含已退還者） */
  feesPaidBefore: number;
  feesPaidAfter: number;
  feesNeeded: number;
  smallItemsPerFee: number;
  smallItemsHeld: number;
  ticketCount: number;
  worstCaseSmallItems: number;
  coverageBefore: number;
  coverageAfter: number;
  /** 下一份預收的序號（含已退還者，序號不重複使用） */
  nextSeq: number;
  /** 各物流方式在本次需收的金額（供 UI 在付款前顯示/切換） */
  options: { method: ShippingMethod; unitFee: number; amount: number }[];
}

/** 業主字面規則：floor(小獎件數 / N) + 1 */
export function feesNeededFor(smallItems: number, perFee: number): number {
  if (!Number.isInteger(smallItems) || smallItems < 0) throw new Error('smallItems must be a non-negative integer');
  return Math.floor(smallItems / perFee) + 1;
}

/** 涵蓋額度：在不需要再收費的前提下最多可持有的小獎件數 */
function coverageFor(fees: number, perFee: number): number {
  return fees <= 0 ? 0 : fees * perFee - 1;
}

/** 序列化同一會員同一套的運費計算（交易結束自動釋放）。呼叫順序：在錢包列鎖之前。 */
export async function lockUserSetShipping(tx: Tx, userId: string, setId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`ship:${userId}:${setId}`}, 0))`;
}

/**
 * 「持有中」的小獎：未回收的都算（STORED / SHIP_REQUESTED / SHIPPED / DELIVERED）。
 * 業主原文為「目前持有（未回收、未出貨）」；但若出貨後即釋放額度，一份運費可無限次出貨，
 * 因此實作採保守解讀：只有「回收」會釋放額度。如需改回原文解讀，只要在條件加上 status = 'STORED'/'SHIP_REQUESTED'。
 */
export async function countHeldSmallItems(db: Db, userId: string, setId: string): Promise<number> {
  const [r] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM warehouse_items
    WHERE user_id = ${userId} AND set_id = ${setId} AND grade = 'SMALL' AND status <> 'RECYCLED'`;
  return r!.n;
}

export interface ActivePrepayment {
  id: string;
  seq: number;
  method: ShippingMethod;
  feeCoins: number;
  poolId: string;
  merchantId: string;
}

/** 有效（未退還）的預收運費，序號由大到小 */
export async function activePrepayments(db: Db, userId: string, setId: string): Promise<ActivePrepayment[]> {
  return db<ActivePrepayment[]>`
    SELECT sp.id, sp.seq, sp.method, sp.fee_coins, sp.pool_id, sp.merchant_id FROM shipping_prepayments sp
    WHERE sp.user_id = ${userId} AND sp.set_id = ${setId}
      AND NOT EXISTS (SELECT 1 FROM shipping_fee_refunds r WHERE r.prepayment_id = sp.id AND r.status <> 'REJECTED')
    ORDER BY sp.seq DESC`;
}

export async function computeShippingCharge(
  db: Db,
  a: { userId: string; set: { id: string; shipFeeHome: number; shipFeeCvs: number }; ticketCount: number; requestedMethod?: ShippingMethod | null; smallItemsPerFee: number },
): Promise<ShippingCharge> {
  const held = await countHeldSmallItems(db, a.userId, a.set.id);
  const [p] = await db<{ feesActive: number; feesTotal: number; lastMethod: ShippingMethod | null }[]>`
    SELECT count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM shipping_fee_refunds r WHERE r.prepayment_id = sp.id AND r.status <> 'REJECTED'))::int AS fees_active,
           count(*)::int AS fees_total,
           (SELECT method FROM shipping_prepayments WHERE user_id = ${a.userId} AND set_id = ${a.set.id} ORDER BY seq DESC LIMIT 1) AS last_method
    FROM shipping_prepayments sp WHERE sp.user_id = ${a.userId} AND sp.set_id = ${a.set.id}`;
  const feesPaid = p!.feesActive;
  const worst = held + a.ticketCount;
  const needed = feesNeededFor(worst, a.smallItemsPerFee);
  const feesToCharge = Math.max(0, needed - feesPaid);
  const method = a.requestedMethod ?? p!.lastMethod ?? null;
  if (a.requestedMethod) {
    const [m] = await db<{ active: boolean }[]>`SELECT active FROM shipping_methods WHERE method = ${a.requestedMethod}`;
    if (!m?.active) throw new AppError('VALIDATION', 'shipping method unavailable', { method: a.requestedMethod });
  }
  const unitFee = method ? setFeeFor(a.set, method) : 0;
  return {
    method,
    methodRequired: feesToCharge > 0 && !method,
    unitFee,
    feesToCharge,
    amount: feesToCharge * unitFee,
    feesPaidBefore: feesPaid,
    feesPaidAfter: feesPaid + feesToCharge,
    feesNeeded: needed,
    smallItemsPerFee: a.smallItemsPerFee,
    smallItemsHeld: held,
    ticketCount: a.ticketCount,
    worstCaseSmallItems: worst,
    coverageBefore: coverageFor(feesPaid, a.smallItemsPerFee),
    coverageAfter: coverageFor(feesPaid + feesToCharge, a.smallItemsPerFee),
    nextSeq: p!.feesTotal + 1,
    options: SHIPPING_METHODS.map((m) => ({ method: m, unitFee: setFeeFor(a.set, m), amount: feesToCharge * setFeeFor(a.set, m) })),
  };
}

/** 某套規則快照中的「一份運費涵蓋小獎數」 */
export async function smallItemsPerFeeOfSet(db: Db, setId: string): Promise<number> {
  const [r] = await db<{ rulesJson: string }[]>`
    SELECT rv.rules_json FROM pool_sets s JOIN pool_rule_versions rv ON rv.id = s.rule_version_id WHERE s.id = ${setId}`;
  if (!r) throw new AppError('NOT_FOUND', 'set not found');
  return (JSON.parse(r.rulesJson) as PoolRules).shippingPolicy?.smallItemsPerFee ?? config().SHIPPING_SMALL_ITEMS_PER_FEE;
}

export function refundRatioBp(): number {
  return Math.round(config().SHIPPING_REFUND_RATIO * 10_000);
}

export function partialRefundAmount(feeCoins: number, ratioBp: number): number {
  return Math.floor((feeCoins * ratioBp) / 10_000);
}

export interface SurplusRefund {
  refundId: string;
  setId: string;
  prepaymentId: string;
  seq: number;
  feeCoins: number;
  refundCoins: number;
}

export interface SetSurplus {
  setId: string;
  smallItemsHeld: number;
  feesNeeded: number;
  feesActive: number;
  surplus: ActivePrepayment[];
}

/** 計算某套目前多收的運費（呼叫端須已取得 lockUserSetShipping） */
export async function surplusOfSet(tx: Db, userId: string, setId: string): Promise<SetSurplus> {
  const held = await countHeldSmallItems(tx, userId, setId);
  const needed = feesNeededFor(held, await smallItemsPerFeeOfSet(tx, setId));
  const active = await activePrepayments(tx, userId, setId);
  return { setId, smallItemsHeld: held, feesNeeded: needed, feesActive: active.length, surplus: active.slice(0, Math.max(0, active.length - needed)) };
}

/**
 * 回收（會員回收或寄存到期轉換）後：有效已付份數 > 目前需要份數 → 多出的每一份（序號最大者優先）
 * 依 SHIPPING_REFUND_RATIO 退還為不可退款代幣，並寫入 shipping_fee_refunds（mode=COINS, status=PAID）使其不再計入已付份數。
 * mode='KEEP' 時不自動退還（會員選擇改申請新台幣退款），只回報可退還的份數。
 * 呼叫端：已在交易內鎖定相關倉庫物品；本函式依 setId 排序取得 advisory lock，接著才動到錢包（鎖順序一致）。
 */
export async function refundSurplusShippingFees(
  tx: Tx,
  userId: string,
  setIds: string[],
  opts: { mode: 'COINS' | 'KEEP'; reason: string; actorId?: string | null },
): Promise<{ refunds: SurplusRefund[]; keptSurplus: { setId: string; prepaymentIds: string[] }[]; coinsAfter: number | null }> {
  const refunds: SurplusRefund[] = [];
  const kept: { setId: string; prepaymentIds: string[] }[] = [];
  let coinsAfter: number | null = null;
  const ratioBp = refundRatioBp();
  for (const setId of [...new Set(setIds)].sort()) {
    await lockUserSetShipping(tx, userId, setId);
    const s = await surplusOfSet(tx, userId, setId);
    if (!s.surplus.length) continue;
    if (opts.mode === 'KEEP') {
      kept.push({ setId, prepaymentIds: s.surplus.map((p) => p.id) });
      continue;
    }
    for (const p of s.surplus) {
      const id = randomUUID();
      const amount = partialRefundAmount(p.feeCoins, ratioBp);
      let ledgerId: number | null = null;
      if (amount > 0) {
        const r = await postLedger(tx, {
          userId,
          currency: 'COINS',
          amount,
          entryType: 'SHIPPING_REFUND_COINS',
          refType: 'shipping_fee_refund',
          refId: id,
          merchantId: p.merchantId,
          createdBy: opts.actorId ?? null,
          memo: `運費部分退還（第 ${p.seq} 份，${ratioBp / 100}%）`,
        });
        ledgerId = r.ledgerId;
        coinsAfter = r.balanceAfter;
      }
      await tx`
        INSERT INTO shipping_fee_refunds (id, merchant_id, user_id, set_id, prepayment_id, mode, fee_coins, ratio_bp, amount, status, reason, ledger_id)
        VALUES (${id}, ${p.merchantId}, ${userId}, ${setId}, ${p.id}, 'COINS', ${p.feeCoins}, ${ratioBp}, ${amount}, 'PAID', ${opts.reason}, ${ledgerId})`;
      refunds.push({ refundId: id, setId, prepaymentId: p.id, seq: p.seq, feeCoins: p.feeCoins, refundCoins: amount });
    }
  }
  return { refunds, keptSurplus: kept, coinsAfter };
}
