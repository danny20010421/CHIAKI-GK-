import { randomUUID } from 'node:crypto';
import { AppError } from '../../errors';
import type { Db, Tx } from '../../db';
import { postLedger } from '../wallet/wallet';
import { SHIPPING_METHODS, setFeeFor, type ShippingMethod } from './fees';

/**
 * 運費「按套預收」與「逐件退還」（業主規則，2026-10 第三批）：
 *  - 會員在某一套「第一次付費抽賞」時，於同一抽賞交易中依其選擇的物流方式扣一份該套運費（帳本 SHIPPING_PREPAID）。
 *  - 需要的份數 = floor((該會員在該套「抽到過的全部小獎」+ 本次購買籤數) / N) + 1（N 預設 20；「滿 20 件就再收一次」）。
 *    抽到過的小獎含已回收、已出貨者 —— 回收已透過逐件退還拿回運費，不再釋放額度（避免「退錢又空出名額」的雙重好處）。
 *    大獎/中獎不計入（本次籤數以「全部可能是小獎」的最壞情況計算）。
 *  - 逐件退還：每回收一件「可回收的小獎」（會員回收或寄存到期自動轉換），退 運費 ÷ N 代幣（N = 該套 ship_refund_div，預設 20）。
 *    依「會員 × 套」累計：累計件數 units、已退金額 amount；每次退 floor(運費 × units_after / N) − amount（餘數累積到下一件）。
 *    例：運費 150 → 第 1 件退 7、第 2 件退 8（累計 15）、再 2 件退 15（累計 30）。運費 200 一次回收 5 件 → 50。
 *    運費以該會員在該套「第一份預收運費」（鎖定的物流方式）的金額為準，並與 N 一起於第一次退還時鎖定。
 *    退還入「不可退款代幣」（帳本 SHIPPING_REFUND_COINS）；每個回收請求 × 每套只退一次（shipping_item_refund_events UNIQUE）。
 *
 * 同一會員同一套的計算以 advisory lock（lockUserSetShipping）序列化：抽賞、回收、到期轉換皆會取得（在錢包列鎖之前）。
 */
export interface ShippingCharge {
  method: ShippingMethod | null;
  /** 需要選擇物流方式才能抽（本次需收費但未指定、且此套尚無預收紀錄） */
  methodRequired: boolean;
  unitFee: number;
  feesToCharge: number;
  amount: number;
  feesPaidBefore: number;
  feesPaidAfter: number;
  feesNeeded: number;
  smallItemsPerFee: number;
  /** 該會員在該套抽到過的小獎（含已回收、已出貨） */
  smallItemsDrawn: number;
  ticketCount: number;
  worstCaseSmallItems: number;
  coverageBefore: number;
  coverageAfter: number;
  /** 下一份預收的序號 */
  nextSeq: number;
  /** 各物流方式在本次需收的金額（供 UI 在付款前顯示/切換） */
  options: { method: ShippingMethod; unitFee: number; amount: number }[];
}

/** 業主字面規則：floor(小獎件數 / N) + 1 */
export function feesNeededFor(smallItems: number, perFee: number): number {
  if (!Number.isInteger(smallItems) || smallItems < 0) throw new Error('smallItems must be a non-negative integer');
  return Math.floor(smallItems / perFee) + 1;
}

/** 涵蓋額度：在不需要再收費的前提下最多可抽到的小獎件數 */
function coverageFor(fees: number, perFee: number): number {
  return fees <= 0 ? 0 : fees * perFee - 1;
}

/** 序列化同一會員同一套的運費計算（交易結束自動釋放）。呼叫順序：在錢包列鎖之前。 */
export async function lockUserSetShipping(tx: Tx, userId: string, setId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`ship:${userId}:${setId}`}, 0))`;
}

/** 該會員在該套抽到過的小獎件數（任何狀態：保管中、出貨中、已出貨、已回收皆計入） */
export async function countDrawnSmallItems(db: Db, userId: string, setId: string): Promise<number> {
  const [r] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM warehouse_items WHERE user_id = ${userId} AND set_id = ${setId} AND is_small`;
  return r!.n;
}

export async function computeShippingCharge(
  db: Db,
  a: { userId: string; set: { id: string; shipFeeHome: number; shipFeeCvs: number }; ticketCount: number; requestedMethod?: ShippingMethod | null; smallItemsPerFee: number },
): Promise<ShippingCharge> {
  const drawn = await countDrawnSmallItems(db, a.userId, a.set.id);
  const [p] = await db<{ feesPaid: number; lastMethod: ShippingMethod | null }[]>`
    SELECT count(*)::int AS fees_paid,
           (SELECT method FROM shipping_prepayments WHERE user_id = ${a.userId} AND set_id = ${a.set.id} ORDER BY seq DESC LIMIT 1) AS last_method
    FROM shipping_prepayments WHERE user_id = ${a.userId} AND set_id = ${a.set.id}`;
  const feesPaid = p!.feesPaid;
  const worst = drawn + a.ticketCount;
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
    smallItemsDrawn: drawn,
    ticketCount: a.ticketCount,
    worstCaseSmallItems: worst,
    coverageBefore: coverageFor(feesPaid, a.smallItemsPerFee),
    coverageAfter: coverageFor(feesPaid + feesToCharge, a.smallItemsPerFee),
    nextSeq: feesPaid + 1,
    options: SHIPPING_METHODS.map((m) => ({ method: m, unitFee: setFeeFor(a.set, m), amount: feesToCharge * setFeeFor(a.set, m) })),
  };
}

/** 逐件退還累計公式：floor(運費 × 件數 / N) */
export function itemRefundTotal(feeCoins: number, units: number, divisor: number): number {
  return Math.floor((feeCoins * units) / divisor);
}

export interface ItemRefund {
  eventId: string;
  setId: string;
  units: number;
  amount: number;
  unitsAfter: number;
  amountAfter: number;
  feeCoins: number;
  divisor: number;
}

/**
 * 回收（會員回收或寄存到期轉換）後的逐件運費退還。
 * unitsBySet：本次回收的「可回收小獎」件數（依套）。呼叫端須已鎖定相關倉庫物品並已取得 lockUserSetShipping，且尚未動到錢包。
 * source：本次回收請求（會員回收批次 / 到期轉換批次 id）—— 同一請求 × 同一套只會退一次。
 * 該套沒有預收運費（例如舊資料）→ 不退。
 */
export async function refundRecycledSmallItems(
  tx: Tx,
  userId: string,
  unitsBySet: Map<string, number>,
  source: { type: 'USER_RECYCLE' | 'STORAGE_EXPIRY'; id: string },
): Promise<{ refunds: ItemRefund[]; coinsAfter: number | null }> {
  const refunds: ItemRefund[] = [];
  let coinsAfter: number | null = null;
  for (const setId of [...unitsBySet.keys()].sort()) {
    const units = unitsBySet.get(setId)!;
    if (units <= 0) continue;
    await lockUserSetShipping(tx, userId, setId);
    const [first] = await tx<{ feeCoins: number; poolId: string; merchantId: string; divisor: number }[]>`
      SELECT sp.fee_coins, sp.pool_id, sp.merchant_id, s.ship_refund_div AS divisor
      FROM shipping_prepayments sp JOIN pool_sets s ON s.id = sp.set_id
      WHERE sp.user_id = ${userId} AND sp.set_id = ${setId} ORDER BY sp.seq LIMIT 1`;
    if (!first) continue;
    await tx`
      INSERT INTO shipping_item_refunds (user_id, set_id, pool_id, fee_coins, divisor)
      VALUES (${userId}, ${setId}, ${first.poolId}, ${first.feeCoins}, ${first.divisor})
      ON CONFLICT (user_id, set_id) DO NOTHING`;
    const [acc] = await tx<{ feeCoins: number; divisor: number; refundedUnits: number; refundedAmount: number }[]>`
      SELECT fee_coins, divisor, refunded_units, refunded_amount FROM shipping_item_refunds WHERE user_id = ${userId} AND set_id = ${setId} FOR UPDATE`;
    const unitsAfter = acc!.refundedUnits + units;
    const amountAfter = itemRefundTotal(acc!.feeCoins, unitsAfter, acc!.divisor);
    const delta = amountAfter - acc!.refundedAmount;
    const eventId = randomUUID();
    let ledgerId: number | null = null;
    if (delta > 0) {
      const r = await postLedger(tx, {
        userId,
        currency: 'COINS',
        amount: delta,
        entryType: 'SHIPPING_REFUND_COINS',
        refType: 'shipping_item_refund',
        refId: eventId,
        merchantId: first.merchantId,
        memo: `回收 ${units} 件小獎，退還運費（每件 ${acc!.feeCoins}÷${acc!.divisor}）`,
      });
      ledgerId = r.ledgerId;
      coinsAfter = r.balanceAfter;
    }
    await tx`
      INSERT INTO shipping_item_refund_events (id, user_id, set_id, source_type, source_id, units, amount, units_after, amount_after, ledger_id)
      VALUES (${eventId}, ${userId}, ${setId}, ${source.type}, ${source.id}, ${units}, ${delta}, ${unitsAfter}, ${amountAfter}, ${ledgerId})`;
    await tx`UPDATE shipping_item_refunds SET refunded_units = ${unitsAfter}, refunded_amount = ${amountAfter}, updated_at = now()
             WHERE user_id = ${userId} AND set_id = ${setId}`;
    refunds.push({ eventId, setId, units, amount: delta, unitsAfter, amountAfter, feeCoins: acc!.feeCoins, divisor: acc!.divisor });
  }
  return { refunds, coinsAfter };
}

/** 會員：各套的逐件運費退還累計與明細 */
export async function listMyShippingItemRefunds(db: Db, userId: string) {
  const sets = await db<{ setId: string; poolId: string; poolTitle: string; setNo: number; feeCoins: number; divisor: number; refundedUnits: number; refundedAmount: number; updatedAt: Date }[]>`
    SELECT r.set_id, r.pool_id, p.title AS pool_title, s.set_no, r.fee_coins, r.divisor, r.refunded_units, r.refunded_amount, r.updated_at
    FROM shipping_item_refunds r JOIN pool_sets s ON s.id = r.set_id JOIN pools p ON p.id = r.pool_id
    WHERE r.user_id = ${userId} ORDER BY r.updated_at DESC`;
  const events = await db`
    SELECT id, set_id, source_type, units, amount, units_after, amount_after, created_at FROM shipping_item_refund_events
    WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 200`;
  return { rule: '每回收一件小獎，退還 運費 ÷ N 代幣（N 為每套設定，預設 20；不足 1 代幣的部分累積到下一件；不可退款・無法轉換）', sets, events };
}
