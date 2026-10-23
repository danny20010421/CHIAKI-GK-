import { z } from 'zod';
import { AppError } from '../../errors';
import { transaction, type Db } from '../../db';
import { appendAudit } from '../audit/audit';
import { postLedger } from '../wallet/wallet';
import type { Principal } from '../auth/rbac';
import { ItemIdsSchema, lockStoredItems } from '../warehouse/warehouse';
import { methodCategory, SHIPPING_METHODS } from './fees';
import { advanceShipment, listMemberShipments } from './fulfilment';

export { SHIPPING_METHODS };

export const ShipmentRequestSchema = z
  .object({
    itemIds: ItemIdsSchema,
    method: z.enum(SHIPPING_METHODS),
    recipientName: z.string().min(1).max(50),
    recipientPhone: z.string().regex(/^09\d{8}$/, '請填寫台灣手機號碼 09xxxxxxxx'),
    address: z.string().min(5).max(200).optional(),
    cvsStoreId: z.string().min(3).max(20).optional(),
    cvsStoreName: z.string().max(50).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.method === 'HOME_DELIVERY' && !v.address) ctx.addIssue({ code: 'custom', path: ['address'], message: 'address required for home delivery' });
    if (v.method !== 'HOME_DELIVERY' && !v.cvsStoreId) ctx.addIssue({ code: 'custom', path: ['cvsStoreId'], message: 'store id required for CVS pickup' });
  });

/**
 * 物流方式。fee_coins 只用於「未預收運費」的物品（例如直購商品）；賞池獎品的運費已於抽賞時按套預收。
 */
export async function listShippingMethods(db: Db) {
  const rows = await db<{ method: string; label: string; feeCoins: number; maxItems: number }[]>`
    SELECT method, label, fee_coins, max_items FROM shipping_methods WHERE active ORDER BY fee_coins, method`;
  return rows.map((r) => ({ ...r, category: methodCategory(r.method) }));
}

/**
 * 申請出貨（可合併多件）。運費規則：
 *  - 來自「已預收運費」之套（該會員在該套有 shipping_prepayments）的獎品：不再收運費。
 *  - 其他物品（直購商品、無預收紀錄的舊資料）：依 shipping_methods 收一次運費。
 *  - 若預收時選的是超商、出貨卻改宅配：每個涉及的套補收「宅配 − 超商」差額（該套目前設定）。
 */
export async function requestShipment(userId: string, input: z.input<typeof ShipmentRequestSchema>) {
  const v = ShipmentRequestSchema.parse(input);
  return transaction(async (tx) => {
    const [m] = await tx<{ feeCoins: number; maxItems: number; merchantId: string }[]>`
      SELECT fee_coins, max_items, merchant_id FROM shipping_methods WHERE method = ${v.method} AND active`;
    if (!m) throw new AppError('VALIDATION', 'shipping method unavailable');
    if (v.itemIds.length > m.maxItems) throw new AppError('VALIDATION', `max ${m.maxItems} items per shipment`);
    const items = await lockStoredItems(tx, userId, v.itemIds);
    // 大件・限宅配（GK 等）：含大件時不可用超商取貨
    if (methodCategory(v.method) !== 'HOME') {
      const bulky = await tx<{ id: string; prizeName: string; tag: string | null }[]>`
        SELECT wi.id, wi.prize_name, COALESCE(pp.tag, pr.tag) AS tag FROM warehouse_items wi
        LEFT JOIN pool_prizes pp ON pp.id = wi.prize_id LEFT JOIN products pr ON pr.id = wi.product_id
        WHERE wi.id = ANY(${v.itemIds}::uuid[]) AND COALESCE(pp.bulky, pr.bulky, false)
        ORDER BY wi.prize_name, wi.id`;
      if (bulky.length) {
        throw new AppError('BULKY_HOME_DELIVERY_ONLY', `「${bulky.map((b) => b.prizeName).join('、')}」為大件商品（限宅配），無法使用超商取貨，請改選宅配到府或將大件商品分開出貨`, {
          items: bulky.map((b) => ({ id: b.id, prizeName: b.prizeName, tag: b.tag })),
        });
      }
    }
    const setIds = [...new Set(items.flatMap((i) => (i.setId ? [i.setId] : [])))];
    const prepaid = setIds.length
      ? await tx<{ setId: string; hasHome: boolean; shipFeeHome: number; shipFeeCvs: number }[]>`
          SELECT sp.set_id, bool_or(sp.method = 'HOME_DELIVERY') AS has_home, s.ship_fee_home, s.ship_fee_cvs
          FROM shipping_prepayments sp JOIN pool_sets s ON s.id = sp.set_id
          WHERE sp.user_id = ${userId} AND sp.set_id = ANY(${setIds}::uuid[])
          GROUP BY sp.set_id, s.ship_fee_home, s.ship_fee_cvs`
      : [];
    const prepaidOf = new Map(prepaid.map((p) => [p.setId, p]));
    const covered = items.filter((i) => i.setId && prepaidOf.has(i.setId));
    const uncoveredCount = items.length - covered.length;
    const baseFee = uncoveredCount > 0 ? m.feeCoins : 0;
    const homeUpgrades =
      methodCategory(v.method) === 'HOME'
        ? [...new Set(covered.map((i) => i.setId!))]
            .map((sid) => prepaidOf.get(sid)!)
            .filter((p) => !p.hasHome)
            .map((p) => ({ setId: p.setId, amount: Math.max(0, p.shipFeeHome - p.shipFeeCvs) }))
            .filter((u) => u.amount > 0)
        : [];
    const fee = baseFee + homeUpgrades.reduce((s, u) => s + u.amount, 0);
    const [s] = await tx<{ id: string }[]>`
      INSERT INTO shipments (merchant_id, user_id, method, recipient_name, recipient_phone, address, cvs_store_id, cvs_store_name, fee_coins, item_count, prepaid_item_count)
      VALUES (${m.merchantId}, ${userId}, ${v.method}, ${v.recipientName}, ${v.recipientPhone},
              ${v.method === 'HOME_DELIVERY' ? v.address! : null}, ${v.method === 'HOME_DELIVERY' ? null : v.cvsStoreId!},
              ${v.cvsStoreName ?? null}, ${fee}, ${v.itemIds.length}, ${covered.length})
      RETURNING id`;
    await tx`UPDATE warehouse_items SET status = 'SHIP_REQUESTED', shipment_id = ${s!.id}, updated_at = now() WHERE id = ANY(${v.itemIds}::uuid[])`;
    let coinsAfter: number | null = null;
    if (fee > 0) {
      coinsAfter = (await postLedger(tx, { userId, currency: 'COINS', amount: -fee, entryType: 'SHIPPING_FEE', refType: 'shipment', refId: s!.id })).balanceAfter;
    }
    const breakdown = { prepaidItems: covered.length, uncoveredItems: uncoveredCount, baseFee, homeUpgrades };
    await appendAudit(tx, {
      actorType: 'USER',
      actorId: userId,
      action: 'SHIPMENT_REQUESTED',
      entityType: 'shipment',
      entityId: s!.id,
      payload: { method: v.method, itemIds: [...v.itemIds].sort(), feeCoins: fee, breakdown },
    });
    return { shipmentId: s!.id, feeCoins: fee, itemCount: v.itemIds.length, prepaidItemCount: covered.length, feeBreakdown: breakdown, coinsAfter };
  });
}

/** 會員出貨單列表（含物流商、追蹤編號與查詢網址），見 fulfilment.ts */
export const listShipments = listMemberShipments;

/** 相容舊 API：標記已出貨（出貨單須已在「包裝」狀態；必須填物流商與追蹤編號） */
export const markShipped = (actor: Principal, shipmentId: string, trackingNo: string, carrier?: string) =>
  advanceShipment(actor, shipmentId, { to: 'SHIPPED', trackingNo, carrier });
export const markDelivered = (actor: Principal, shipmentId: string) => advanceShipment(actor, shipmentId, { to: 'DELIVERED' });
