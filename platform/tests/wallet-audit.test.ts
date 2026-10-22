import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../src/server/db';
import { postLedger, reconcileWallets } from '../src/server/modules/wallet/wallet';
import { appendAudit, verifyAuditChain } from '../src/server/modules/audit/audit';
import { createRefundRequest } from '../src/server/modules/wallet/refunds';
import { approve, decideRefundRequest, reject } from '../src/server/modules/admin/approvals';
import { expectAppError, makeUser, setupTestDb, walletOf } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
before(async () => {
  env = await setupTestDb();
});
after(async () => {
  await env.teardown();
});

/** 測試用：以超級使用者暫時停用 trigger，模擬「有人直接改資料庫」。 */
async function tamper(fn: (sql: ReturnType<typeof db>) => Promise<unknown>) {
  await db().begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await fn(tx as unknown as ReturnType<typeof db>);
  });
}

describe('wallet ledger', () => {
  it('coins and points are separate; balance_after chain; never negative', async () => {
    const u = await makeUser({ coins: 500, points: 30 });
    assert.deepEqual(await walletOf(u.id), { coins: 500, points: 30 });
    await transaction((tx) => postLedger(tx, { userId: u.id, currency: 'POINTS', amount: -30, entryType: 'ADMIN_ADJUST', refType: 't', refId: '1' }));
    await expectAppError(transaction((tx) => postLedger(tx, { userId: u.id, currency: 'COINS', amount: -501, entryType: 'ADMIN_ADJUST', refType: 't', refId: '2' })), 'INSUFFICIENT_FUNDS');
    assert.deepEqual(await walletOf(u.id), { coins: 500, points: 0 });
    const r = (await reconcileWallets(db(), u.id))[0]!;
    assert.equal(r.ok, true);
    assert.deepEqual(r.coins, { cached: 500, ledgerSum: 500, lastBalanceAfter: 500 });
  });

  it('points can never be bought or refunded as cash (DB constraint)', async () => {
    const u = await makeUser();
    for (const t of ['TOPUP', 'REFUND_DEBIT', 'DRAW_DEBIT']) {
      await assert.rejects(
        transaction((tx) => postLedger(tx, { userId: u.id, currency: 'POINTS', amount: t === 'TOPUP' ? 10 : -10, entryType: t as 'TOPUP', refType: 't', refId: t })),
        /ledger_currency_rules|INSUFFICIENT|點數不足/,
      );
    }
    await assert.rejects(transaction((tx) => postLedger(tx, { userId: u.id, currency: 'POINTS', amount: 10, entryType: 'TOPUP', refType: 't', refId: 'x' })), /ledger_currency_rules/);
  });

  it('ledger is append-only (UPDATE/DELETE/TRUNCATE blocked)', async () => {
    const u = await makeUser({ coins: 100 });
    await assert.rejects(db()`UPDATE wallet_ledger SET amount = 999999 WHERE user_id = ${u.id}`, /append-only/);
    await assert.rejects(db()`DELETE FROM wallet_ledger WHERE user_id = ${u.id}`, /append-only/);
    await assert.rejects(db()`TRUNCATE wallet_ledger CASCADE`, /append-only/);
  });

  it('reconciliation detects a tampered cached balance and a tampered ledger row', async () => {
    const u = await makeUser({ coins: 100 });
    await db()`UPDATE wallets SET coins = coins + 1 WHERE user_id = ${u.id}`;
    let r = (await reconcileWallets(db(), u.id))[0]!;
    assert.equal(r.ok, false);
    await db()`UPDATE wallets SET coins = coins - 1 WHERE user_id = ${u.id}`;
    assert.equal((await reconcileWallets(db(), u.id))[0]!.ok, true);
    await tamper((t) => t`UPDATE wallet_ledger SET amount = amount + 5 WHERE user_id = ${u.id}`);
    r = (await reconcileWallets(db(), u.id))[0]!;
    assert.equal(r.ok, false);
    assert.ok(r.brokenChainEntries > 0 || r.coins.ledgerSum !== r.coins.cached);
  });
});

describe('refund requests (workflow, two-person approval)', () => {
  it('creates a record only; approval by a second FINANCE user debits coins once', async () => {
    const u = await makeUser({ coins: 1000 });
    const f1 = await makeUser({ roles: ['FINANCE'] });
    const f2 = await makeUser({ roles: ['FINANCE'] });
    const req = await createRefundRequest(u.id, 600, '不想玩了');
    assert.equal(req.status, 'REQUESTED');
    assert.equal((await walletOf(u.id)).coins, 1000, 'not automatic');
    await expectAppError(createRefundRequest(u.id, 500, 'again'), 'INSUFFICIENT_FUNDS'); // 600 + 500 > 1000
    const d = await decideRefundRequest(f1.principal, req.id, 'APPROVE');
    assert.equal(d.status, 'PENDING_APPROVAL');
    await expectAppError(approve(f1.principal, d.approvalId!), 'SELF_APPROVAL');
    const a = await approve(f2.principal, d.approvalId!);
    assert.equal(a.status, 'APPROVED');
    assert.equal((await walletOf(u.id)).coins, 400);
    await expectAppError(approve(f2.principal, d.approvalId!), 'INVALID_STATE');
    assert.equal((await walletOf(u.id)).coins, 400);
    const [rr] = await db()`SELECT status FROM refund_requests WHERE id = ${req.id}`;
    assert.equal(rr!.status, 'APPROVED');
  });

  it('rejected approval returns the refund to REQUESTED; CS can reject directly', async () => {
    const u = await makeUser({ coins: 300 });
    const f1 = await makeUser({ roles: ['FINANCE'] });
    const f2 = await makeUser({ roles: ['FINANCE'] });
    const cs = await makeUser({ roles: ['CS'] });
    const req = await createRefundRequest(u.id, 100, '');
    const d = await decideRefundRequest(f1.principal, req.id, 'APPROVE');
    await reject(f2.principal, d.approvalId!, 'need bank info');
    const [rr] = await db()`SELECT status FROM refund_requests WHERE id = ${req.id}`;
    assert.equal(rr!.status, 'REQUESTED');
    const r2 = await decideRefundRequest(cs.principal, req.id, 'REJECT');
    assert.equal(r2.status, 'REJECTED');
    assert.equal((await walletOf(u.id)).coins, 300);
  });
});

describe('audit hash chain', () => {
  it('verifies; detects altered payload, deleted row, and truncated tail', async () => {
    for (let i = 0; i < 5; i++) {
      await transaction((tx) => appendAudit(tx, { actorType: 'SYSTEM', action: 'TEST', entityType: 'x', entityId: String(i), payload: { i, note: '中文 ok' } }));
    }
    const ok = await verifyAuditChain(db());
    assert.equal(ok.ok, true);
    const total = ok.count;
    assert.ok(total >= 5);
    await assert.rejects(db()`UPDATE audit_log SET action = 'X' WHERE seq = 1`, /append-only/);
    await assert.rejects(db()`DELETE FROM audit_log WHERE seq = 1`, /append-only/);

    const target = total - 2;
    const [orig] = await db()`SELECT payload_json FROM audit_log WHERE seq = ${target}`;
    await tamper((t) => t`UPDATE audit_log SET payload_json = '{"i":999}' WHERE seq = ${target}`);
    let v = await verifyAuditChain(db());
    assert.deepEqual(v.ok ? null : [v.brokenAtSeq, v.reason], [target, 'hash mismatch (row content altered)']);
    await tamper((t) => t`UPDATE audit_log SET payload_json = ${orig!.payloadJson} WHERE seq = ${target}`);
    assert.equal((await verifyAuditChain(db())).ok, true);

    await tamper((t) => t`DELETE FROM audit_log WHERE seq = ${target}`);
    v = await verifyAuditChain(db());
    assert.equal(v.ok, false);
    assert.equal(v.ok ? 0 : v.brokenAtSeq, target);
  });

  it('detects tail truncation via the head pointer', async () => {
    const [h] = await db()`SELECT last_seq FROM audit_head`;
    await tamper((t) => t`DELETE FROM audit_log WHERE seq = ${h!.lastSeq}`);
    const v = await verifyAuditChain(db());
    assert.equal(v.ok, false);
  });
});
