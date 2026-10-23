import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../errors';
import { config } from '../../config';
import { canonicalJson } from '../../lib/canonical';
import { db, transaction, type Db, type Tx } from '../../db';
import { appendAudit } from '../audit/audit';
import { requirePermission, type Principal } from '../auth/rbac';
import { notifyEvent } from '../notifications/outbox';
import { CompensationSchema, createApproval, decideRefundRequest, postCompensation } from '../admin/approvals';
import { resendShipment } from '../shipping/fulfilment';
import { extendStorage } from '../warehouse/warehouse';

/**
 * 客服工單（簡單直覺）：
 *   分類：抽賞爭議 / 儲值/付款 / 出貨/物流 / 帳號 / 退款 / 其他（每類有 SLA 小時數，cs_categories）
 *   狀態：待處理 OPEN → 處理中 IN_PROGRESS → 待用戶回覆 WAITING_USER → 已結案 CLOSED
 *     - 客服公開回覆 → 自動變「待用戶回覆」並通知會員；會員回覆 → 自動回到「處理中」
 *     - 內部備註（internal）會員看不到、不改狀態
 *   建單時自動連結會員最近 30 天的抽賞 / 儲值訂單 / 出貨單（可由會員指定）。
 *   一鍵動作（皆呼叫既有 domain 函式，各自寫稽核；另記錄 cs_actions＋稽核）：
 *     重新出貨、延長寄存 N 天、核准退款申請（未使用儲值代幣的退款 → 進雙人覆核）、
 *     補償 CC幣（不可退款；超過 CS_COMPENSATION_APPROVAL_THRESHOLD 需第二人核准）。
 */
export const CATEGORIES = ['DRAW_DISPUTE', 'TOPUP_PAYMENT', 'SHIPPING', 'ACCOUNT', 'REFUND', 'OTHER'] as const;
export const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_USER', 'CLOSED'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = { OPEN: '待處理', IN_PROGRESS: '處理中', WAITING_USER: '待用戶回覆', CLOSED: '已結案' };

const STAFF_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  OPEN: ['IN_PROGRESS', 'WAITING_USER', 'CLOSED'],
  IN_PROGRESS: ['WAITING_USER', 'CLOSED'],
  WAITING_USER: ['IN_PROGRESS', 'CLOSED'],
  CLOSED: ['IN_PROGRESS'],
};

export const CreateTicketSchema = z.object({
  category: z.enum(CATEGORIES),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
  drawId: z.string().uuid().optional(),
  paymentOrderId: z.string().uuid().optional(),
  shipmentId: z.string().uuid().optional(),
});

async function ownedOrNull(tx: Tx, table: 'draws' | 'payment_orders' | 'shipments', id: string | undefined, userId: string): Promise<string | null> {
  if (!id) return null;
  const [r] = await tx`SELECT id FROM ${tx(table)} WHERE id = ${id} AND user_id = ${userId}`;
  if (!r) throw new AppError('NOT_FOUND', `${table} not found`);
  return id;
}

async function latest(tx: Tx, table: 'draws' | 'payment_orders' | 'shipments', userId: string): Promise<string | null> {
  const [r] = await tx<{ id: string }[]>`SELECT id FROM ${tx(table)} WHERE user_id = ${userId} AND created_at > now() - interval '30 days' ORDER BY created_at DESC LIMIT 1`;
  return r?.id ?? null;
}

export async function createTicket(userId: string, input: z.input<typeof CreateTicketSchema>) {
  const v = CreateTicketSchema.parse(input);
  return transaction(async (tx) => {
    const [cat] = await tx<{ slaHours: number }[]>`SELECT sla_hours FROM cs_categories WHERE code = ${v.category}`;
    const drawId = (await ownedOrNull(tx, 'draws', v.drawId, userId)) ?? (await latest(tx, 'draws', userId));
    const orderId = (await ownedOrNull(tx, 'payment_orders', v.paymentOrderId, userId)) ?? (await latest(tx, 'payment_orders', userId));
    const shipmentId = (await ownedOrNull(tx, 'shipments', v.shipmentId, userId)) ?? (await latest(tx, 'shipments', userId));
    const [t] = await tx<{ id: string; ticketNo: number; slaDueAt: Date }[]>`
      INSERT INTO cs_tickets (user_id, category, subject, sla_due_at, linked_draw_id, linked_payment_order_id, linked_shipment_id)
      VALUES (${userId}, ${v.category}, ${v.subject}, now() + make_interval(hours => ${cat!.slaHours}), ${drawId}, ${orderId}, ${shipmentId})
      RETURNING id, ticket_no, sla_due_at`;
    await tx`INSERT INTO cs_messages (ticket_id, author_type, author_id, body) VALUES (${t!.id}, 'USER', ${userId}, ${v.body})`;
    await appendAudit(tx, { actorType: 'USER', actorId: userId, action: 'CS_TICKET_CREATED', entityType: 'cs_ticket', entityId: t!.id, payload: { category: v.category, drawId, orderId, shipmentId } });
    return { ticketId: t!.id, ticketNo: t!.ticketNo, status: 'OPEN' as const, statusLabel: TICKET_STATUS_LABEL.OPEN, slaDueAt: t!.slaDueAt, linked: { drawId, paymentOrderId: orderId, shipmentId } };
  });
}

interface TicketRow {
  id: string;
  ticketNo: number;
  userId: string;
  category: string;
  categoryLabel: string;
  subject: string;
  status: TicketStatus;
  assigneeId: string | null;
  slaDueAt: Date;
  linkedDrawId: string | null;
  linkedPaymentOrderId: string | null;
  linkedShipmentId: string | null;
  firstResponseAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const TICKET_COLS = (d: Db) => d`
  t.id, t.ticket_no, t.user_id, t.category, c.label AS category_label, t.subject, t.status, t.assignee_id, t.sla_due_at,
  t.linked_draw_id, t.linked_payment_order_id, t.linked_shipment_id, t.first_response_at, t.closed_at, t.created_at, t.updated_at`;

const decorate = (t: TicketRow) => ({
  ...t,
  statusLabel: TICKET_STATUS_LABEL[t.status],
  overdue: (t.status === 'OPEN' || t.status === 'IN_PROGRESS') && t.slaDueAt.getTime() < Date.now(),
});

async function messagesOf(d: Db, ticketId: string, includeInternal: boolean) {
  return d<{ id: number; authorType: string; authorId: string | null; body: string; internal: boolean; createdAt: Date }[]>`
    SELECT id, author_type, author_id, body, internal, created_at FROM cs_messages
    WHERE ticket_id = ${ticketId} ${includeInternal ? d`` : d`AND NOT internal`} ORDER BY id`;
}

export async function listMyTickets(d: Db, userId: string) {
  const rows = await d<TicketRow[]>`SELECT ${TICKET_COLS(d)} FROM cs_tickets t JOIN cs_categories c ON c.code = t.category WHERE t.user_id = ${userId} ORDER BY t.created_at DESC LIMIT 100`;
  return rows.map(({ assigneeId: _a, ...r }) => ({ ...r, statusLabel: TICKET_STATUS_LABEL[r.status] }));
}

export async function getMyTicket(d: Db, userId: string, ticketId: string) {
  const [t] = await d<TicketRow[]>`SELECT ${TICKET_COLS(d)} FROM cs_tickets t JOIN cs_categories c ON c.code = t.category WHERE t.id = ${ticketId} AND t.user_id = ${userId}`;
  if (!t) throw new AppError('NOT_FOUND', 'ticket not found');
  const { assigneeId: _a, ...rest } = t;
  return { ...rest, statusLabel: TICKET_STATUS_LABEL[t.status], messages: (await messagesOf(d, t.id, false)).map(({ internal: _i, ...m }) => m) };
}

export const ReplySchema = z.object({ body: z.string().trim().min(1).max(5000) });

export async function userReply(userId: string, ticketId: string, input: z.input<typeof ReplySchema>) {
  const v = ReplySchema.parse(input);
  return transaction(async (tx) => {
    const [t] = await tx<{ status: TicketStatus }[]>`SELECT status FROM cs_tickets WHERE id = ${ticketId} AND user_id = ${userId} FOR UPDATE`;
    if (!t) throw new AppError('NOT_FOUND', 'ticket not found');
    if (t.status === 'CLOSED') throw new AppError('INVALID_STATE', '此工單已結案，請建立新工單');
    const next: TicketStatus = t.status === 'WAITING_USER' ? 'IN_PROGRESS' : t.status;
    await tx`INSERT INTO cs_messages (ticket_id, author_type, author_id, body) VALUES (${ticketId}, 'USER', ${userId}, ${v.body})`;
    await tx`UPDATE cs_tickets SET status = ${next}, updated_at = now() WHERE id = ${ticketId}`;
    return { ticketId, status: next, statusLabel: TICKET_STATUS_LABEL[next] };
  });
}

// ───────────── 後台 ─────────────

export const TicketFilterSchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  category: z.enum(CATEGORIES).optional(),
  assigneeId: z.string().uuid().optional(),
  overdue: z.enum(['1', 'true']).optional(),
});

export async function listTickets(actor: Principal, f: z.input<typeof TicketFilterSchema> = {}) {
  requirePermission(actor, 'cs.ticket.manage');
  const v = TicketFilterSchema.parse(f);
  const d = db();
  const rows = await d<TicketRow[]>`
    SELECT ${TICKET_COLS(d)} FROM cs_tickets t JOIN cs_categories c ON c.code = t.category
    WHERE true
      ${v.status ? d`AND t.status = ${v.status}` : d``}
      ${v.category ? d`AND t.category = ${v.category}` : d``}
      ${v.assigneeId ? d`AND t.assignee_id = ${v.assigneeId}` : d``}
      ${v.overdue ? d`AND t.status IN ('OPEN', 'IN_PROGRESS') AND t.sla_due_at < now()` : d``}
    ORDER BY (t.status = 'CLOSED'), t.sla_due_at, t.created_at LIMIT 200`;
  return rows.map(decorate);
}

export async function getTicket(actor: Principal, ticketId: string) {
  requirePermission(actor, 'cs.ticket.manage');
  const d = db();
  const [t] = await d<TicketRow[]>`SELECT ${TICKET_COLS(d)} FROM cs_tickets t JOIN cs_categories c ON c.code = t.category WHERE t.id = ${ticketId}`;
  if (!t) throw new AppError('NOT_FOUND', 'ticket not found');
  const [member] = await d<{ phone: string | null; displayName: string; createdAt: Date }[]>`SELECT phone, display_name, created_at FROM users WHERE id = ${t.userId}`;
  const [draw] = t.linkedDrawId ? await d`SELECT id, pool_id, set_id, ticket_count, amount_coins, created_at FROM draws WHERE id = ${t.linkedDrawId}` : [];
  const [order] = t.linkedPaymentOrderId ? await d`SELECT id, provider, merchant_trade_no, amount_twd, status, created_at, paid_at FROM payment_orders WHERE id = ${t.linkedPaymentOrderId}` : [];
  const [shipment] = t.linkedShipmentId ? await d`SELECT id, method, status, carrier, tracking_no, created_at FROM shipments WHERE id = ${t.linkedShipmentId}` : [];
  const actions = await d`SELECT id, action, params_json, result_json, actor_id, approval_request_id, created_at FROM cs_actions WHERE ticket_id = ${t.id} ORDER BY id`;
  return { ...decorate(t), member, linked: { draw: draw ?? null, paymentOrder: order ?? null, shipment: shipment ?? null }, messages: await messagesOf(d, t.id, true), actions };
}

export const UpdateTicketSchema = z
  .object({ status: z.enum(TICKET_STATUSES).optional(), assigneeId: z.string().uuid().nullable().optional() })
  .refine((v) => v.status !== undefined || v.assigneeId !== undefined, 'nothing to update');

export async function updateTicket(actor: Principal, ticketId: string, input: z.input<typeof UpdateTicketSchema>) {
  requirePermission(actor, 'cs.ticket.manage');
  const v = UpdateTicketSchema.parse(input);
  return transaction(async (tx) => {
    const [t] = await tx<{ status: TicketStatus }[]>`SELECT status FROM cs_tickets WHERE id = ${ticketId} FOR UPDATE`;
    if (!t) throw new AppError('NOT_FOUND', 'ticket not found');
    let status = t.status;
    if (v.status && v.status !== t.status) {
      if (!STAFF_TRANSITIONS[t.status].includes(v.status)) throw new AppError('INVALID_STATE', `工單「${TICKET_STATUS_LABEL[t.status]}」不可改為「${TICKET_STATUS_LABEL[v.status]}」`);
      status = v.status;
    }
    if (v.assigneeId) {
      const [s] = await tx`SELECT 1 FROM user_roles WHERE user_id = ${v.assigneeId} AND role IN ('SUPER_ADMIN', 'OPS', 'CS')`;
      if (!s) throw new AppError('VALIDATION', 'assignee must be a CS/OPS staff member');
    }
    await tx`
      UPDATE cs_tickets SET status = ${status}, closed_at = ${status === 'CLOSED' ? new Date() : null},
             assignee_id = ${v.assigneeId === undefined ? tx`assignee_id` : v.assigneeId}, updated_at = now()
      WHERE id = ${ticketId}`;
    await appendAudit(tx, { actorType: 'ADMIN', actorId: actor.userId, action: 'CS_TICKET_UPDATED', entityType: 'cs_ticket', entityId: ticketId, payload: { from: t.status, to: status, assigneeId: v.assigneeId ?? null } });
    return { ticketId, status, statusLabel: TICKET_STATUS_LABEL[status] };
  });
}

export const StaffReplySchema = z
  .object({ body: z.string().trim().min(1).max(5000).optional(), cannedCode: z.string().regex(/^[A-Z0-9_]{2,40}$/).optional(), internal: z.boolean().default(false) })
  .refine((v) => v.body || v.cannedCode, 'body or cannedCode required');

export async function staffReply(actor: Principal, ticketId: string, input: z.input<typeof StaffReplySchema>) {
  requirePermission(actor, 'cs.ticket.manage');
  const v = StaffReplySchema.parse(input);
  return transaction(async (tx) => {
    const [t] = await tx<{ status: TicketStatus; userId: string; ticketNo: number; subject: string }[]>`
      SELECT status, user_id, ticket_no, subject FROM cs_tickets WHERE id = ${ticketId} FOR UPDATE`;
    if (!t) throw new AppError('NOT_FOUND', 'ticket not found');
    let text = v.body ?? '';
    if (v.cannedCode) {
      const [c] = await tx<{ body: string }[]>`SELECT body FROM cs_canned_replies WHERE code = ${v.cannedCode} AND active`;
      if (!c) throw new AppError('NOT_FOUND', 'canned reply not found');
      text = v.body ? `${c.body}\n\n${v.body}` : c.body;
    }
    const [m] = await tx<{ id: number }[]>`
      INSERT INTO cs_messages (ticket_id, author_type, author_id, body, internal) VALUES (${ticketId}, 'STAFF', ${actor.userId}, ${text}, ${v.internal}) RETURNING id`;
    let status = t.status;
    if (!v.internal) {
      if (t.status === 'CLOSED') throw new AppError('INVALID_STATE', '已結案工單請先重新開啟');
      status = 'WAITING_USER';
      await tx`UPDATE cs_tickets SET status = 'WAITING_USER', first_response_at = COALESCE(first_response_at, now()), updated_at = now() WHERE id = ${ticketId}`;
      await notifyEvent(tx, {
        userId: t.userId,
        event: 'TICKET_REPLY',
        data: { ticketId, ticketNo: t.ticketNo, subject: t.subject },
        payload: { ticketId },
        dedupeOn: { ticketId, messageId: m!.id },
      });
    }
    await appendAudit(tx, { actorType: 'ADMIN', actorId: actor.userId, action: v.internal ? 'CS_INTERNAL_NOTE' : 'CS_REPLIED', entityType: 'cs_ticket', entityId: ticketId, payload: { messageId: m!.id, canned: v.cannedCode ?? null } });
    return { ticketId, messageId: m!.id, status, statusLabel: TICKET_STATUS_LABEL[status] };
  });
}

export async function listCannedReplies(actor: Principal, category?: string) {
  requirePermission(actor, 'cs.ticket.manage');
  const d = db();
  return d`SELECT code, category, title, body FROM cs_canned_replies WHERE active ${category ? d`AND (category = ${category} OR category IS NULL)` : d``} ORDER BY sort_order, code`;
}

/** 舊欄位名：GRANT_COMPENSATION 的 points 視為 coins（CC幣） */
const legacyCompensation = (x: unknown) =>
  x && typeof x === 'object' && (x as { action?: unknown }).action === 'GRANT_COMPENSATION' && !('coins' in x) && 'points' in x
    ? { ...(x as Record<string, unknown>), coins: (x as { points: unknown }).points }
    : x;

export const ActionSchema = z.preprocess(legacyCompensation, z.discriminatedUnion('action', [
  z.object({ action: z.literal('RESEND_SHIPMENT'), shipmentId: z.string().uuid().optional(), note: z.string().max(500).optional() }),
  z.object({ action: z.literal('EXTEND_STORAGE'), days: z.number().int().min(1).max(90), itemIds: z.array(z.string().uuid()).min(1).max(100).optional() }),
  z.object({ action: z.literal('APPROVE_REFUND'), kind: z.literal('COIN_REFUND').default('COIN_REFUND'), refundId: z.string().uuid(), note: z.string().max(500).optional() }),
  // 補償 CC幣（不可退款）
  z.object({ action: z.literal('GRANT_COMPENSATION'), coins: z.number().int().positive().max(1_000_000), memo: z.string().min(2).max(500) }),
]));

/** 一鍵動作：執行既有 domain 函式（各自交易＋稽核），成功後記錄於工單（cs_actions＋內部備註＋稽核）。 */
export async function runTicketAction(actor: Principal, ticketId: string, input: z.input<typeof ActionSchema>) {
  requirePermission(actor, 'cs.ticket.manage');
  const v = ActionSchema.parse(input);
  const [t] = await db()<{ userId: string; linkedShipmentId: string | null }[]>`SELECT user_id, linked_shipment_id FROM cs_tickets WHERE id = ${ticketId}`;
  if (!t) throw new AppError('NOT_FOUND', 'ticket not found');
  let result: Record<string, unknown>;
  let approvalId: string | null = null;
  let note: string;
  switch (v.action) {
    case 'RESEND_SHIPMENT': {
      const sid = v.shipmentId ?? t.linkedShipmentId;
      if (!sid) throw new AppError('VALIDATION', '此工單沒有連結出貨單');
      const [own] = await db()`SELECT 1 FROM shipments WHERE id = ${sid} AND user_id = ${t.userId}`;
      if (!own) throw new AppError('NOT_FOUND', 'shipment not found for this member');
      result = await resendShipment(actor, sid, v.note);
      note = `已安排重新出貨（出貨單 ${sid}）`;
      break;
    }
    case 'EXTEND_STORAGE':
      result = await extendStorage(actor, { userId: t.userId, days: v.days, itemIds: v.itemIds, reason: `cs_ticket:${ticketId}` });
      note = `已延長寄存 ${v.days} 天（${(result.items as unknown[]).length} 件）`;
      break;
    case 'APPROVE_REFUND': {
      // 新台幣退款只限可退款 CC幣（儲值）；回收、獎勵、補償等不可退款 CC幣不可申請
      const [own] = await db()`SELECT 1 FROM refund_requests WHERE id = ${v.refundId} AND user_id = ${t.userId}`;
      if (!own) throw new AppError('NOT_FOUND', 'refund request not found for this member');
      result = { ...(await decideRefundRequest(actor, v.refundId, 'APPROVE', v.note)) };
      approvalId = (result.approvalId as string | undefined) ?? null;
      note = '已提出代幣退款核准（待第二人覆核）';
      break;
    }
    case 'GRANT_COMPENSATION': {
      requirePermission(actor, 'cs.compensation.grant');
      const c = CompensationSchema.parse({ userId: t.userId, coins: v.coins, memo: v.memo, ticketId });
      if (v.coins > config().CS_COMPENSATION_APPROVAL_THRESHOLD) {
        const a = await transaction((tx) => createApproval(tx, actor, 'CS_COMPENSATION', randomUUID(), c));
        approvalId = a.approvalId;
        result = { status: 'PENDING_APPROVAL', approvalId };
        note = `補償 ${v.coins} CC幣超過門檻，已送第二人核准`;
      } else {
        result = await transaction(async (tx) => {
          const r = await postCompensation(tx, c, actor.userId, 'cs_ticket', ticketId);
          await appendAudit(tx, { actorType: 'ADMIN', actorId: actor.userId, action: 'CS_COMPENSATION_GRANTED', entityType: 'cs_ticket', entityId: ticketId, payload: { userId: t.userId, coins: v.coins } });
          return { status: 'GRANTED', ...r };
        });
        note = `已補償 ${v.coins} CC幣（不可退款）`;
      }
      break;
    }
  }
  await transaction(async (tx) => {
    await tx`INSERT INTO cs_actions (ticket_id, action, params_json, result_json, actor_id, approval_request_id)
             VALUES (${ticketId}, ${v.action}, ${canonicalJson(v as never)}, ${JSON.stringify(result)}, ${actor.userId}, ${approvalId})`;
    await tx`INSERT INTO cs_messages (ticket_id, author_type, author_id, body, internal) VALUES (${ticketId}, 'SYSTEM', ${actor.userId}, ${note}, true)`;
    await tx`UPDATE cs_tickets SET status = CASE WHEN status = 'OPEN' THEN 'IN_PROGRESS' ELSE status END, updated_at = now() WHERE id = ${ticketId}`;
    await appendAudit(tx, { actorType: 'ADMIN', actorId: actor.userId, action: `CS_ACTION_${v.action}`, entityType: 'cs_ticket', entityId: ticketId, payload: { params: v, approvalId } });
  });
  return { ticketId, action: v.action, result, approvalId };
}

/** 客服看板：各狀態數、逾期（待處理/處理中且超過 SLA）、即將逾期（4 小時內）、各分類未結案數、未指派數 */
export async function csDashboard(actor: Principal) {
  requirePermission(actor, 'cs.ticket.manage');
  const d = db();
  const byStatus = await d<{ status: TicketStatus; n: number }[]>`SELECT status, count(*)::int AS n FROM cs_tickets GROUP BY status`;
  const [x] = await d<{ overdue: number; dueSoon: number; unassigned: number }[]>`
    SELECT count(*) FILTER (WHERE status IN ('OPEN', 'IN_PROGRESS') AND sla_due_at < now())::int AS overdue,
           count(*) FILTER (WHERE status IN ('OPEN', 'IN_PROGRESS') AND sla_due_at >= now() AND sla_due_at < now() + interval '4 hours')::int AS due_soon,
           count(*) FILTER (WHERE status <> 'CLOSED' AND assignee_id IS NULL)::int AS unassigned
    FROM cs_tickets`;
  const byCategory = await d<{ category: string; label: string; open: number; overdue: number }[]>`
    SELECT c.code AS category, c.label,
           count(t.id) FILTER (WHERE t.status <> 'CLOSED')::int AS open,
           count(t.id) FILTER (WHERE t.status IN ('OPEN', 'IN_PROGRESS') AND t.sla_due_at < now())::int AS overdue
    FROM cs_categories c LEFT JOIN cs_tickets t ON t.category = c.code GROUP BY c.code, c.label, c.sort_order ORDER BY c.sort_order`;
  const counts = Object.fromEntries(TICKET_STATUSES.map((s) => [s, byStatus.find((b) => b.status === s)?.n ?? 0])) as Record<TicketStatus, number>;
  return {
    byStatus: TICKET_STATUSES.map((s) => ({ status: s, label: TICKET_STATUS_LABEL[s], count: counts[s] })),
    overdue: x!.overdue,
    dueSoon: x!.dueSoon,
    unassigned: x!.unassigned,
    byCategory,
  };
}
