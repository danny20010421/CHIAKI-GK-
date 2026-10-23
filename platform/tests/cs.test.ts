/** 客服工單：建單自動連結、狀態流程、SLA/逾期看板、罐頭回覆、內部備註、一鍵動作（重新出貨、延長寄存、核准退款、補償點數＋雙人覆核） */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/server/db';
import { executeDraw } from '../src/server/modules/draw/draw';
import { listWarehouse } from '../src/server/modules/warehouse/warehouse';
import { requestShipment } from '../src/server/modules/shipping/shipping';
import { advanceShipment } from '../src/server/modules/shipping/fulfilment';
import { createRefundRequest } from '../src/server/modules/wallet/refunds';
import { createBankTransferOrder } from '../src/server/modules/payment/payments';
import { approve } from '../src/server/modules/admin/approvals';
import { verifyAuditChain } from '../src/server/modules/audit/audit';
import { GET as myTickets, POST as createRoute } from '../src/app/api/me/cs-tickets/route';
import { GET as myTicket } from '../src/app/api/me/cs-tickets/[id]/route';
import { POST as userReplyRoute } from '../src/app/api/me/cs-tickets/[id]/messages/route';
import { GET as listRoute } from '../src/app/api/admin/cs/tickets/route';
import { GET as getRoute, PATCH as patchRoute } from '../src/app/api/admin/cs/tickets/[id]/route';
import { POST as replyRoute } from '../src/app/api/admin/cs/tickets/[id]/messages/route';
import { POST as actionRoute } from '../src/app/api/admin/cs/tickets/[id]/actions/route';
import { GET as dashboardRoute } from '../src/app/api/admin/cs/dashboard/route';
import { GET as cannedRoute } from '../src/app/api/admin/cs/canned-replies/route';
import { apiRequest, ctx, expectAppError, makeUser, publishPool, setupTestDb, smallPool, walletOf, type TestUser } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
before(async () => {
  env = await setupTestDb({ CS_COMPENSATION_APPROVAL_THRESHOLD: '500' });
});
after(async () => {
  await env.teardown();
});

const none = undefined as never;
const j = async <T = Record<string, unknown>>(r: Response) => ({ status: r.status, body: (await r.json()) as T });
let k = 0;

async function memberWithHistory(): Promise<{ u: TestUser; drawId: string; shipmentId: string; orderId: string }> {
  const poolId = await publishPool(smallPool({ setCount: 1 }));
  const u = await makeUser({ coins: 5000 });
  const d = (await executeDraw(u.id, `cs-${process.pid}-${++k}`, { poolId, setNo: 1, ticketNos: [1, 2, 3], shippingMethod: 'CVS_711_C2C' })).response;
  const items = await listWarehouse(db(), u.id, 'STORED');
  const s = await requestShipment(u.id, { itemIds: [items.find((i) => !i.bulky)!.id], method: 'CVS_711_C2C', recipientName: 'A', recipientPhone: '0912345678', cvsStoreId: '1234' });
  const o = await createBankTransferOrder(u.id, { packageCode: 'P500' });
  return { u, drawId: d.drawId, shipmentId: s.shipmentId, orderId: o.orderId };
}

describe('CS tickets', () => {
  it('member creates a ticket (auto-linked), staff replies with canned text, internal notes stay internal, statuses flow, SLA dashboard', async () => {
    const { u, drawId, shipmentId, orderId } = await memberWithHistory();
    const cs = await makeUser({ roles: ['CS'] });
    const member2 = await makeUser();
    const created = await j<{ ticketId: string; ticketNo: number; status: string; statusLabel: string; slaDueAt: string; linked: Record<string, string> }>(
      await createRoute(apiRequest('POST', '/api/me/cs-tickets', { token: u.token, body: { category: 'DRAW_DISPUTE', subject: '抽到的賞與籤號不符？', body: '第 2 號籤的結果想確認' } }), none),
    );
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.linked, { drawId, paymentOrderId: orderId, shipmentId });
    assert.equal(created.body.statusLabel, '待處理');
    const slaH = (new Date(created.body.slaDueAt).getTime() - Date.now()) / 3600_000;
    assert.ok(slaH > 23.9 && slaH <= 24, '抽賞爭議 SLA 24 小時');
    const id = created.body.ticketId;
    assert.equal((await createRoute(apiRequest('POST', '/api/me/cs-tickets', { token: member2.token, body: { category: 'SHIPPING', subject: 'x', body: 'y', drawId } }), none)).status, 404, 'cannot link someone else’s draw');
    assert.equal((await createRoute(apiRequest('POST', '/api/me/cs-tickets', { token: u.token, body: { category: 'NOPE', subject: 'x', body: 'y' } }), none)).status, 400);

    assert.equal((await listRoute(apiRequest('GET', '/api/admin/cs/tickets', { token: member2.token }), none)).status, 403);
    const canned = await j<{ replies: { code: string }[] }>(await cannedRoute(apiRequest('GET', '/api/admin/cs/canned-replies?category=DRAW_DISPUTE', { token: cs.token }), none));
    assert.ok(canned.body.replies.some((r) => r.code === 'DRAW_VERIFY') && !canned.body.replies.some((r) => r.code === 'SHIPPING_TRACKING'));
    const note = await replyRoute(apiRequest('POST', `/api/admin/cs/tickets/${id}/messages`, { token: cs.token, body: { body: '疑似重複詢問，先查 draw log', internal: true } }), ctx({ id }));
    assert.equal(((await note.json()) as { status: string }).status, 'OPEN', 'internal note does not change status');
    const rep = await j<{ status: string; statusLabel: string }>(await replyRoute(apiRequest('POST', `/api/admin/cs/tickets/${id}/messages`, { token: cs.token, body: { cannedCode: 'DRAW_VERIFY', body: '另附抽賞時間 10:00' } }), ctx({ id })));
    assert.deepEqual([rep.body.status, rep.body.statusLabel], ['WAITING_USER', '待用戶回覆']);
    const [n] = await db()`SELECT title FROM notifications WHERE user_id = ${u.id} AND type = 'TICKET_REPLY'`;
    assert.equal(n!.title, '客服已回覆您的問題');

    const view = await j<{ messages: { authorType: string; body: string }[]; statusLabel: string }>(await myTicket(apiRequest('GET', `/api/me/cs-tickets/${id}`, { token: u.token }), ctx({ id })));
    assert.equal(view.body.messages.length, 2, 'internal note hidden from the member');
    assert.match(view.body.messages[1]!.body, /雜湊承諾[\s\S]*另附抽賞時間/);
    assert.equal((await myTicket(apiRequest('GET', `/api/me/cs-tickets/${id}`, { token: member2.token }), ctx({ id }))).status, 404);
    const ur = await j<{ status: string }>(await userReplyRoute(apiRequest('POST', `/api/me/cs-tickets/${id}/messages`, { token: u.token, body: { body: '好的謝謝' } }), ctx({ id })));
    assert.equal(ur.body.status, 'IN_PROGRESS');
    const full = await j<{ messages: unknown[]; member: { phone: string }; linked: { draw: { id: string } } }>(await getRoute(apiRequest('GET', `/api/admin/cs/tickets/${id}`, { token: cs.token }), ctx({ id })));
    assert.equal(full.body.messages.length, 4);
    assert.equal(full.body.linked.draw.id, drawId);

    assert.equal((await patchRoute(apiRequest('PATCH', `/api/admin/cs/tickets/${id}`, { token: cs.token, body: { assigneeId: u.id } }), ctx({ id }))).status, 400, 'assignee must be staff');
    assert.equal((await patchRoute(apiRequest('PATCH', `/api/admin/cs/tickets/${id}`, { token: cs.token, body: { assigneeId: cs.id, status: 'CLOSED' } }), ctx({ id }))).status, 200);
    assert.equal((await patchRoute(apiRequest('PATCH', `/api/admin/cs/tickets/${id}`, { token: cs.token, body: { status: 'WAITING_USER' } }), ctx({ id }))).status, 409);
    assert.equal((await userReplyRoute(apiRequest('POST', `/api/me/cs-tickets/${id}/messages`, { token: u.token, body: { body: '再問一次' } }), ctx({ id }))).status, 409);
    const mine = await j<{ tickets: { statusLabel: string; closedAt: string | null }[] }>(await myTickets(apiRequest('GET', '/api/me/cs-tickets', { token: u.token }), none));
    assert.equal(mine.body.tickets[0]!.statusLabel, '已結案');

    // 逾期看板
    const t2 = await j<{ ticketId: string }>(await createRoute(apiRequest('POST', '/api/me/cs-tickets', { token: u.token, body: { category: 'SHIPPING', subject: '還沒收到', body: '請協助' } }), none));
    await db()`UPDATE cs_tickets SET sla_due_at = now() - interval '1 hour' WHERE id = ${t2.body.ticketId}`;
    const dash = await j<{ byStatus: { status: string; label: string; count: number }[]; overdue: number; unassigned: number; byCategory: { category: string; overdue: number }[] }>(await dashboardRoute(apiRequest('GET', '/api/admin/cs/dashboard', { token: cs.token }), none));
    assert.equal(dash.body.overdue, 1);
    assert.equal(dash.body.byCategory.find((c) => c.category === 'SHIPPING')!.overdue, 1);
    assert.deepEqual(dash.body.byStatus.map((s) => s.label), ['待處理', '處理中', '待用戶回覆', '已結案']);
    const overdue = await j<{ tickets: { id: string; overdue: boolean }[] }>(await listRoute(apiRequest('GET', '/api/admin/cs/tickets?overdue=1', { token: cs.token }), none));
    assert.deepEqual(overdue.body.tickets.map((t) => [t.id, t.overdue]), [[t2.body.ticketId, true]]);
  });

  it('one-click actions call domain functions with audit; compensation over threshold needs a second person', async () => {
    const { u, shipmentId } = await memberWithHistory();
    const cs = await makeUser({ roles: ['CS'] });
    const ops = await makeUser({ roles: ['OPS'] });
    const fin = await makeUser({ roles: ['FINANCE'] });
    const t = await j<{ ticketId: string }>(await createRoute(apiRequest('POST', '/api/me/cs-tickets', { token: u.token, body: { category: 'SHIPPING', subject: '包裹退回', body: '可以重寄嗎' } }), none));
    const id = t.body.ticketId;
    const act = (body: Record<string, unknown>, token = cs.token) => actionRoute(apiRequest('POST', `/api/admin/cs/tickets/${id}/actions`, { token, body }), ctx({ id }));

    // 延長寄存
    const before = (await listWarehouse(db(), u.id, 'STORED'))[0]!;
    const ext = await j<{ result: { days: number; items: unknown[] } }>(await act({ action: 'EXTEND_STORAGE', days: 10 }));
    assert.equal(ext.status, 201);
    const afterItem = (await listWarehouse(db(), u.id, 'STORED')).find((i) => i.id === before.id)!;
    assert.equal(afterItem.storageExpiresAt.getTime() - before.storageExpiresAt.getTime(), 10 * 86_400_000);

    // 重新出貨（需先退件）
    assert.equal((await act({ action: 'RESEND_SHIPMENT' })).status, 409);
    for (const to of ['PICKING', 'PACKING'] as const) await advanceShipment(ops.principal, shipmentId, { to });
    await advanceShipment(ops.principal, shipmentId, { to: 'SHIPPED', carrier: 'SEVEN_C2C', trackingNo: 'F0000111' });
    await advanceShipment(ops.principal, shipmentId, { to: 'RETURNED' });
    assert.equal((await act({ action: 'RESEND_SHIPMENT' })).status, 201);
    const [s] = await db()`SELECT status, attempt FROM shipments WHERE id = ${shipmentId}`;
    assert.deepEqual(s, { status: 'PICKING', attempt: 2 });

    // 核准退款（代幣退款 → 進雙人覆核；運費現金退款 CS 無權限）
    const rr = await createRefundRequest(u.id, 100, '不想玩了');
    const ap = await j<{ approvalId: string; result: { status: string } }>(await act({ action: 'APPROVE_REFUND', kind: 'COIN_REFUND', refundId: rr.id }));
    assert.deepEqual([ap.status, ap.body.result.status], [201, 'PENDING_APPROVAL']);
    assert.ok(ap.body.approvalId);
    assert.equal((await act({ action: 'APPROVE_REFUND', kind: 'SHIPPING_CASH_REFUND', refundId: rr.id })).status, 400, 'shipping fees are refunded as coins only; no NT$ shipping refunds');

    // 補償點數：門檻內直接入帳；超過門檻 → 第二人核准
    const p0 = (await walletOf(u.id)).points;
    const small = await j<{ result: { status: string } }>(await act({ action: 'GRANT_COMPENSATION', points: 100, memo: '出貨延誤補償' }));
    assert.equal(small.body.result.status, 'GRANTED');
    assert.equal((await walletOf(u.id)).points, p0 + 100);
    assert.equal((await act({ action: 'GRANT_COMPENSATION', points: 100, memo: '補償測試' }, ops.token)).status, 403, 'OPS lacks cs.compensation.grant');
    const big = await j<{ approvalId: string; result: { status: string } }>(await act({ action: 'GRANT_COMPENSATION', points: 800, memo: '大獎破損補償' }));
    assert.equal(big.body.result.status, 'PENDING_APPROVAL');
    assert.equal((await walletOf(u.id)).points, p0 + 100, 'not credited before approval');
    await expectAppError(approve(cs.principal, big.body.approvalId), 'SELF_APPROVAL');
    await expectAppError(approve(ops.principal, big.body.approvalId), 'FORBIDDEN');
    await approve(fin.principal, big.body.approvalId);
    assert.equal((await walletOf(u.id)).points, p0 + 900);
    const led = await db()`SELECT amount, entry_type, currency FROM wallet_ledger WHERE user_id = ${u.id} AND entry_type = 'CS_COMPENSATION' ORDER BY id`;
    assert.deepEqual(led.map((l) => [l.amount, l.currency]), [[100, 'POINTS'], [800, 'POINTS']]);

    const actions = await db()`SELECT action FROM cs_actions WHERE ticket_id = ${id} ORDER BY id`;
    assert.deepEqual(actions.map((a) => a.action), ['EXTEND_STORAGE', 'RESEND_SHIPMENT', 'APPROVE_REFUND', 'GRANT_COMPENSATION', 'GRANT_COMPENSATION']);
    const audit = await db()`SELECT action FROM audit_log WHERE action LIKE 'CS_ACTION_%' OR action IN ('STORAGE_EXTENDED', 'CS_COMPENSATION_GRANTED') ORDER BY seq`;
    assert.ok(audit.length >= 7);
    const internal = await db()`SELECT count(*)::int AS n FROM cs_messages WHERE ticket_id = ${id} AND internal`;
    assert.ok((internal[0]!.n as number) >= 6, 'each action leaves an internal note (and the approval adds one)');
    const [tk] = await db()`SELECT status FROM cs_tickets WHERE id = ${id}`;
    assert.equal(tk!.status, 'IN_PROGRESS', 'taking an action moves 待處理 → 處理中');
    assert.equal((await verifyAuditChain(db())).ok, true);
  });
});
