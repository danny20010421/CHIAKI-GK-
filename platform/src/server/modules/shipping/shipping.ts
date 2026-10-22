import { z } from 'zod';
import { AppError } from '../../errors';
import { transaction, type Db } from '../../db';
import { appendAudit } from '../audit/audit';
import { postLedger } from '../wallet/wallet';
import { requirePermission, type Principal } from '../auth/rbac';
import { ItemIdsSchema, lockStoredItems } from '../warehouse/warehouse';
import { methodCategory, SHIPPING_METHODS } from './fees';

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

export async function listShipments(db: Db, userId: string) {
  return db`SELECT id, method, status, fee_coins, item_count, prepaid_item_count, tracking_no, created_at, shipped_at, delivered_at
            FROM shipments WHERE user_id = ${userId} ORDER BY created_at DESC`;
}

async function transition(actor: Principal, shipmentId: string, from: 'REQUESTED' | 'SHIPPED', to: 'SHIPPED' | 'DELIVERED', trackingNo?: string) {
  requirePermission(actor, 'shipment.manage');
  return transaction(async (tx) => {
    const [s] = await tx<{ id: string; status: string }[]>`SELECT id, status FROM shipments WHERE id = ${shipmentId} FOR UPDATE`;
    if (!s) throw new AppError('NOT_FOUND', 'shipment not found');
    if (s.status !== from) throw new AppError('INVALID_STATE', `shipment is ${s.status}`);
    if (to === 'SHIPPED') {
      await tx`UPDATE shipments SET status = 'SHIPPED', tracking_no = ${trackingNo ?? null}, shipped_at = now() WHERE id = ${s.id}`;
    } else {
      await tx`UPDATE shipments SET status = 'DELIVERED', delivered_at = now() WHERE id = ${s.id}`;
    }
    const items = await tx`UPDATE warehouse_items SET status = ${to}, updated_at = now() WHERE shipment_id = ${s.id} RETURNING id`;
    await appendAudit(tx, {
      actorType: 'ADMIN',
      actorId: actor.userId,
      action: to === 'SHIPPED' ? 'SHIPMENT_SHIPPED' : 'SHIPMENT_DELIVERED',
      entityType: 'shipment',
      entityId: s.id,
      payload: { trackingNo: trackingNo ?? null, items: items.length },
    });
    return { shipmentId: s.id, status: to };
  });
}

export const markShipped = (actor: Principal, shipmentId: string, trackingNo: string) => transition(actor, shipmentId, 'REQUESTED', 'SHIPPED', trackingNo);
export const markDelivered = (actor: Principal, shipmentId: string) => transition(actor, shipmentId, 'SHIPPED', 'DELIVERED');
