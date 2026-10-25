import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../errors';
import { transaction, type Db, type Tx } from '../../db';
import { getOwnAddress, PhoneSchema } from '../member/profile';
import { appendAudit } from '../audit/audit';
import type { Principal } from '../auth/rbac';
import { ItemIdsSchema, ITEM_SHIP_METHOD_SQL, lockStoredItems } from '../warehouse/warehouse';
import {
  FREIGHT_COLLECT_NOTE,
  methodCategory,
  SHIP_METHOD_LABEL,
  SHIP_METHODS,
  SHIP_TO_SHIPPING,
  SHIPPING_METHODS,
  type ShipMethod,
  type ShippingMethod,
} from './methods';
import { advanceShipment, listMemberShipments } from './fulfilment';

export { SHIPPING_METHODS };

/** 某一寄送方式的收件資訊：直接填寫，或以 addressId 引用該方式的「常用收件資訊」 */
const ManualRecipientSchema = z
  .object({
    recipientName: z.string().trim().min(1).max(50),
    recipientPhone: PhoneSchema,
    address: z.string().trim().min(5).max(200).optional(),
    cvsStoreId: z.string().trim().min(3).max(20).optional(),
    cvsStoreName: z.string().trim().max(50).optional(),
  })
  .strict();
const DestinationSchema = z.union([z.object({ addressId: z.string().uuid() }).strict(), ManualRecipientSchema]);

/**
 * 申請出貨。寄送方式由每個獎項上架時預設（會員不可選擇）；含不同寄送方式的物品時拆成多張出貨單。
 * destinations：依寄送方式提供收件資訊（home → 地址；c711 / fami → 門市）。未提供的方式改用會員該方式的常用收件資訊
 * （預設優先，其次最新一筆）；仍沒有則回 SHIP_DESTINATION_REQUIRED（details.methods 列出缺少的方式）。
 */
export const ShipmentRequestSchema = z
  .object({
    itemIds: ItemIdsSchema,
    destinations: z
      .object({ home: DestinationSchema.optional(), c711: DestinationSchema.optional(), fami: DestinationSchema.optional() })
      .strict()
      .default({}),
  })
  .strict();

interface Recipient {
  recipientName: string;
  recipientPhone: string;
  address: string | null;
  cvsStoreId: string | null;
  cvsStoreName: string | null;
  addressId: string | null;
}

/**
 * 物流方式（不再有運費；運費到付）。shipMethods：寄送方式代碼與標示，供前台顯示。
 */
export async function listShippingMethods(db: Db) {
  const rows = await db<{ method: ShippingMethod; label: string; maxItems: number }[]>`
    SELECT method, label, max_items FROM shipping_methods WHERE active ORDER BY method`;
  const ship = Object.fromEntries(SHIP_METHODS.map((m) => [SHIP_TO_SHIPPING[m], m])) as Record<ShippingMethod, ShipMethod>;
  return rows.map((r) => ({ ...r, shipMethod: ship[r.method], category: methodCategory(r.method), freightCollect: true as const, note: FREIGHT_COLLECT_NOTE }));
}

async function resolveDestination(tx: Tx, userId: string, m: ShipMethod, d: z.infer<typeof DestinationSchema> | undefined): Promise<Recipient | null> {
  if (d && 'addressId' in d) {
    const a = await getOwnAddress(tx, userId, d.addressId);
    if (a.method !== m) {
      throw new AppError('VALIDATION', `收件資訊「${a.recipientName}」是${SHIP_METHOD_LABEL[a.method]}，不能用於${SHIP_METHOD_LABEL[m]}`, { method: m, addressId: a.id });
    }
    return { recipientName: a.recipientName, recipientPhone: a.recipientPhone, address: a.address, cvsStoreId: a.cvsStoreId, cvsStoreName: a.cvsStoreName, addressId: a.id };
  }
  if (d) {
    if (m === 'home' && !d.address) throw new AppError('VALIDATION', '宅配到府需填寫地址', { method: m });
    if (m !== 'home' && !d.cvsStoreId) throw new AppError('VALIDATION', `${SHIP_METHOD_LABEL[m]}需填寫門市代號`, { method: m });
    return {
      recipientName: d.recipientName,
      recipientPhone: d.recipientPhone,
      address: m === 'home' ? d.address! : null,
      cvsStoreId: m === 'home' ? null : d.cvsStoreId!,
      cvsStoreName: m === 'home' ? null : (d.cvsStoreName ?? null),
      addressId: null,
    };
  }
  const [a] = await tx<{ id: string; recipientName: string; recipientPhone: string; address: string | null; cvsStoreId: string | null; cvsStoreName: string | null }[]>`
    SELECT id, recipient_name, recipient_phone, address, cvs_store_id, cvs_store_name FROM member_addresses
    WHERE user_id = ${userId} AND method = ${m} ORDER BY is_default DESC, created_at DESC LIMIT 1`;
  return a ? { ...a, addressId: a.id } : null;
}

export interface ShipmentPart {
  shipmentId: string;
  shipMethod: ShipMethod;
  shipMethodLabel: string;
  method: ShippingMethod;
  itemIds: string[];
  itemCount: number;
  freightCollect: true;
  feeCoins: 0;
}

/**
 * 申請出貨（可合併多件）。運費到付：不收任何 UC幣。
 * 物品依寄送方式分組 → 每組一張出貨單（同一次申請共用 request_id），每張各自檢查該物流方式的件數上限。
 */
export async function requestShipment(userId: string, input: unknown) {
  if (input && typeof input === 'object' && ('method' in input || 'addressId' in input)) {
    throw new AppError('SHIP_METHOD_PRESET', '寄送方式由每個獎項預設，無法自選；請依寄送方式提供收件資訊（destinations）');
  }
  const v = ShipmentRequestSchema.parse(input);
  return transaction(async (tx) => {
    // 鎖順序：物品（依 id）→ 出貨單 → 稽核
    const locked = await lockStoredItems(tx, userId, v.itemIds);
    const merchantId = locked[0]!.merchantId;
    const rows = await tx<{ id: string; shipMethod: ShipMethod }[]>`
      SELECT wi.id, ${ITEM_SHIP_METHOD_SQL(tx)} AS ship_method FROM warehouse_items wi
      LEFT JOIN pool_prizes pp ON pp.id = wi.prize_id LEFT JOIN products pr ON pr.id = wi.product_id
      WHERE wi.id = ANY(${v.itemIds}::uuid[]) ORDER BY wi.id`;
    const groups = new Map<ShipMethod, string[]>();
    for (const r of rows) groups.set(r.shipMethod, [...(groups.get(r.shipMethod) ?? []), r.id]);
    const methods = SHIP_METHODS.filter((m) => groups.has(m));

    const recipients = new Map<ShipMethod, Recipient>();
    const missing: ShipMethod[] = [];
    for (const m of methods) {
      const r = await resolveDestination(tx, userId, m, v.destinations[m]);
      if (r) recipients.set(m, r);
      else missing.push(m);
    }
    if (missing.length) {
      throw new AppError('SHIP_DESTINATION_REQUIRED', `請提供${missing.map((m) => SHIP_METHOD_LABEL[m]).join('、')}的收件資訊`, {
        methods: missing,
        items: Object.fromEntries(missing.map((m) => [m, groups.get(m)])),
      });
    }

    const limits = await tx<{ method: ShippingMethod; maxItems: number; active: boolean }[]>`
      SELECT method, max_items, active FROM shipping_methods WHERE method = ANY(${methods.map((m) => SHIP_TO_SHIPPING[m])}::text[])`;
    const limitOf = new Map(limits.map((l) => [l.method, l]));
    for (const m of methods) {
      const l = limitOf.get(SHIP_TO_SHIPPING[m]);
      if (!l?.active) throw new AppError('VALIDATION', `${SHIP_METHOD_LABEL[m]}目前暫停服務`, { method: m });
      if (groups.get(m)!.length > l.maxItems) throw new AppError('VALIDATION', `${SHIP_METHOD_LABEL[m]}每張出貨單最多 ${l.maxItems} 件`, { method: m, maxItems: l.maxItems });
    }

    const requestId = randomUUID();
    const parts: ShipmentPart[] = [];
    for (const m of methods) {
      const r = recipients.get(m)!;
      const ids = groups.get(m)!;
      const method = SHIP_TO_SHIPPING[m];
      const [s] = await tx<{ id: string }[]>`
        INSERT INTO shipments (merchant_id, user_id, method, recipient_name, recipient_phone, address, cvs_store_id, cvs_store_name,
                               fee_coins, item_count, address_id, freight_collect, request_id)
        VALUES (${merchantId}, ${userId}, ${method}, ${r.recipientName}, ${r.recipientPhone}, ${r.address}, ${r.cvsStoreId}, ${r.cvsStoreName},
                0, ${ids.length}, ${r.addressId}, true, ${requestId})
        RETURNING id`;
      await tx`INSERT INTO shipment_events (shipment_id, status, kind, actor_type, actor_id, note)
               VALUES (${s!.id}, 'REQUESTED', 'REQUESTED', 'USER', ${userId}, ${`會員申請出貨（${SHIP_METHOD_LABEL[m]}・運費到付）`})`;
      await tx`UPDATE warehouse_items SET status = 'SHIP_REQUESTED', shipment_id = ${s!.id}, updated_at = now() WHERE id = ANY(${ids}::uuid[])`;
      parts.push({ shipmentId: s!.id, shipMethod: m, shipMethodLabel: SHIP_METHOD_LABEL[m], method, itemIds: ids, itemCount: ids.length, freightCollect: true, feeCoins: 0 });
    }
    // 稽核：每張出貨單一筆（同一次申請以 requestId 關聯）
    for (const part of parts) {
      await appendAudit(tx, {
        actorType: 'USER',
        actorId: userId,
        action: 'SHIPMENT_REQUESTED',
        entityType: 'shipment',
        entityId: part.shipmentId,
        payload: { requestId, method: part.method, shipMethod: part.shipMethod, itemIds: [...part.itemIds].sort(), freightCollect: true, feeCoins: 0 },
      });
    }
    return { requestId, shipments: parts, itemCount: v.itemIds.length, freightCollect: true as const, feeCoins: 0 as const, note: FREIGHT_COLLECT_NOTE };
  });
}

/** 會員出貨單列表（含物流商、追蹤編號與查詢網址），見 fulfilment.ts */
export const listShipments = listMemberShipments;

/** 相容舊 API：標記已出貨（出貨單須已在「包裝」狀態；必須填物流商與追蹤編號） */
export const markShipped = (actor: Principal, shipmentId: string, trackingNo: string, carrier?: string) =>
  advanceShipment(actor, shipmentId, { to: 'SHIPPED', trackingNo, carrier });
export const markDelivered = (actor: Principal, shipmentId: string) => advanceShipment(actor, shipmentId, { to: 'DELIVERED' });
