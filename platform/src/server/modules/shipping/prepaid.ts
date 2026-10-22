import { AppError } from '../../errors';
import type { Db } from '../../db';
import { SHIPPING_METHODS, setFeeFor, type ShippingMethod } from './fees';

/**
 * 運費「按套預收」（業主規則）：
 *  - 會員在某一套「第一次付費抽賞」時，於同一抽賞交易中依其選擇的物流方式扣一份該套運費（帳本 SHIPPING_PREPAID）。
 *  - 一份運費涵蓋該會員在該套最多 N 件（預設 20）「小獎 SMALL」；大獎/中獎不計入。
 *  - 每次抽賞前計算最壞情況：worstCase = 該會員目前在該套持有的小獎數 + 本次購買籤數（假設全為小獎）。
 *    需要的份數 = ceil(worstCase / N)；若大於已付份數，差額份數於同一交易中補收。
 *  - 已回收（含寄存到期自動轉換）的小獎不再計入，所以回收小獎的會員不會被重複收費。
 *  - 已申請出貨/已出貨的小獎「仍計入」（見下方說明），避免「出貨 20 件 → 再抽 20 件 → 免運再出貨」的漏洞。
 *
 * 呼叫端（抽賞交易）必須已鎖定該套（pool_sets FOR UPDATE），同一套內的抽賞因此序列化，計算不會有競態。
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
  smallItemsPerFee: number;
  smallItemsHeld: number;
  ticketCount: number;
  worstCaseSmallItems: number;
  coverageBefore: number;
  coverageAfter: number;
  /** 各物流方式在本次需收的金額（供 UI 在付款前顯示/切換） */
  options: { method: ShippingMethod; unitFee: number; amount: number }[];
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

export async function computeShippingCharge(
  db: Db,
  a: { userId: string; set: { id: string; shipFeeHome: number; shipFeeCvs: number }; ticketCount: number; requestedMethod?: ShippingMethod | null; smallItemsPerFee: number },
): Promise<ShippingCharge> {
  const held = await countHeldSmallItems(db, a.userId, a.set.id);
  const [p] = await db<{ feesPaid: number; lastMethod: ShippingMethod | null }[]>`
    SELECT count(*)::int AS fees_paid,
           (SELECT method FROM shipping_prepayments WHERE user_id = ${a.userId} AND set_id = ${a.set.id} ORDER BY seq DESC LIMIT 1) AS last_method
    FROM shipping_prepayments WHERE user_id = ${a.userId} AND set_id = ${a.set.id}`;
  const feesPaid = p!.feesPaid;
  const worst = held + a.ticketCount;
  const needed = Math.ceil(worst / a.smallItemsPerFee);
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
    smallItemsPerFee: a.smallItemsPerFee,
    smallItemsHeld: held,
    ticketCount: a.ticketCount,
    worstCaseSmallItems: worst,
    coverageBefore: feesPaid * a.smallItemsPerFee,
    coverageAfter: (feesPaid + feesToCharge) * a.smallItemsPerFee,
    options: SHIPPING_METHODS.map((m) => ({ method: m, unitFee: setFeeFor(a.set, m), amount: feesToCharge * setFeeFor(a.set, m) })),
  };
}
