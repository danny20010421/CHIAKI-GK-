import { z } from 'zod';
import { AppError } from '../../errors';
import { db, transaction, type Db, type Tx } from '../../db';
import { appendAudit } from '../audit/audit';
import { requirePermission, type Principal } from '../auth/rbac';
import { notifyEvent } from '../notifications/outbox';
import { SHIPPING_TO_SHIP } from './methods';

/**
 * 出貨流程（資料庫 trigger 同步強制狀態轉換）：
 *   REQUESTED 申請 → PICKING 揀貨 → PACKING 包裝 → SHIPPED 已出貨 → DELIVERED 已送達
 *   SHIPPED → RETURNED 退件；REQUESTED/PICKING/PACKING/SHIPPED → EXCEPTION 異常；RETURNED/EXCEPTION → PICKING（重新出貨，attempt+1）
 * 標記「已出貨」必須填物流商與追蹤編號（資料庫 CHECK 亦強制），物流商須符合出貨方式（宅配 / 7-11 / 全家）。
 * 已出貨時通知會員（含追蹤編號與查詢網址）。
 */
export const SHIPMENT_STATUSES = ['REQUESTED', 'PICKING', 'PACKING', 'SHIPPED', 'DELIVERED', 'RETURNED', 'EXCEPTION', 'LOST', 'DAMAGED', 'CANCELLED'] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const STATUS_LABEL: Record<ShipmentStatus, string> = {
  REQUESTED: '申請',
  PICKING: '揀貨',
  PACKING: '包裝',
  SHIPPED: '已出貨',
  DELIVERED: '已送達',
  RETURNED: '退件',
  EXCEPTION: '配送異常',
  LOST: '遺失',
  DAMAGED: '破損',
  CANCELLED: '已取消',
};
/** 例外狀態：配送異常、退件、遺失、破損 */
export const EXCEPTION_STATUSES: readonly ShipmentStatus[] = ['EXCEPTION', 'RETURNED', 'LOST', 'DAMAGED'];

const NEXT: Record<ShipmentStatus, ShipmentStatus[]> = {
  REQUESTED: ['PICKING', 'EXCEPTION'],
  PICKING: ['PACKING', 'EXCEPTION'],
  PACKING: ['SHIPPED', 'EXCEPTION'],
  SHIPPED: ['DELIVERED', 'RETURNED', 'EXCEPTION', 'LOST', 'DAMAGED'],
  DELIVERED: [],
  RETURNED: ['PICKING'],
  EXCEPTION: ['PICKING'],
  LOST: ['PICKING'],
  DAMAGED: ['PICKING'],
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
  to: z.enum(['PICKING', 'PACKING', 'SHIPPED', 'DELIVERED', 'RETURNED', 'EXCEPTION', 'LOST', 'DAMAGED']),
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
    case 'LOST':
    case 'DAMAGED':
      await tx`UPDATE shipments SET status = ${v.to}, exception_at = now(), exception_note = ${v.note ?? null}, updated_at = now() WHERE id = ${s.id}`;
      break;
  }
  await tx`INSERT INTO shipment_events (shipment_id, status, kind, actor_type, actor_id, note, changes_json)
           VALUES (${s.id}, ${v.to}, 'STATUS', 'ADMIN', ${actor.userId}, ${v.note ?? null},
                   ${JSON.stringify(v.to === 'SHIPPED' ? { carrier: carrier!.code, trackingNo: v.trackingNo } : {})})`;
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
    // 先依 id 鎖定全部出貨單，再逐一推進（每筆推進會寫稽核；audit_head 必須在所有列鎖之後才取得）
    const ids = [...v.shipmentIds].sort();
    await tx`SELECT id FROM shipments WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
    const out = [];
    for (const id of ids) out.push(await advanceInTx(tx, actor, id, { to: v.to }));
    return { updated: out.length, shipments: out };
  });
}

/** 退件/異常 → 重新出貨（客服一鍵動作亦使用） */
export async function resendShipment(actor: Principal, shipmentId: string, note?: string) {
  requirePermission(actor, 'shipment.resend');
  return transaction(async (tx) => {
    const s = await lockShipment(tx, shipmentId);
    if (!EXCEPTION_STATUSES.includes(s.status)) throw new AppError('INVALID_STATE', '只有「配送異常／退件／遺失／破損」的出貨單可以重新出貨', { status: s.status });
    return advanceInTx(tx, actor, shipmentId, { to: 'PICKING', note });
  });
}

/** 揀貨單資料（批次列印）：依出貨單列出物品、收件資訊 */
export async function pickList(actor: Principal, filter: { status?: 'REQUESTED' | 'PICKING' | 'PACKING'; ids?: string[] }) {
  requirePermission(actor, 'shipment.manage');
  const d = db();
  const rows = await d<
    { shipmentId: string; status: ShipmentStatus; method: string; recipientName: string; recipientPhone: string; address: string | null; cvsStoreId: string | null; cvsStoreName: string | null; createdAt: Date; attempt: number; itemId: string; prizeName: string; levelNo: number | null; levelName: string | null; poolTitle: string | null; setNo: number | null; ticketNo: number | null }[]
  >`
    SELECT s.id AS shipment_id, s.status, s.method, s.recipient_name, s.recipient_phone, s.address, s.cvs_store_id, s.cvs_store_name, s.created_at, s.attempt,
           wi.id AS item_id, wi.prize_name, wi.level_no, wi.level_name, p.title AS pool_title, ps.set_no, wi.ticket_no
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
    s.items.push({ itemId: r.itemId, prizeName: r.prizeName, levelNo: r.levelNo, levelName: r.levelName, poolTitle: r.poolTitle, setNo: r.setNo, ticketNo: r.ticketNo });
  }
  const shipments = [...map.values()];
  return { generatedAt: new Date().toISOString(), shipmentCount: shipments.length, itemCount: rows.length, shipments };
}

/** 會員：我的出貨單（含狀態中文、物流商、追蹤編號與查詢網址） */
export async function listMemberShipments(d: Db, userId: string) {
  const rows = await d<
    { id: string; method: string; status: ShipmentStatus; feeCoins: number; freightCollect: boolean; requestId: string | null; itemCount: number; carrier: string | null; carrierLabel: string | null; trackingUrlTemplate: string | null; trackingNo: string | null; createdAt: Date; shippedAt: Date | null; deliveredAt: Date | null }[]
  >`
    SELECT s.id, s.method, s.status, s.fee_coins, s.freight_collect, s.request_id, s.item_count, s.carrier, c.label AS carrier_label, c.tracking_url_template,
           s.tracking_no, s.created_at, s.shipped_at, s.delivered_at
    FROM shipments s LEFT JOIN carriers c ON c.code = s.carrier
    WHERE s.user_id = ${userId} ORDER BY s.created_at DESC`;
  return rows.map(({ trackingUrlTemplate, ...r }) => ({
    ...r,
    shipMethod: SHIPPING_TO_SHIP[r.method as keyof typeof SHIPPING_TO_SHIP] ?? null,
    statusLabel: STATUS_LABEL[r.status],
    trackingUrl: trackingUrl(trackingUrlTemplate, r.trackingNo),
  }));
}

// ───────────── 出貨更正（後台） ─────────────

const FLOW_RANK: Partial<Record<ShipmentStatus, number>> = { REQUESTED: 0, PICKING: 1, PACKING: 2, SHIPPED: 3, DELIVERED: 4 };

export const CorrectionSchema = z
  .object({
    method: z.enum(['HOME_DELIVERY', 'CVS_711_C2C', 'CVS_FAMI_C2C']).optional(),
    carrier: z.string().regex(/^[A-Z0-9_]{2,20}$/).nullable().optional(),
    trackingNo: z.string().regex(/^[A-Za-z0-9-]{4,40}$/, '追蹤編號格式不正確').nullable().optional(),
    recipientName: z.string().trim().min(1).max(50).optional(),
    recipientPhone: z.string().regex(/^09\d{8}$/, '請填寫台灣手機號碼 09xxxxxxxx').optional(),
    address: z.string().trim().min(5).max(200).optional(),
    cvsStoreId: z.string().trim().min(3).max(20).optional(),
    cvsStoreName: z.string().trim().max(50).nullable().optional(),
    status: z.enum(['REQUESTED', 'PICKING', 'PACKING', 'SHIPPED', 'DELIVERED', 'RETURNED', 'EXCEPTION', 'LOST', 'DAMAGED']).optional(),
    /** 回退狀態、改為例外狀態、修改既有追蹤編號或改出貨方式時必填（會顯示給會員） */
    reason: z.string().trim().min(1).max(500).optional(),
    /** 是否通知會員（站內＋會員偏好的管道） */
    notifyMember: z.boolean().default(false),
  })
  .refine((v) => Object.entries(v).some(([k, x]) => k !== 'reason' && k !== 'notifyMember' && x !== undefined), 'nothing to update');

interface FullShipment {
  id: string;
  userId: string;
  merchantId: string;
  method: string;
  status: ShipmentStatus;
  carrier: string | null;
  trackingNo: string | null;
  recipientName: string;
  recipientPhone: string;
  address: string | null;
  cvsStoreId: string | null;
  cvsStoreName: string | null;
}

/**
 * 後台更正出貨單：出貨方式（含大件不可改超商）、物流商、追蹤編號、收件人、狀態（可回退、可改為 配送異常/退件/遺失/破損）。
 * 需要原因：狀態回退、改為例外狀態、從例外狀態改回、修改既有追蹤編號、改出貨方式。
 * 每次更正都寫入出貨事件紀錄（會員可見）與稽核鏈；可選擇通知會員。運費一律到付，更正不涉及任何 CC幣。
 */
export async function correctShipment(actor: Principal, shipmentId: string, input: z.input<typeof CorrectionSchema>) {
  requirePermission(actor, 'shipment.manage');
  const v = CorrectionSchema.parse(input);
  return transaction(async (tx) => {
    const [cur] = await tx<FullShipment[]>`
      SELECT id, user_id, merchant_id, method, status, carrier, tracking_no, recipient_name, recipient_phone, address, cvs_store_id, cvs_store_name
      FROM shipments WHERE id = ${shipmentId} FOR UPDATE`;
    if (!cur) throw new AppError('NOT_FOUND', 'shipment not found');
    if (cur.status === 'CANCELLED') throw new AppError('INVALID_STATE', '已取消的出貨單不能更正');
    const method = v.method ?? cur.method;
    const methodChanged = method !== cur.method;
    const isHome = method === 'HOME_DELIVERY';
    if (methodChanged && !isHome) {
      const bulky = await tx<{ prizeName: string }[]>`
        SELECT wi.prize_name FROM warehouse_items wi LEFT JOIN pool_prizes pp ON pp.id = wi.prize_id LEFT JOIN products pr ON pr.id = wi.product_id
        WHERE wi.shipment_id = ${cur.id} AND COALESCE(pp.bulky, pr.bulky, false) ORDER BY wi.prize_name`;
      if (bulky.length) throw new AppError('BULKY_HOME_DELIVERY_ONLY', `「${bulky.map((b) => b.prizeName).join('、')}」為大件商品（限宅配），不能改為超商取貨`);
    }
    const next = {
      method,
      status: v.status ?? cur.status,
      carrier: v.carrier === undefined ? cur.carrier : v.carrier,
      trackingNo: v.trackingNo === undefined ? cur.trackingNo : v.trackingNo,
      recipientName: v.recipientName ?? cur.recipientName,
      recipientPhone: v.recipientPhone ?? cur.recipientPhone,
      // 改出貨方式時，舊的地址/門市不適用，須重新填寫
      address: isHome ? (v.address ?? (methodChanged ? null : cur.address)) : null,
      cvsStoreId: isHome ? null : (v.cvsStoreId ?? (methodChanged ? null : cur.cvsStoreId)),
      cvsStoreName: isHome ? null : v.cvsStoreName === undefined ? (methodChanged ? null : cur.cvsStoreName) : v.cvsStoreName,
    };
    if (isHome && !next.address) throw new AppError('VALIDATION', '改為宅配需填寫地址');
    if (!isHome && !next.cvsStoreId) throw new AppError('VALIDATION', '改為超商取貨需填寫門市代號');
    // 物流商須符合出貨方式；改方式而未指定物流商時，舊物流商若不適用則清除
    let carrierLabel: string | null = null;
    if (next.carrier) {
      const [c] = await tx<Carrier[]>`SELECT code, label, category, tracking_url_template FROM carriers WHERE code = ${next.carrier} AND active`;
      if (!c) throw new AppError('VALIDATION', 'unknown carrier');
      if (c.category !== METHOD_CARRIER_CATEGORY[method]) {
        if (v.carrier === undefined && methodChanged) next.carrier = null;
        else throw new AppError('VALIDATION', `物流商「${c.label}」不適用此出貨方式`, { method });
      } else carrierLabel = c.label;
    }
    if ((next.status === 'SHIPPED' || next.status === 'DELIVERED') && (!next.carrier || !next.trackingNo)) {
      throw new AppError('VALIDATION', '已出貨/已送達的出貨單必須有物流商與追蹤編號');
    }
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => next[k] !== cur[k]);
    if (!changed.length) throw new AppError('VALIDATION', '沒有任何變更');
    const oldRank = FLOW_RANK[cur.status];
    const newRank = FLOW_RANK[next.status];
    const backwards = oldRank !== undefined && newRank !== undefined && newRank < oldRank;
    const toException = next.status !== cur.status && EXCEPTION_STATUSES.includes(next.status);
    const fromException = next.status !== cur.status && EXCEPTION_STATUSES.includes(cur.status);
    const trackingChanged = cur.trackingNo !== null && next.trackingNo !== cur.trackingNo;
    const needReason = backwards || toException || fromException || trackingChanged || methodChanged;
    if (needReason && !v.reason) {
      throw new AppError('VALIDATION', '此更正需要填寫原因（狀態回退、例外狀態、修改既有追蹤編號或出貨方式）', { backwards, toException, fromException, trackingChanged, methodChanged });
    }

    await tx`SELECT set_config('chiaki.shipment_correction', 'on', true)`;
    const st = next.status;
    await tx`
      UPDATE shipments SET
        method = ${next.method}, status = ${st}, carrier = ${next.carrier}, tracking_no = ${next.trackingNo},
        recipient_name = ${next.recipientName}, recipient_phone = ${next.recipientPhone},
        address = ${next.address}, cvs_store_id = ${next.cvsStoreId}, cvs_store_name = ${next.cvsStoreName},
        picking_at = ${st === 'PICKING' && st !== cur.status ? tx`now()` : tx`picking_at`},
        packing_at = ${st === 'PACKING' && st !== cur.status ? tx`now()` : tx`packing_at`},
        shipped_at = ${newRank !== undefined && newRank < 3 ? null : st === 'SHIPPED' && st !== cur.status ? tx`now()` : tx`shipped_at`},
        delivered_at = ${newRank !== undefined && newRank < 4 ? null : st === 'DELIVERED' && st !== cur.status ? tx`now()` : tx`delivered_at`},
        returned_at = ${st === 'RETURNED' && st !== cur.status ? tx`now()` : tx`returned_at`},
        exception_at = ${(st === 'EXCEPTION' || st === 'LOST' || st === 'DAMAGED') && st !== cur.status ? tx`now()` : tx`exception_at`},
        exception_note = ${toException ? (v.reason ?? null) : tx`exception_note`},
        updated_at = now()
      WHERE id = ${cur.id}`;
    // 倉庫物品跟著出貨單狀態（例外狀態不動物品）
    if (newRank !== undefined && newRank < 3) {
      await tx`UPDATE warehouse_items SET status = 'SHIP_REQUESTED', updated_at = now() WHERE shipment_id = ${cur.id} AND status IN ('SHIPPED', 'DELIVERED')`;
    } else if (st === 'SHIPPED') {
      await tx`UPDATE warehouse_items SET status = 'SHIPPED', updated_at = now() WHERE shipment_id = ${cur.id} AND status IN ('SHIP_REQUESTED', 'DELIVERED')`;
    } else if (st === 'DELIVERED') {
      await tx`UPDATE warehouse_items SET status = 'DELIVERED', updated_at = now() WHERE shipment_id = ${cur.id} AND status IN ('SHIP_REQUESTED', 'SHIPPED')`;
    }
    await tx`SELECT set_config('chiaki.shipment_correction', 'off', true)`;

    const changes = Object.fromEntries(changed.map((k) => [k, { before: cur[k], after: next[k] }]));
    const [ev] = await tx<{ id: number }[]>`
      INSERT INTO shipment_events (shipment_id, status, kind, actor_type, actor_id, note, changes_json)
      VALUES (${cur.id}, ${st}, 'CORRECTION', 'ADMIN', ${actor.userId}, ${v.reason ?? null}, ${JSON.stringify(changes)})
      RETURNING id`;
    if (v.notifyMember) {
      await notifyEvent(tx, {
        userId: cur.userId,
        merchantId: cur.merchantId,
        event: 'SHIPMENT_UPDATED',
        data: { shipmentId: cur.id, statusLabel: STATUS_LABEL[st], reason: v.reason ?? null, trackingNo: next.trackingNo, carrierLabel },
        payload: { shipmentId: cur.id, status: st },
        dedupeOn: { shipmentEventId: ev!.id },
      });
    }
    await appendAudit(tx, {
      actorType: 'ADMIN',
      actorId: actor.userId,
      action: 'SHIPMENT_CORRECTED',
      entityType: 'shipment',
      entityId: cur.id,
      payload: { changes, reason: v.reason ?? null, notifyMember: v.notifyMember, eventId: ev!.id },
    });
    return { shipmentId: cur.id, status: st, statusLabel: STATUS_LABEL[st], changed, events: await shipmentEvents(tx, cur.id) };
  });
}

const EVENT_KIND_LABEL: Record<string, string> = { REQUESTED: '申請出貨', STATUS: '狀態更新', CORRECTION: '資料更正' };
const FIELD_LABEL: Record<string, string> = {
  method: '出貨方式',
  status: '狀態',
  carrier: '物流商',
  trackingNo: '追蹤編號',
  recipientName: '收件人',
  recipientPhone: '收件人電話',
  address: '地址',
  cvsStoreId: '門市代號',
  cvsStoreName: '門市名稱',
};

/** 出貨事件紀錄（狀態、時間、操作者類型、備註/原因、更正的欄位） */
export async function shipmentEvents(d: Db | Tx, shipmentId: string) {
  const rows = await d<{ id: number; status: ShipmentStatus; kind: string; actorType: string; note: string | null; changesJson: string; createdAt: Date }[]>`
    SELECT id, status, kind, actor_type, note, changes_json, created_at FROM shipment_events WHERE shipment_id = ${shipmentId} ORDER BY id`;
  return rows.map((r) => {
    const changes = JSON.parse(r.changesJson) as Record<string, { before: unknown; after: unknown } | unknown>;
    return {
      id: r.id,
      status: r.status,
      statusLabel: STATUS_LABEL[r.status] ?? r.status,
      kind: r.kind,
      kindLabel: EVENT_KIND_LABEL[r.kind] ?? r.kind,
      actor: r.actorType === 'USER' ? '會員' : r.actorType === 'ADMIN' ? '客服／物流人員' : '系統',
      note: r.note,
      changedFields: r.kind === 'CORRECTION' ? Object.keys(changes).map((k) => FIELD_LABEL[k] ?? k) : [],
      at: r.createdAt,
    };
  });
}

/** 會員：自己某張出貨單的事件紀錄 */
export async function memberShipmentEvents(d: Db, userId: string, shipmentId: string) {
  const [s] = await d<{ status: ShipmentStatus }[]>`SELECT status FROM shipments WHERE id = ${shipmentId} AND user_id = ${userId}`;
  if (!s) throw new AppError('NOT_FOUND', 'shipment not found');
  return { shipmentId, status: s.status, statusLabel: STATUS_LABEL[s.status], events: await shipmentEvents(d, shipmentId) };
}
