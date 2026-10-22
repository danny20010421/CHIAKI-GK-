import { z } from 'zod';
import { AppError } from '../../errors';
import { transaction, type Db } from '../../db';
import { appendAudit } from '../audit/audit';
import { postLedger } from '../wallet/wallet';
import { requirePermission, type Principal } from '../auth/rbac';
import { ItemIdsSchema, lockStoredItems } from '../warehouse/warehouse';

export const SHIPPING_METHODS = ['HOME_DELIVERY', 'CVS_711', 'CVS_FAMI', 'CVS_HILIFE', 'CVS_OK'] as const;

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

export async function listShippingMethods(db: Db) {
  return db<{ method: string; label: string; feeCoins: number; maxItems: number }[]>`
    SELECT method, label, fee_coins, max_items FROM shipping_methods WHERE active ORDER BY fee_coins, method`;
}

/** 合併多件獎品為一筆出貨；運費依 shipping_methods 設定以代幣扣款。 */
export async function requestShipment(userId: string, input: z.input<typeof ShipmentRequestSchema>) {
  const v = ShipmentRequestSchema.parse(input);
  return transaction(async (tx) => {
    const [m] = await tx<{ feeCoins: number; maxItems: number; merchantId: string }[]>`
      SELECT fee_coins, max_items, merchant_id FROM shipping_methods WHERE method = ${v.method} AND active`;
    if (!m) throw new AppError('VALIDATION', 'shipping method unavailable');
    if (v.itemIds.length > m.maxItems) throw new AppError('VALIDATION', `max ${m.maxItems} items per shipment`);
    await lockStoredItems(tx, userId, v.itemIds);
    const [s] = await tx<{ id: string }[]>`
      INSERT INTO shipments (merchant_id, user_id, method, recipient_name, recipient_phone, address, cvs_store_id, cvs_store_name, fee_coins, item_count)
      VALUES (${m.merchantId}, ${userId}, ${v.method}, ${v.recipientName}, ${v.recipientPhone},
              ${v.method === 'HOME_DELIVERY' ? v.address! : null}, ${v.method === 'HOME_DELIVERY' ? null : v.cvsStoreId!},
              ${v.cvsStoreName ?? null}, ${m.feeCoins}, ${v.itemIds.length})
      RETURNING id`;
    await tx`UPDATE warehouse_items SET status = 'SHIP_REQUESTED', shipment_id = ${s!.id}, updated_at = now() WHERE id = ANY(${v.itemIds}::uuid[])`;
    let coinsAfter: number | null = null;
    if (m.feeCoins > 0) {
      coinsAfter = (await postLedger(tx, { userId, currency: 'COINS', amount: -m.feeCoins, entryType: 'SHIPPING_FEE', refType: 'shipment', refId: s!.id })).balanceAfter;
    }
    await appendAudit(tx, {
      actorType: 'USER',
      actorId: userId,
      action: 'SHIPMENT_REQUESTED',
      entityType: 'shipment',
      entityId: s!.id,
      payload: { method: v.method, itemIds: [...v.itemIds].sort(), feeCoins: m.feeCoins },
    });
    return { shipmentId: s!.id, feeCoins: m.feeCoins, itemCount: v.itemIds.length, coinsAfter };
  });
}

export async function listShipments(db: Db, userId: string) {
  return db`SELECT id, method, status, fee_coins, item_count, tracking_no, created_at, shipped_at, delivered_at
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
