import { z } from 'zod';
import { AppError } from '../../errors';
import { db, transaction, type Db, type Tx } from '../../db';
import { appendAudit } from '../audit/audit';
import { requirePermission, type Principal } from '../auth/rbac';
import { notifyEvent } from '../notifications/outbox';

/**
 * 出貨流程（資料庫 trigger 同步強制狀態轉換）：
 *   REQUESTED 申請 → PICKING 揀貨 → PACKING 包裝 → SHIPPED 已出貨 → DELIVERED 已送達
 *   SHIPPED → RETURNED 退件；REQUESTED/PICKING/PACKING/SHIPPED → EXCEPTION 異常；RETURNED/EXCEPTION → PICKING（重新出貨，attempt+1）
 * 標記「已出貨」必須填物流商與追蹤編號（資料庫 CHECK 亦強制），物流商須符合出貨方式（宅配 / 7-11 / 全家）。
 * 已出貨時通知會員（含追蹤編號與查詢網址）。
 */
export const SHIPMENT_STATUSES = ['REQUESTED', 'PICKING', 'PACKING', 'SHIPPED', 'DELIVERED', 'RETURNED', 'EXCEPTION', 'CANCELLED'] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const STATUS_LABEL: Record<ShipmentStatus, string> = {
  REQUESTED: '申請',
  PICKING: '揀貨',
  PACKING: '包裝',
  SHIPPED: '已出貨',
  DELIVERED: '已送達',
  RETURNED: '退件',
  EXCEPTION: '異常',
  CANCELLED: '已取消',
};

const NEXT: Record<ShipmentStatus, ShipmentStatus[]> = {
  REQUESTED: ['PICKING', 'EXCEPTION'],
  PICKING: ['PACKING', 'EXCEPTION'],
  PACKING: ['SHIPPED', 'EXCEPTION'],
  SHIPPED: ['DELIVERED', 'RETURNED', 'EXCEPTION'],
  DELIVERED: [],
  RETURNED: ['PICKING'],
  EXCEPTION: ['PICKING'],
  CANCELLED: [],
};

const METHOD_CARRIER_CATEGORY: Record<string, 'HOME' | 'CVS_711' | 'CVS_FAMI'> = {
  HOME_DELIVERY: 'HOME',
  CVS_711_C2C: 'CVS_711',
  CVS_FAMI_C2C: 'CVS_FAMI',
};

export interface Carrier {
  code: string;
  label: string;
  category: 'HOME' | 'CVS_711' | 'CVS_FAMI';
  trackingUrlTemplate: string;
}

export async function listCarriers(d: Db, method?: string): Promise<Carrier[]> {
  const cat = method ? METHOD_CARRIER_CATEGORY[method] : undefined;
  return d<Carrier[]>`SELECT code, label, category, tracking_url_template FROM carriers WHERE active ${cat ? d`AND category = ${cat}` : d``} ORDER BY sort_order, code`;
}

export function trackingUrl(template: string | null, trackingNo: string | null): string | null {
  if (!template || !trackingNo) return null;
  return template.replace('{no}', encodeURIComponent(trackingNo));
}

export const AdvanceSchema = z.object({
  to: z.enum(['PICKING', 'PACKING', 'SHIPPED', 'DELIVERED', 'RETURNED', 'EXCEPTION']),
  carrier: z.string().regex(/^[A-Z0-9_]{2,20}$/).optional(),
  trackingNo: z.string().regex(/^[A-Za-z0-9-]{4,40}$/, '追蹤編號格式不正確').optional(),
  note: z.string().max(500).optional(),
});

interface ShipRow {
  id: string;
  userId: string;
  merchantId: string;
  method: string;
  status: ShipmentStatus;
  attempt: number;
}

async function lockShipment(tx: Tx, id: string): Promise<ShipRow> {
  const [s] = await tx<ShipRow[]>`SELECT id, user_id, merchant_id, method, status, attempt FROM shipments WHERE id = ${id} FOR UPDATE`;
  if (!s) throw new AppError('NOT_FOUND', 'shipment not found');
  return s;
}

async function advanceInTx(tx: Tx, actor: Principal, shipmentId: string, v: z.infer<typeof AdvanceSchema>) {
  const s = await lockShipment(tx, shipmentId);
  if (!NEXT[s.status].includes(v.to)) throw new AppError('INVALID_STATE', `出貨單目前為「${STATUS_LABEL[s.status]}」，不可改為「${STATUS_LABEL[v.to]}」`, { from: s.status, to: v.to });
  let carrier: Carrier | null = null;
  if (v.to === 'SHIPPED') {
    if (!v.carrier || !v.trackingNo) throw new AppError('VALIDATION', '標記已出貨必須填寫物流商與追蹤編號');
    const [c] = await tx<Carrier[]>`SELECT code, label, category, tracking_url_template FROM carriers WHERE code = ${v.carrier} AND active`;
    if (!c) throw new AppError('VALIDATION', 'unknown carrier');
    if (c.category !== METHOD_CARRIER_CATEGORY[s.method]) throw new AppError('VALIDATION', `物流商「${c.label}」不適用此出貨方式`, { method: s.method });
    carrier = c;
  }
  switch (v.to) {
    case 'PICKING':
      if (s.status === 'RETURNED' || s.status === 'EXCEPTION') {
        await tx`UPDATE shipments SET status = 'PICKING', picking_at = now(), attempt = attempt + 1, tracking_no = NULL, carrier = NULL,
                        shipped_at = NULL, updated_at = now() WHERE id = ${s.id}`;
      } else {
        await tx`UPDATE shipments SET status = 'PICKING', picking_at = now(), updated_at = now() WHERE id = ${s.id}`;
      }
      break;
    case 'PACKING':
      await tx`UPDATE shipments SET status = 'PACKING', packing_at = now(), updated_at = now() WHERE id = ${s.id}`;
      break;
    case 'SHIPPED':
      await tx`UPDATE shipments SET status = 'SHIPPED', carrier = ${carrier!.code}, tracking_no = ${v.trackingNo!}, shipped_at = now(), updated_at = now() WHERE id = ${s.id}`;
      // 倉庫物品：SHIP_REQUESTED → SHIPPED（重新出貨時已是 SHIPPED，維持不變）
      await tx`UPDATE warehouse_items SET status = 'SHIPPED', updated_at = now() WHERE shipment_id = ${s.id} AND status = 'SHIP_REQUESTED'`;
      break;
    case 'DELIVERED':
      await tx`UPDATE shipments SET status = 'DELIVERED', delivered_at = now(), updated_at = now() WHERE id = ${s.id}`;
      await tx`UPDATE warehouse_items SET status = 'DELIVERED', updated_at = now() WHERE shipment_id = ${s.id} AND status = 'SHIPPED'`;
      break;
    case 'RETURNED':
      await tx`UPDATE shipments SET status = 'RETURNED', returned_at = now(), exception_note = ${v.note ?? null}, updated_at = now() WHERE id = ${s.id}`;
      break;
    case 'EXCEPTION':
      await tx`UPDATE shipments SET status = 'EXCEPTION', exception_at = now(), exception_note = ${v.note ?? null}, updated_at = now() WHERE id = ${s.id}`;
      break;
  }
  if (v.to === 'SHIPPED') {
    const url = trackingUrl(carrier!.trackingUrlTemplate, v.trackingNo!);
    await notifyEvent(tx, {
      userId: s.userId,
      merchantId: s.merchantId,
      event: 'SHIPMENT_SHIPPED',
      data: { shipmentId: s.id, carrierLabel: carrier!.label, trackingNo: v.trackingNo, trackingUrl: url },
      payload: { shipmentId: s.id, carrier: carrier!.code, trackingNo: v.trackingNo, trackingUrl: url },
      dedupeOn: { shipmentId: s.id, attempt: s.attempt, trackingNo: v.trackingNo },
    });
  }
  await appendAudit(tx, {
    actorType: 'ADMIN',
    actorId: actor.userId,
    action: `SHIPMENT_${v.to}`,
    entityType: 'shipment',
    entityId: s.id,
    payload: { from: s.status, to: v.to, carrier: carrier?.code ?? null, trackingNo: v.trackingNo ?? null, note: v.note ?? null, attempt: s.attempt },
  });
  return { shipmentId: s.id, from: s.status, status: v.to, statusLabel: STATUS_LABEL[v.to] };
}

export async function advanceShipment(actor: Principal, shipmentId: string, input: z.input<typeof AdvanceSchema>) {
  requirePermission(actor, 'shipment.manage');
  const v = AdvanceSchema.parse(input);
  return transaction((tx) => advanceInTx(tx, actor, shipmentId, v));
}

export const BatchAdvanceSchema = z.object({
  shipmentIds: z.array(z.string().uuid()).min(1).max(200).refine((a) => new Set(a).size === a.length, 'ids must be unique'),
  to: z.enum(['PICKING', 'PACKING']),
});

/** 批次推進（揀貨/包裝）：全有或全無 */
export async function batchAdvance(actor: Principal, input: z.input<typeof BatchAdvanceSchema>) {
  requirePermission(actor, 'shipment.manage');
  const v = BatchAdvanceSchema.parse(input);
  return transaction(async (tx) => {
    const out = [];
    for (const id of [...v.shipmentIds].sort()) out.push(await advanceInTx(tx, actor, id, { to: v.to }));
    return { updated: out.length, shipments: out };
  });
}

/** 退件/異常 → 重新出貨（客服一鍵動作亦使用） */
export async function resendShipment(actor: Principal, shipmentId: string, note?: string) {
  requirePermission(actor, 'shipment.resend');
  return transaction(async (tx) => {
    const s = await lockShipment(tx, shipmentId);
    if (s.status !== 'RETURNED' && s.status !== 'EXCEPTION') throw new AppError('INVALID_STATE', '只有「退件」或「異常」的出貨單可以重新出貨', { status: s.status });
    return advanceInTx(tx, actor, shipmentId, { to: 'PICKING', note });
  });
}

/** 揀貨單資料（批次列印）：依出貨單列出物品、收件資訊 */
export async function pickList(actor: Principal, filter: { status?: 'REQUESTED' | 'PICKING' | 'PACKING'; ids?: string[] }) {
  requirePermission(actor, 'shipment.manage');
  const d = db();
  const rows = await d<
    { shipmentId: string; status: ShipmentStatus; method: string; recipientName: string; recipientPhone: string; address: string | null; cvsStoreId: string | null; cvsStoreName: string | null; createdAt: Date; attempt: number; itemId: string; prizeName: string; grade: string | null; poolTitle: string | null; setNo: number | null; ticketNo: number | null }[]
  >`
    SELECT s.id AS shipment_id, s.status, s.method, s.recipient_name, s.recipient_phone, s.address, s.cvs_store_id, s.cvs_store_name, s.created_at, s.attempt,
           wi.id AS item_id, wi.prize_name, wi.grade, p.title AS pool_title, ps.set_no, wi.ticket_no
    FROM shipments s
    JOIN warehouse_items wi ON wi.shipment_id = s.id
    LEFT JOIN pools p ON p.id = wi.pool_id
    LEFT JOIN pool_sets ps ON ps.id = wi.set_id
    WHERE ${filter.ids?.length ? d`s.id = ANY(${filter.ids}::uuid[])` : d`s.status = ${filter.status ?? 'REQUESTED'}`}
    ORDER BY s.created_at, s.id, p.title NULLS LAST, ps.set_no NULLS LAST, wi.ticket_no NULLS LAST, wi.id`;
  const map = new Map<string, { shipmentId: string; status: ShipmentStatus; statusLabel: string; method: string; recipient: Record<string, string | null>; attempt: number; createdAt: Date; items: unknown[] }>();
  for (const r of rows) {
    let s = map.get(r.shipmentId);
    if (!s) {
      s = {
        shipmentId: r.shipmentId,
        status: r.status,
        statusLabel: STATUS_LABEL[r.status],
        method: r.method,
        recipient: { name: r.recipientName, phone: r.recipientPhone, address: r.address, cvsStoreId: r.cvsStoreId, cvsStoreName: r.cvsStoreName },
        attempt: r.attempt,
        createdAt: r.createdAt,
        items: [],
      };
      map.set(r.shipmentId, s);
    }
    s.items.push({ itemId: r.itemId, prizeName: r.prizeName, grade: r.grade, poolTitle: r.poolTitle, setNo: r.setNo, ticketNo: r.ticketNo });
  }
  const shipments = [...map.values()];
  return { generatedAt: new Date().toISOString(), shipmentCount: shipments.length, itemCount: rows.length, shipments };
}

/** 會員：我的出貨單（含狀態中文、物流商、追蹤編號與查詢網址） */
export async function listMemberShipments(d: Db, userId: string) {
  const rows = await d<
    { id: string; method: string; status: ShipmentStatus; feeCoins: number; itemCount: number; prepaidItemCount: number; carrier: string | null; carrierLabel: string | null; trackingUrlTemplate: string | null; trackingNo: string | null; createdAt: Date; shippedAt: Date | null; deliveredAt: Date | null }[]
  >`
    SELECT s.id, s.method, s.status, s.fee_coins, s.item_count, s.prepaid_item_count, s.carrier, c.label AS carrier_label, c.tracking_url_template,
           s.tracking_no, s.created_at, s.shipped_at, s.delivered_at
    FROM shipments s LEFT JOIN carriers c ON c.code = s.carrier
    WHERE s.user_id = ${userId} ORDER BY s.created_at DESC`;
  return rows.map(({ trackingUrlTemplate, ...r }) => ({ ...r, statusLabel: STATUS_LABEL[r.status], trackingUrl: trackingUrl(trackingUrlTemplate, r.trackingNo) }));
}
