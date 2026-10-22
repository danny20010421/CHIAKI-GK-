import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/server/db';
import { hasPermission, PERMISSIONS, ROLES } from '../src/server/modules/auth/rbac';
import { approve, listApprovals, reject, requestBalanceAdjust, requestBankTransferConfirm, requestPoolPublish } from '../src/server/modules/admin/approvals';
import { createPoolDraft } from '../src/server/modules/pool/admin';
import { createBankTransferOrder } from '../src/server/modules/payment/payments';
import { POST as adjustRoute } from '../src/app/api/admin/wallet-adjustments/route';
import { POST as approveRoute } from '../src/app/api/admin/approvals/[id]/approve/route';
import { GET as approvalsRoute } from '../src/app/api/admin/approvals/route';
import { apiRequest, ctx, expectAppError, makeUser, setupTestDb, smallPool, walletOf } from './helpers';

describe('RBAC matrix (pure)', () => {
  it('roles map to expected permissions; MERCHANT reserved with none; MEMBER none', () => {
    assert.ok(PERMISSIONS.every((p) => hasPermission(['SUPER_ADMIN'], p)));
    assert.ok(PERMISSIONS.every((p) => !hasPermission(['MEMBER'], p)));
    assert.ok(PERMISSIONS.every((p) => !hasPermission(['MERCHANT'], p)));
    assert.ok(hasPermission(['OPS'], 'pool.publish.approve'));
    assert.ok(!hasPermission(['OPS'], 'wallet.adjust.approve'));
    assert.ok(hasPermission(['FINANCE'], 'wallet.adjust.approve'));
    assert.ok(!hasPermission(['FINANCE'], 'pool.publish.request'));
    assert.ok(hasPermission(['CS'], 'refund.decide') && !hasPermission(['CS'], 'refund.approve'));
    assert.equal(ROLES.length, 6);
  });
});

describe('two-person rule (DB)', () => {
  let env: Awaited<ReturnType<typeof setupTestDb>>;
  before(async () => {
    env = await setupTestDb();
  });
  after(async () => {
    await env.teardown();
  });

  it('manual balance adjust: requester cannot approve; approver needs permission; executes ledger exactly once', async () => {
    const u = await makeUser({ coins: 100 });
    const f1 = await makeUser({ roles: ['FINANCE'] });
    const f2 = await makeUser({ roles: ['FINANCE'] });
    const ops = await makeUser({ roles: ['OPS'] });
    const member = await makeUser();

    const forbidden = await adjustRoute(apiRequest('POST', '/api/admin/wallet-adjustments', { token: member.token, body: { userId: u.id, currency: 'COINS', amount: 50, memo: 'compensation' } }), undefined as never);
    assert.equal(forbidden.status, 403);
    const res = await adjustRoute(apiRequest('POST', '/api/admin/wallet-adjustments', { token: f1.token, body: { userId: u.id, currency: 'COINS', amount: 50, memo: '客服補償 #123' } }), undefined as never);
    assert.equal(res.status, 201);
    const { approvalId } = (await res.json()) as { approvalId: string };
    assert.equal((await walletOf(u.id)).coins, 100, 'nothing happens before approval');

    const self = await approveRoute(apiRequest('POST', `/api/admin/approvals/${approvalId}/approve`, { token: f1.token }), ctx({ id: approvalId }));
    assert.equal(self.status, 403);
    assert.equal(((await self.json()) as { error: { code: string } }).error.code, 'SELF_APPROVAL');
    await expectAppError(approve(ops.principal, approvalId), 'FORBIDDEN');
    const listed = await approvalsRoute(apiRequest('GET', '/api/admin/approvals?status=PENDING', { token: f2.token }), undefined as never);
    assert.ok(((await listed.json()) as { approvals: { id: string }[] }).approvals.some((a) => a.id === approvalId));

    const [ok1, ok2] = await Promise.allSettled([approve(f2.principal, approvalId), approve(f2.principal, approvalId)]);
    assert.equal([ok1, ok2].filter((r) => r.status === 'fulfilled').length, 1, 'concurrent double-approve executes once');
    assert.equal((await walletOf(u.id)).coins, 150);
    const led = await db()`SELECT amount, created_by FROM wallet_ledger WHERE user_id = ${u.id} AND entry_type = 'ADMIN_ADJUST' AND ref_type = 'approval_request'`;
    assert.deepEqual([...led], [{ amount: 50, createdBy: f2.id }]);
  });

  it('DB constraint forbids decided_by = requested_by even if app checks are bypassed', async () => {
    const f1 = await makeUser({ roles: ['FINANCE'] });
    const u = await makeUser();
    const { approvalId } = await requestBalanceAdjust(f1.principal, { userId: u.id, currency: 'POINTS', amount: 10, memo: 'test' });
    await assert.rejects(db()`UPDATE approval_requests SET status = 'APPROVED', decided_by = requested_by WHERE id = ${approvalId}`, /approval_two_person/);
  });

  it('failed execution leaves the request PENDING (atomic approve+execute)', async () => {
    const u = await makeUser({ coins: 10 });
    const f1 = await makeUser({ roles: ['FINANCE'] });
    const f2 = await makeUser({ roles: ['FINANCE'] });
    const { approvalId } = await requestBalanceAdjust(f1.principal, { userId: u.id, currency: 'COINS', amount: -50, memo: 'claw back' });
    await expectAppError(approve(f2.principal, approvalId), 'INSUFFICIENT_FUNDS');
    const [a] = await db()`SELECT status FROM approval_requests WHERE id = ${approvalId}`;
    assert.equal(a!.status, 'PENDING');
    await reject(f2.principal, approvalId, 'insufficient');
    const all = await listApprovals(f2.principal, 'REJECTED');
    assert.ok(all.some((x) => x.id === approvalId));
  });

  it('rejecting a publish request returns the pool to DRAFT; only one pending request per target', async () => {
    const ops = await makeUser({ roles: ['OPS'] });
    const ops2 = await makeUser({ roles: ['OPS'] });
    const { poolId } = await createPoolDraft(ops.principal, smallPool());
    const { approvalId } = await requestPoolPublish(ops.principal, poolId);
    await expectAppError(requestPoolPublish(ops2.principal, poolId), 'INVALID_STATE');
    await reject(ops2.principal, approvalId);
    const [p] = await db()`SELECT status FROM pools WHERE id = ${poolId}`;
    assert.equal(p!.status, 'DRAFT');
  });

  it('bank transfer is a manual-reconciliation order credited only after two-person confirmation', async () => {
    const u = await makeUser();
    const f1 = await makeUser({ roles: ['FINANCE'] });
    const f2 = await makeUser({ roles: ['FINANCE'] });
    const o = await createBankTransferOrder(u.id, { packageCode: 'P1000', bankLast5: '12345' });
    assert.equal(o.status, 'PENDING');
    const { approvalId } = await requestBankTransferConfirm(f1.principal, o.orderId);
    await approve(f2.principal, approvalId);
    assert.equal((await walletOf(u.id)).coins, 1000);
    await expectAppError(requestBankTransferConfirm(f1.principal, o.orderId), 'INVALID_STATE');
  });
});
